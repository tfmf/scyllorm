import { QueryOptions } from 'cassandra-driver';
import { DataSource, PagedResult } from '../data-source/DataSource';
import { BaseModel } from '../model/BaseModel';
import { EntityNotFoundError, InvalidQueryError, QueryFailedError, UnknownColumnError } from '../errors';
import { BoundQuery, bindNamedParameters } from './named-parameters';
import { validateColumnValue } from './type-validation';
import {
    BatchStatement,
    BindableValue,
    SimpleConditionValue,
    NestedConditions,
    FindOptions,
    Page,
    RawQueryOptions,
    RawQueryParams,
    RawRow,
    WriteOptions,
} from './query-utils';

/**
 * The property-to-column map for each entity class, built once on first use.
 *
 * Keyed on the constructor rather than held on the instance because
 * `DataSource.getRepository()` allocates a fresh `Repository` on every call, and
 * weakly so that an entity class going out of scope is not pinned by the cache.
 */
const columnMaps = new WeakMap<typeof BaseModel, ReadonlyMap<string, string>>();

/**
 * An unquoted CQL identifier: a letter, then letters, digits or underscores.
 *
 * The single source of truth for what this ORM will interpolate into a query.
 * Anything else — a CQL expression, a quoted identifier, collection access — is
 * `runRawQuery()` territory.
 */
const UNQUOTED_IDENTIFIER = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/**
 * The largest value a `LIMIT` bind marker can carry.
 *
 * CQL types the marker as `int` — signed 32-bit — so the driver encodes it with
 * `writeInt32BE` and anything larger throws a `RangeError` out of the buffer
 * writer. JavaScript's safe-integer ceiling is four million times higher, so it
 * is the wrong bound to check against.
 */
const MAX_CQL_INT = 2147483647;

/**
 * Build the map from property name to the column name emitted in CQL.
 *
 * Validating here rather than per query means a malformed entity fails on its
 * first use with a message about the declaration, not about the caller's input.
 *
 * @param {typeof BaseModel} entityClass The entity class to read metadata from.
 * @returns {ReadonlyMap<string, string>} Property name to emitted column name.
 */
function buildColumnMap(entityClass: typeof BaseModel): ReadonlyMap<string, string> {
    const map = new Map<string, string>();
    const folded = new Map<string, string>();

    for (const column of entityClass.columns ?? []) {
        // Tier 3 will resolve an explicit `name` option here; today the two are the same
        const emitted = column.name;

        if (!UNQUOTED_IDENTIFIER.test(emitted)) {
            throw InvalidQueryError.invalidIdentifier(emitted, entityClass.name);
        }

        // CQL folds unquoted identifiers, so two columns differing only by case are one column
        const key = emitted.toLowerCase();
        const clash = folded.get(key);

        // entityClass.columns is name-unique (upsertByName), so any match here is a different name
        if (clash !== undefined) {
            throw InvalidQueryError.ambiguousColumn(column.name, clash, entityClass.name);
        }

        folded.set(key, column.name);
        map.set(column.name, emitted);
    }

    return map;
}

/**
 * Read a property only if the object owns it.
 *
 * Every read of a caller-supplied condition goes through here: `value.operator`
 * resolves up the prototype chain, so a single assignment to `Object.prototype`
 * would otherwise turn every plain object value into a condition of the
 * attacker's choosing.
 *
 * @param {object} target The object to read from.
 * @param {string} property The property name to read.
 * @returns {unknown} The own value, or `undefined` if the object does not own it.
 */
function ownProperty(target: object, property: string): unknown {
    return Object.prototype.hasOwnProperty.call(target, property)
        ? (target as Record<string, unknown>)[property]
        : undefined;
}

/**
 * Whether a condition value is an operator object rather than a plain value.
 *
 * @param {unknown} value The condition value supplied by the caller.
 * @returns {boolean} True if the value carries its own `operator`.
 */
function isCondition(value: unknown): value is object {
    return typeof value === 'object' && value !== null && Object.prototype.hasOwnProperty.call(value, 'operator');
}

/**
 * Accept the options bag and the positional `allowFiltering` it replaced.
 *
 * @param {RawQueryOptions | boolean} options The third argument as the caller passed it.
 * @returns {RawQueryOptions} The options bag to work from.
 */
function resolveRawOptions(options: RawQueryOptions | boolean): RawQueryOptions {
    return typeof options === 'boolean' ? { allowFiltering: options } : options;
}

/**
 * Whether a value can be bound to a `?` placeholder.
 *
 * @param {unknown} value The value to bind.
 * @returns {boolean} True if the driver can bind it as-is.
 */
function isBindable(value: unknown): value is SimpleConditionValue {
    return (
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value instanceof Buffer
    );
}

/**
 * Read the value out of a `SELECT COUNT(*)` result set.
 *
 * The driver returns the count as a `Long`, which converts through its decimal
 * string — `Number()` alone would go through `valueOf` and produce `NaN`. A
 * count beyond `Number.MAX_SAFE_INTEGER` would lose precision, which no real
 * table reaches.
 *
 * @param {RawRow[]} rows The rows of the COUNT query.
 * @returns {number} The count, or 0 if the server returned no row.
 */
function extractCount(rows: RawRow[]): number {
    const raw = rows[0]?.count;

    if (raw === null || raw === undefined) {
        return 0;
    }

    return typeof raw === 'number' ? raw : Number(String(raw));
}

/**
 * Read the `[applied]` flag out of a lightweight-transaction result set.
 *
 * Every LWT returns exactly one row carrying it; anything else — no row, a
 * missing column — reads as not applied rather than guessing that it was.
 *
 * @param {RawRow[]} rows The rows of the conditional write.
 * @returns {boolean} True if the server applied the write.
 */
function extractApplied(rows: RawRow[]): boolean {
    return rows[0]?.['[applied]'] === true;
}

export class Repository<T extends BaseModel> {
    protected entityClass: (new () => T) & typeof BaseModel;

    constructor(
        private dataSource: DataSource,
        entityClass: (new () => T) & typeof BaseModel
    ) {
        this.entityClass = entityClass;
    }

    private options = { prepare: true };

    /**
     * List the column names accepted by `where`, `orderBy` and `delete`.
     *
     * The non-throwing counterpart to the validation the query builders apply:
     * use it to filter untrusted input — a sort column from a query string, say —
     * before handing it over, rather than catching {@link UnknownColumnError}.
     * @returns {string[]} The names declared on the entity, in declaration order.
     */
    public getColumnNames(): string[] {
        return [...this.getColumnMap().keys()];
    }

    /**
     * Save the entity to the database.
     * CQL INSERT is an upsert — no SELECT round-trip needed.
     *
     * Awaits `entity.beforeSave()` before the query is built and `entity.afterSave()`
     * after it succeeds; a hook that throws aborts the operation. No hooks run for
     * `saveStatement()`, `increment()`/`decrement()`, `clear()` or the raw-query family.
     *
     * @param {T} entity - The entity to save.
     * @param {WriteOptions} [options] The write options, including `ttl` in seconds.
     * @returns {Promise<T>} The saved entity.
     * @throws {InvalidQueryError} If `ttl` is not an integer from 1 to 2147483647.
     * @throws {ColumnValidationError} If a value does not fit its column's declared type or fails its validator.
     */
    public async save(entity: T, options?: WriteOptions): Promise<T> {
        // Before the build, not just the execute: a throwing hook aborts the save
        // before any of the entity's values are read
        await entity.beforeSave?.();

        const { query, params } = this.buildInsertStatement(entity, options);
        await this.dataSource.executeQuery<null>(query, params, this.options);

        await entity.afterSave?.();

        return entity;
    }

    /**
     * Insert the entity only if no row with its primary key exists, via a
     * lightweight transaction.
     *
     * Unlike `save()`, this never overwrites: the server takes a Paxos round to
     * decide, which costs more than a plain INSERT — use it only where the
     * race matters. Runs the same `beforeSave()`/`afterSave()` hooks as `save()`.
     *
     * @param {T} entity The entity to insert.
     * @param {WriteOptions} [options] The write options, including `ttl` in seconds.
     * @returns {Promise<boolean>} True if the server applied the insert, false if the row already existed.
     * @throws {InvalidQueryError} If `ttl` is not an integer from 1 to 2147483647.
     * @throws {ColumnValidationError} If a value does not fit its column's declared type or fails its validator.
     */
    public async insertIfNotExists(entity: T, options?: WriteOptions): Promise<boolean> {
        await entity.beforeSave?.();

        const { query, params } = this.buildInsertStatement(entity, options, true);
        const rows = await this.dataSource.executeQuery<RawRow>(query, params, this.options);

        await entity.afterSave?.();

        return extractApplied(rows);
    }

    /**
     * Build the INSERT statement `save()` would run, without running it.
     *
     * Goes through the same column whitelist and validation as `save()`, but
     * runs NO lifecycle hooks — the statement is only executed when passed to
     * `DataSource.executeBatch()`.
     *
     * @param {T} entity The entity to build the INSERT for.
     * @param {WriteOptions} [options] The write options, including `ttl` in seconds.
     * @returns {BatchStatement} The CQL and the values bound to its placeholders.
     * @throws {InvalidQueryError} If `ttl` is not an integer from 1 to 2147483647.
     * @throws {ColumnValidationError} If a value does not fit its column's declared type or fails its validator.
     */
    public saveStatement(entity: T, options?: WriteOptions): BatchStatement {
        return this.buildInsertStatement(entity, options);
    }

    /**
     * Build the INSERT shared by `save()`, `saveStatement()` and `insertIfNotExists()`.
     *
     * @param {T} entity The entity to build the INSERT for.
     * @param {WriteOptions} [options] The write options, including `ttl` in seconds.
     * @param {boolean} [ifNotExists=false] Whether to append `IF NOT EXISTS`.
     * @returns {BatchStatement} The CQL and the values bound to its placeholders.
     */
    private buildInsertStatement(entity: T, options?: WriteOptions, ifNotExists: boolean = false): BatchStatement {
        // Routed through the same whitelist as every other query builder, so a
        // malformed entity fails here too instead of reaching the driver unchecked
        const columnMap = this.getColumnMap();
        const keys = [...columnMap.keys()];
        const emitted = [...columnMap.values()];
        const placeholders = keys.map(() => '?').join(', ');
        const params: BindableValue[] = keys.map((key) => {
            const value = entity[key as keyof T];

            this.assertValue(key, value);

            return value as string | number | boolean | Buffer;
        });

        let query = `INSERT INTO ${this.entityClass.getTableName()} (${emitted.join(', ')}) VALUES (${placeholders})`;

        if (ifNotExists) {
            query += ' IF NOT EXISTS';
        }

        // For INSERT the grammar puts USING at the end, after IF NOT EXISTS —
        // the opposite of UPDATE, where it follows the table name
        if (options?.ttl !== undefined) {
            query += ' USING TTL ?';
            params.push(this.assertTtl(options.ttl));
        }

        return { query, params };
    }

    /**
     * Find entities in the database based on the given conditions.
     * If no options are provided, it selects all rows from the table.
     * @param {FindOptions} [options] The options including conditions to filter the entities.
     * @param {boolean} [allowFiltering=false] Whether to allow filtering on the query.
     * @returns {Promise<T[]>} The entities that match the conditions.
     * @throws {InvalidQueryError} If `limit` is not an integer from 1 to 2147483647.
     */
    public async find(options?: FindOptions, allowFiltering: boolean = false): Promise<T[]> {
        const { query, params } = this.buildSelectQuery(options, allowFiltering);
        const results = await this.dataSource.executeQuery<T>(query, params, this.options);
        return results.map((row) => this.mapRowToEntity(row));
    }

    /**
     * Find a single page of entities, for cursor-based pagination.
     * Pass the returned `pageState` back in `options.pageState` to read the next page.
     * @param {FindOptions} [options] The options including conditions, page size and cursor.
     * @param {boolean} [allowFiltering=false] Whether to allow filtering on the query.
     * @returns {Promise<Page<T>>} The page of entities and the cursor to the next page, if any.
     * @throws {InvalidQueryError} If `limit` is not an integer from 1 to 2147483647.
     */
    public async findPaged(options?: FindOptions, allowFiltering: boolean = false): Promise<Page<T>> {
        const { query, params } = this.buildSelectQuery(options, allowFiltering);
        const { rows, pageState } = await this.dataSource.executeQueryPage<T>(
            query,
            params,
            this.buildQueryOptions(options)
        );

        return {
            rows: rows.map((row) => this.mapRowToEntity(row)),
            pageState,
            hasMore: pageState !== undefined,
        };
    }

    /**
     * Iterate over entities one at a time, fetching pages lazily.
     * Only a single page is held in memory, so this is the way to scan a result
     * set too large to load with `find()`.
     * @param {FindOptions} [options] The options including conditions and page size.
     * @param {boolean} [allowFiltering=false] Whether to allow filtering on the query.
     * @returns {AsyncIterableIterator<T>} An async iterator over the matching entities.
     * @throws {InvalidQueryError} If `limit` is not an integer from 1 to 2147483647. Thrown on the
     *     first advance of the iterator, not on the call, as with any async generator.
     */
    public async *stream(options?: FindOptions, allowFiltering: boolean = false): AsyncIterableIterator<T> {
        const { query, params } = this.buildSelectQuery(options, allowFiltering);

        for await (const row of this.dataSource.streamQuery<T>(query, params, this.buildQueryOptions(options))) {
            yield this.mapRowToEntity(row);
        }
    }

    /**
     * Find entities in the database based on the given conditions.
     * @param {NestedConditions} conditions The conditions to filter the entities.
     * @param {boolean} allowFiltering Whether to allow filtering on the query.
     * @returns {Promise<T[]>} The entities that match the conditions.
     */
    public async findBy(conditions: NestedConditions, allowFiltering: boolean = false): Promise<T[]> {
        const { conditionString, params } = this.buildConditionStringAndParams(conditions);
        let query = `SELECT * FROM ${this.entityClass.getTableName()} WHERE ${conditionString}`;

        if (allowFiltering) {
            query += ' ALLOW FILTERING';
        }

        const results = await this.dataSource.executeQuery<T>(query, params, this.options);
        return results.map((row) => this.mapRowToEntity(row));
    }

    /**
     * Find one entity in the database based on the given conditions.
     * @param {Partial<T>} conditions The conditions to filter the entities.
     * @param {boolean} allowFiltering Whether to allow filtering on the query.
     * @returns {Promise<T | null>} The entity that match the conditions or null if not found.
     */
    public async findOneBy(conditions: Partial<T>, allowFiltering: boolean = false): Promise<T | null> {
        const { conditionString, params } = this.buildEqualityConditions(conditions, 'findOneBy() conditions');
        let query = `SELECT * FROM ${this.entityClass.getTableName()} WHERE ${conditionString} LIMIT 1`;
        if (allowFiltering) {
            query += ' ALLOW FILTERING';
        }
        const results = await this.dataSource.executeQuery<T>(query, params, this.options);
        return results.length > 0 ? this.mapRowToEntity(results[0]) : null;
    }

    /**
     * Find all entities in the database.
     * @returns {Promise<T[]>} All entities in the database.
     */
    public async findOne(): Promise<T | null> {
        const query = `SELECT * FROM ${this.entityClass.getTableName()} LIMIT 1`;
        const results = await this.dataSource.executeQuery<T>(query, [], this.options);
        return results.length > 0 ? this.mapRowToEntity(results[0]) : null;
    }

    /**
     * Delete entities from the database based on the given conditions.
     * CQL DELETE is idempotent — no existence check needed.
     *
     * Awaits the static `beforeDelete()` on the entity class before the query runs and
     * `afterDelete()` after it succeeds, both passed the conditions; a hook that throws
     * aborts the operation. No hooks run for `deleteStatement()`, `clear()` or the
     * raw-query family.
     *
     * @param {Partial<T>} conditions The conditions to filter the entities.
     * @returns {Promise<void>}
     */
    public async delete(conditions: Partial<T>): Promise<void> {
        const hookConditions = conditions as Record<string, unknown>;

        await this.entityClass.beforeDelete?.(hookConditions);

        const { query, params } = this.buildDeleteStatement(conditions);
        await this.dataSource.executeQuery<null>(query, params, this.options);

        await this.entityClass.afterDelete?.(hookConditions);
    }

    /**
     * Delete the matching rows only if they exist, via a lightweight transaction.
     *
     * Unlike `delete()`, this reports whether anything was there: the server
     * takes a Paxos round to decide, which costs more than a plain DELETE — use
     * it only where the answer matters. Runs the same `beforeDelete()`/`afterDelete()`
     * hooks as `delete()`.
     *
     * @param {Partial<T>} conditions The conditions to filter the entities.
     * @returns {Promise<boolean>} True if the server applied the delete, false if no row matched.
     * @throws {InvalidQueryError} If `conditions` is empty or carries a null value.
     * @throws {UnknownColumnError} If a column is not declared on the entity.
     */
    public async deleteIfExists(conditions: Partial<T>): Promise<boolean> {
        const hookConditions = conditions as Record<string, unknown>;

        await this.entityClass.beforeDelete?.(hookConditions);

        const { query, params } = this.buildDeleteStatement(conditions);
        const rows = await this.dataSource.executeQuery<RawRow>(`${query} IF EXISTS`, params, this.options);

        await this.entityClass.afterDelete?.(hookConditions);

        return extractApplied(rows);
    }

    /**
     * Build the DELETE statement `delete()` would run, without running it.
     *
     * Applies the same rejections as `delete()`, but runs NO lifecycle hooks —
     * the statement is only executed when passed to `DataSource.executeBatch()`.
     *
     * @param {Partial<T>} conditions The conditions to filter the entities.
     * @returns {BatchStatement} The CQL and the values bound to its placeholders.
     * @throws {InvalidQueryError} If `conditions` is empty or carries a null value.
     * @throws {UnknownColumnError} If a column is not declared on the entity.
     */
    public deleteStatement(conditions: Partial<T>): BatchStatement {
        return this.buildDeleteStatement(conditions);
    }

    /**
     * Build the DELETE shared by `delete()` and `deleteStatement()`.
     *
     * @param {Partial<T>} conditions The conditions to filter the entities.
     * @returns {BatchStatement} The CQL and the values bound to its placeholders.
     */
    private buildDeleteStatement(conditions: Partial<T>): BatchStatement {
        const { conditionString, params } = this.buildEqualityConditions(conditions, 'delete() conditions');

        return { query: `DELETE FROM ${this.entityClass.getTableName()} WHERE ${conditionString}`, params };
    }

    /**
     * Update columns on the rows matching the conditions, without reading them first.
     *
     * `UPDATE` in CQL is an upsert like `INSERT`: a primary key that matches no
     * row creates it. Pass `null` to delete a cell; `undefined` throws, because
     * in JavaScript it is far more often a bug than a decision.
     *
     * Awaits the static `beforeUpdate()` on the entity class before the query runs and
     * `afterUpdate()` after it succeeds, both passed `(conditions, values)`; a hook that
     * throws aborts the operation. No hooks run for `updateStatement()`,
     * `increment()`/`decrement()` or the raw-query family.
     *
     * @param {Partial<T>} conditions Equality conditions; must identify rows by primary key.
     * @param {Partial<T>} values The columns to set and the values to set them to.
     * @param {WriteOptions} [options] The write options, including `ttl` in seconds.
     * @returns {Promise<void>}
     * @throws {InvalidQueryError} If `values` is empty, assigns a primary key or COUNTER column,
     *     carries an undefined value, or `ttl` is not an integer from 1 to 2147483647.
     * @throws {UnknownColumnError} If a column is not declared on the entity.
     * @throws {ColumnValidationError} If a value does not fit its column's declared type or fails its validator.
     */
    public async update(conditions: Partial<T>, values: Partial<T>, options?: WriteOptions): Promise<void> {
        const hookConditions = conditions as Record<string, unknown>;
        const hookValues = values as Record<string, unknown>;

        await this.entityClass.beforeUpdate?.(hookConditions, hookValues);

        const { query, params } = this.buildUpdateStatement(conditions, values, options);
        await this.dataSource.executeQuery<null>(query, params, this.options);

        await this.entityClass.afterUpdate?.(hookConditions, hookValues);
    }

    /**
     * Update columns only on a row that already exists, via a lightweight
     * transaction.
     *
     * Unlike `update()`, this never creates the row: the server takes a Paxos
     * round to decide, which costs more than a plain UPDATE — use it only where
     * the upsert would be a bug. Runs the same `beforeUpdate()`/`afterUpdate()`
     * hooks as `update()`.
     *
     * @param {Partial<T>} conditions Equality conditions; must identify rows by primary key.
     * @param {Partial<T>} values The columns to set and the values to set them to.
     * @param {WriteOptions} [options] The write options, including `ttl` in seconds.
     * @returns {Promise<boolean>} True if the server applied the update, false if no row matched.
     * @throws {InvalidQueryError} If `values` is empty, assigns a primary key or COUNTER column,
     *     carries an undefined value, or `ttl` is not an integer from 1 to 2147483647.
     * @throws {UnknownColumnError} If a column is not declared on the entity.
     * @throws {ColumnValidationError} If a value does not fit its column's declared type or fails its validator.
     */
    public async updateIfExists(conditions: Partial<T>, values: Partial<T>, options?: WriteOptions): Promise<boolean> {
        const hookConditions = conditions as Record<string, unknown>;
        const hookValues = values as Record<string, unknown>;

        await this.entityClass.beforeUpdate?.(hookConditions, hookValues);

        const { query, params } = this.buildUpdateStatement(conditions, values, options, true);
        const rows = await this.dataSource.executeQuery<RawRow>(query, params, this.options);

        await this.entityClass.afterUpdate?.(hookConditions, hookValues);

        return extractApplied(rows);
    }

    /**
     * Build the UPDATE statement `update()` would run, without running it.
     *
     * Applies the same local rejections as `update()` — empty values, a primary
     * key or COUNTER assignment, an undefined value — but runs NO lifecycle
     * hooks; the statement is only executed when passed to
     * `DataSource.executeBatch()`.
     *
     * @param {Partial<T>} conditions Equality conditions; must identify rows by primary key.
     * @param {Partial<T>} values The columns to set and the values to set them to.
     * @param {WriteOptions} [options] The write options, including `ttl` in seconds.
     * @returns {BatchStatement} The CQL and the values bound to its placeholders.
     * @throws {InvalidQueryError} If `values` is empty, assigns a primary key or COUNTER column,
     *     carries an undefined value, or `ttl` is not an integer from 1 to 2147483647.
     * @throws {UnknownColumnError} If a column is not declared on the entity.
     * @throws {ColumnValidationError} If a value does not fit its column's declared type or fails its validator.
     */
    public updateStatement(conditions: Partial<T>, values: Partial<T>, options?: WriteOptions): BatchStatement {
        return this.buildUpdateStatement(conditions, values, options);
    }

    /**
     * Build the UPDATE shared by `update()`, `updateStatement()` and `updateIfExists()`.
     *
     * @param {Partial<T>} conditions Equality conditions; must identify rows by primary key.
     * @param {Partial<T>} values The columns to set and the values to set them to.
     * @param {WriteOptions} [options] The write options, including `ttl` in seconds.
     * @param {boolean} [ifExists=false] Whether to append `IF EXISTS`.
     * @returns {BatchStatement} The CQL and the values bound to its placeholders.
     */
    private buildUpdateStatement(
        conditions: Partial<T>,
        values: Partial<T>,
        options?: WriteOptions,
        ifExists: boolean = false
    ): BatchStatement {
        const entity = this.entityClass.name;

        // Single pass over the entries, same as the condition builders: reading keys
        // and values separately would let an enumerable getter reorder the bindings
        const entries = Object.entries(values);

        if (entries.length === 0) {
            throw InvalidQueryError.emptyConditions('update() values', entity);
        }

        const primaryKeys = new Set(this.entityClass.getPrimaryKeys().map((pk) => pk.name));
        const counters = this.counterColumns();
        const assignments: string[] = [];
        const params: BindableValue[] = [];

        for (const [key, value] of entries) {
            const column = this.assertColumn(key);

            // Both rejected locally: the server would refuse them a round trip away,
            // with a message about CQL rather than about the caller's arguments
            if (primaryKeys.has(key)) {
                throw InvalidQueryError.primaryKeyAssignment(key, entity);
            }

            if (counters.has(key)) {
                throw InvalidQueryError.counterAssignment(key, entity);
            }

            if (value === undefined) {
                throw InvalidQueryError.undefinedAssignment(key, entity);
            }

            this.assertValue(key, value);

            assignments.push(`${column} = ?`);
            params.push(value);
        }

        const { conditionString, params: whereParams } = this.buildEqualityConditions(
            conditions,
            'update() conditions'
        );

        // For UPDATE the grammar puts USING right after the table name, before
        // SET — the opposite of INSERT, where it comes at the end
        const ttlParams: BindableValue[] = [];
        let using = '';

        if (options?.ttl !== undefined) {
            using = ' USING TTL ?';
            ttlParams.push(this.assertTtl(options.ttl));
        }

        let query = `UPDATE ${this.entityClass.getTableName()}${using} SET ${assignments.join(
            ', '
        )} WHERE ${conditionString}`;

        if (ifExists) {
            query += ' IF EXISTS';
        }

        return { query, params: [...ttlParams, ...params, ...whereParams] };
    }

    /**
     * Add `by` to a COUNTER column on the rows matching the conditions.
     *
     * @param {Partial<T>} conditions Equality conditions; must identify rows by primary key.
     * @param {string} column The COUNTER column to move.
     * @param {number} [by=1] How far to move it; a safe integer, negative to subtract.
     * @returns {Promise<void>}
     * @throws {InvalidQueryError} If the column is not a COUNTER or `by` is not a safe integer.
     * @throws {UnknownColumnError} If the column is not declared on the entity.
     */
    public async increment(conditions: Partial<T>, column: keyof T & string, by: number = 1): Promise<void> {
        await this.moveCounter(conditions, column, by, '+', 'increment() conditions');
    }

    /**
     * Subtract `by` from a COUNTER column on the rows matching the conditions.
     *
     * @param {Partial<T>} conditions Equality conditions; must identify rows by primary key.
     * @param {string} column The COUNTER column to move.
     * @param {number} [by=1] How far to move it; a safe integer, negative to add.
     * @returns {Promise<void>}
     * @throws {InvalidQueryError} If the column is not a COUNTER or `by` is not a safe integer.
     * @throws {UnknownColumnError} If the column is not declared on the entity.
     */
    public async decrement(conditions: Partial<T>, column: keyof T & string, by: number = 1): Promise<void> {
        await this.moveCounter(conditions, column, by, '-', 'decrement() conditions');
    }

    /**
     * Count the rows in the table, optionally narrowed by conditions.
     *
     * A full-table count is a scan on the server side — on a large table,
     * prefer a dedicated COUNTER kept with `increment()`.
     *
     * @param {NestedConditions} [conditions] The conditions to narrow the count, if any.
     * @param {boolean} [allowFiltering=false] Whether to allow filtering on the query.
     * @returns {Promise<number>} How many rows matched.
     */
    public async count(conditions?: NestedConditions, allowFiltering: boolean = false): Promise<number> {
        if (conditions !== undefined) {
            return this.countBy(conditions, allowFiltering);
        }

        const query = `SELECT COUNT(*) FROM ${this.entityClass.getTableName()}`;
        const rows = await this.dataSource.executeQuery<RawRow>(query, [], this.options);

        return extractCount(rows);
    }

    /**
     * Count the rows matching the conditions.
     *
     * @param {NestedConditions} conditions The conditions to count by.
     * @param {boolean} [allowFiltering=false] Whether to allow filtering on the query.
     * @returns {Promise<number>} How many rows matched.
     */
    public async countBy(conditions: NestedConditions, allowFiltering: boolean = false): Promise<number> {
        const { conditionString, params } = this.buildConditionStringAndParams(conditions);
        let query = `SELECT COUNT(*) FROM ${this.entityClass.getTableName()} WHERE ${conditionString}`;

        if (allowFiltering) {
            query += ' ALLOW FILTERING';
        }

        const rows = await this.dataSource.executeQuery<RawRow>(query, params, this.options);

        return extractCount(rows);
    }

    /**
     * Whether the table has any rows at all.
     *
     * @returns {Promise<boolean>} True if at least one row exists.
     */
    public async exists(): Promise<boolean> {
        const query = `SELECT * FROM ${this.entityClass.getTableName()} LIMIT 1`;
        const rows = await this.dataSource.executeQuery<RawRow>(query, [], this.options);

        return rows.length > 0;
    }

    /**
     * Whether any row matches the conditions.
     *
     * Cheaper than `countBy(...) > 0`: the server stops at the first match
     * instead of scanning everything that qualifies.
     *
     * @param {NestedConditions} conditions The conditions to test.
     * @param {boolean} [allowFiltering=false] Whether to allow filtering on the query.
     * @returns {Promise<boolean>} True if at least one row matched.
     */
    public async existsBy(conditions: NestedConditions, allowFiltering: boolean = false): Promise<boolean> {
        const { conditionString, params } = this.buildConditionStringAndParams(conditions);
        let query = `SELECT * FROM ${this.entityClass.getTableName()} WHERE ${conditionString} LIMIT 1`;

        if (allowFiltering) {
            query += ' ALLOW FILTERING';
        }

        const rows = await this.dataSource.executeQuery<RawRow>(query, params, this.options);

        return rows.length > 0;
    }

    /**
     * Instantiate an entity from a plain object, without saving it.
     *
     * Only declared columns are copied — an extra key on the input (a request
     * body, typically) is ignored rather than mass-assigned. Defaults from the
     * column options apply first, so the input wins where both provide a value;
     * an `undefined` value is skipped so it cannot erase a default.
     *
     * @param {Partial<T>} [plain] The values to assign onto the fresh entity.
     * @returns {T} The entity, ready for `save()`.
     */
    public create(plain?: Partial<T>): T {
        const entity = new this.entityClass() as T;

        if (plain === undefined || plain === null) {
            return entity;
        }

        for (const key of this.getColumnMap().keys()) {
            // Own properties only, so a polluted Object.prototype cannot inject values
            if (!Object.prototype.hasOwnProperty.call(plain, key)) {
                continue;
            }

            const value = (plain as Record<string, unknown>)[key];

            if (value !== undefined) {
                (entity as Record<string, unknown>)[key] = value;
            }
        }

        return entity;
    }

    /**
     * Find one entity or throw, for the call sites where absence is a bug.
     *
     * @param {Partial<T>} conditions The equality conditions to look up by.
     * @param {boolean} [allowFiltering=false] Whether to allow filtering on the query.
     * @returns {Promise<T>} The entity that matched.
     * @throws {EntityNotFoundError} If no row matched. Carries the condition columns, never the values.
     */
    public async findOneOrFail(conditions: Partial<T>, allowFiltering: boolean = false): Promise<T> {
        const found = await this.findOneBy(conditions, allowFiltering);

        if (found === null) {
            throw new EntityNotFoundError({
                entity: this.entityClass.name,
                table: this.entityClass.tableName,
                criteriaColumns: Object.keys(conditions),
            });
        }

        return found;
    }

    /**
     * Delete every row in the table, via `TRUNCATE`.
     *
     * Unlike a `DELETE`, this writes no tombstones — it drops the SSTables.
     *
     * @returns {Promise<void>}
     */
    public async clear(): Promise<void> {
        await this.dataSource.executeQuery<null>(`TRUNCATE ${this.entityClass.getTableName()}`, [], this.options);
    }

    /**
     * Build and run the counter UPDATE shared by `increment()` and `decrement()`.
     *
     * @param {Partial<T>} conditions Equality conditions; must identify rows by primary key.
     * @param {string} key The property name of the COUNTER column.
     * @param {number} by How far to move the counter.
     * @param {'+' | '-'} sign Which way `by` is applied.
     * @param {string} clause How to name the conditions if they turn out to be empty.
     * @returns {Promise<void>}
     */
    private async moveCounter(
        conditions: Partial<T>,
        key: string,
        by: number,
        sign: '+' | '-',
        clause: string
    ): Promise<void> {
        const entity = this.entityClass.name;
        const column = this.assertColumn(key);

        if (!this.counterColumns().has(key)) {
            throw InvalidQueryError.notACounterColumn(key, entity);
        }

        // Safe integer, checked locally: the wire type is a 64-bit counter, and a
        // fractional or unsafe number would be silently rounded on encoding
        if (typeof by !== 'number' || !Number.isSafeInteger(by)) {
            throw InvalidQueryError.invalidCounterDelta(by, key, entity);
        }

        const { conditionString, params } = this.buildEqualityConditions(conditions, clause);
        const query = `UPDATE ${this.entityClass.getTableName()} SET ${column} = ${column} ${sign} ? WHERE ${conditionString}`;

        await this.dataSource.executeQuery<null>(query, [by, ...params], this.options);
    }

    /**
     * The property names declared as COUNTER columns.
     *
     * @returns {Set<string>} The counter column names, possibly empty.
     */
    private counterColumns(): Set<string> {
        return new Set((this.entityClass.columns ?? []).filter((col) => col.type === 'COUNTER').map((col) => col.name));
    }

    /**
     * Run a hand-written CQL query, binding `:name` placeholders as parameters.
     *
     * This is the deliberate escape hatch from identifier validation: the query
     * string is sent as written, so it is the way to reach CQL this ORM does not
     * model — `token(id)` ranges, quoted identifiers, collection access such as
     * `metadata['key']`, functions and aggregates. **Nothing in `query` is
     * checked against the entity's columns**, which is also the warning: never
     * build it by concatenating caller-supplied input, or the injection the rest
     * of the API prevents comes straight back. Values are safe — every `:name` is
     * bound by the driver, never concatenated.
     *
     * Rows are mapped onto the entity by default, which only makes sense for a
     * query shaped like the table. Pass `{ raw: true }` for anything else — an
     * aggregate, a projection, another table — and the driver's rows come back
     * untouched.
     *
     * The whole result set is read into memory. For a large scan — a token range,
     * typically — use `streamRawQuery()` or `runRawQueryPaged()`.
     *
     * @param {string} query The CQL to run, with `:name` placeholders for values.
     * @param {RawQueryParams} params A value for every `:name` in the query.
     * @param {RawQueryOptions | boolean} [options] The query options, or `allowFiltering` on its own.
     * @returns {Promise<T[]>} The rows the query returned, mapped to entities unless `raw` is set.
     * @throws {InvalidQueryError} If the query names a parameter that was not supplied.
     * @throws {QueryFailedError} If the driver rejects the query; its error is kept on `cause`.
     */
    public async runRawQuery<R extends object = RawRow>(
        query: string,
        params: RawQueryParams,
        options: RawQueryOptions & { raw: true }
    ): Promise<R[]>;
    public async runRawQuery(query: string, params: RawQueryParams, options?: RawQueryOptions | boolean): Promise<T[]>;
    public async runRawQuery(
        query: string,
        params: RawQueryParams,
        options: RawQueryOptions | boolean = {}
    ): Promise<object[]> {
        const resolved = resolveRawOptions(options);
        const bound = this.bindRawQuery(query, params, resolved);
        let rows: RawRow[];

        // Only the driver call is wrapped: a failure in the mapping below is a bug
        // in this ORM, and dressing it up as a query failure would hide that
        try {
            rows = await this.dataSource.executeQuery<RawRow>(
                bound.query,
                bound.params,
                this.buildQueryOptions(resolved)
            );
        } catch (error) {
            // Wrapped, not swallowed: the driver's error keeps its type and stack on `cause`
            throw new QueryFailedError(bound.query, error);
        }

        return resolved.raw ? rows : rows.map((row) => this.mapRowToEntity(row));
    }

    /**
     * Run a hand-written CQL query, returning a single page of results.
     *
     * The paging counterpart to `runRawQuery()`, carrying the same warning: the
     * query is not validated against the entity's columns. Pass the returned
     * `pageState` back in `options.pageState` to read the next page.
     *
     * @param {string} query The CQL to run, with `:name` placeholders for values.
     * @param {RawQueryParams} params A value for every `:name` in the query.
     * @param {RawQueryOptions} [options] The query options, including `fetchSize` and `pageState`.
     * @returns {Promise<Page<T>>} The page and the cursor to the next one, if any.
     * @throws {InvalidQueryError} If the query names a parameter that was not supplied.
     * @throws {QueryFailedError} If the driver rejects the query; its error is kept on `cause`.
     */
    public async runRawQueryPaged<R extends object = RawRow>(
        query: string,
        params: RawQueryParams,
        options: RawQueryOptions & { raw: true }
    ): Promise<Page<R>>;
    public async runRawQueryPaged(query: string, params: RawQueryParams, options?: RawQueryOptions): Promise<Page<T>>;
    public async runRawQueryPaged(
        query: string,
        params: RawQueryParams,
        options: RawQueryOptions = {}
    ): Promise<Page<object>> {
        const bound = this.bindRawQuery(query, params, options);
        let page: PagedResult<RawRow>;

        try {
            page = await this.dataSource.executeQueryPage<RawRow>(
                bound.query,
                bound.params,
                this.buildQueryOptions(options)
            );
        } catch (error) {
            throw new QueryFailedError(bound.query, error);
        }

        return {
            rows: options.raw ? page.rows : page.rows.map((row) => this.mapRowToEntity(row)),
            pageState: page.pageState,
            hasMore: page.pageState !== undefined,
        };
    }

    /**
     * Run a hand-written CQL query, yielding rows one at a time.
     *
     * The streaming counterpart to `runRawQuery()`, carrying the same warning: the
     * query is not validated against the entity's columns. Pages are fetched
     * lazily, so this is the way to scan a result set too large to hold in memory
     * — which is what a raw `token()` range is usually for.
     *
     * @param {string} query The CQL to run, with `:name` placeholders for values.
     * @param {RawQueryParams} params A value for every `:name` in the query.
     * @param {RawQueryOptions} [options] The query options, including `fetchSize`.
     * @returns {AsyncIterableIterator<T>} An iterator over the rows the query returns.
     * @throws {InvalidQueryError} If the query names a parameter that was not supplied.
     * @throws {QueryFailedError} If the driver rejects the query; its error is kept on `cause`.
     */
    public streamRawQuery<R extends object = RawRow>(
        query: string,
        params: RawQueryParams,
        options: RawQueryOptions & { raw: true }
    ): AsyncIterableIterator<R>;
    public streamRawQuery(query: string, params: RawQueryParams, options?: RawQueryOptions): AsyncIterableIterator<T>;
    public async *streamRawQuery(
        query: string,
        params: RawQueryParams,
        options: RawQueryOptions = {}
    ): AsyncIterableIterator<object> {
        const bound = this.bindRawQuery(query, params, options);
        const rows = this.dataSource.streamQuery<RawRow>(bound.query, bound.params, this.buildQueryOptions(options));

        // Stepped by hand rather than with `for await`, so that only what the driver
        // throws is wrapped: inside a `for await` body, an exception thrown *into*
        // the generator by its consumer would be caught and reported as a query failure
        for (;;) {
            let next: IteratorResult<RawRow>;

            try {
                next = await rows.next();
            } catch (error) {
                throw new QueryFailedError(bound.query, error);
            }

            if (next.done) {
                return;
            }

            yield options.raw ? next.value : this.mapRowToEntity(next.value);
        }
    }

    /**
     * Substitute the named parameters and append `ALLOW FILTERING`, for the whole
     * raw-query family.
     *
     * @param {string} query The CQL as the caller wrote it.
     * @param {RawQueryParams} params The values for its `:name` placeholders.
     * @param {RawQueryOptions} options The options the call was made with.
     * @returns {BoundQuery} The query to send and the values to bind.
     */
    private bindRawQuery(query: string, params: RawQueryParams, options: RawQueryOptions): BoundQuery {
        const bound = bindNamedParameters(query, params, this.entityClass.name);

        return options.allowFiltering ? { query: `${bound.query} ALLOW FILTERING`, params: bound.params } : bound;
    }

    /**
     * Build the SELECT query and parameters shared by `find()`, `findPaged()` and `stream()`.
     * @param {FindOptions} [options] The options including projection, conditions, ordering and limit.
     * @param {boolean} [allowFiltering=false] Whether to allow filtering on the query.
     * @returns {{ query: string, params: Array<SimpleConditionValue> }} The query and its parameters.
     */
    private buildSelectQuery(
        options?: FindOptions,
        allowFiltering: boolean = false
    ): { query: string; params: Array<string | number | Buffer | boolean> } {
        let projection = '*';

        if (options?.select !== undefined) {
            if (options.select.length === 0) {
                throw InvalidQueryError.emptyConditions('select clause', this.entityClass.name);
            }

            // Every name resolves through the whitelist, like a condition or sort column
            projection = options.select.map((key) => this.assertColumn(key)).join(', ');
        }

        let query = `SELECT ${projection} FROM ${this.entityClass.getTableName()}`;
        let params: Array<string | number | Buffer | boolean> = [];

        if (options?.where) {
            const { conditionString, params: conditionParams } = this.buildConditionStringAndParams(options.where);
            query += ` WHERE ${conditionString}`;
            params = conditionParams;
        }

        if (options?.orderBy) {
            const orderEntries = Object.entries(options.orderBy);

            if (orderEntries.length === 0) {
                throw InvalidQueryError.emptyConditions('orderBy clause', this.entityClass.name);
            }

            const orderStrings = orderEntries.map(([key, direction]) => {
                const column = this.assertColumn(key);

                // Interpolated like the column, so it is whitelisted like the column
                if (direction !== 'ASC' && direction !== 'DESC') {
                    throw InvalidQueryError.invalidDirection(direction, key, this.entityClass.name);
                }

                return `${column} ${direction}`;
            });
            query += ` ORDER BY ${orderStrings.join(', ')}`;
        }

        if (options?.limit !== undefined) {
            const limit = this.assertLimit(options.limit);

            query += ' LIMIT ?';
            params.push(limit);
        }

        if (allowFiltering) {
            query += ' ALLOW FILTERING';
        }

        return { query, params };
    }

    /**
     * Build the driver query options, carrying over any paging settings.
     * @param {{ fetchSize?: number, pageState?: string }} [options] Whatever the caller passed, find or raw.
     * @returns {QueryOptions} The options to pass to the driver.
     */
    private buildQueryOptions(options?: { fetchSize?: number; pageState?: string }): QueryOptions {
        return {
            ...this.options,
            ...(options?.fetchSize !== undefined && { fetchSize: options.fetchSize }),
            ...(options?.pageState !== undefined && { pageState: options.pageState }),
        };
    }

    /**
     * Resolve a caller-supplied key to the column name to emit, or throw.
     *
     * CQL cannot parameterize identifiers, so every name interpolated into a
     * query passes through here and must appear in the entity's metadata. The
     * whitelist is the security boundary: escaping is not an option, and a name
     * that is not on the list never reaches the server.
     *
     * @param {string} key The property name supplied by the caller.
     * @returns {string} The column name to emit in CQL.
     */
    protected assertColumn(key: string): string {
        const column = this.getColumnMap().get(key);

        if (column !== undefined) {
            return column;
        }

        // Shape before membership: a name that could never be a column is a misuse of the
        // API — a CQL expression or a quoted identifier — and wants different advice than a typo
        if (!UNQUOTED_IDENTIFIER.test(key)) {
            throw InvalidQueryError.invalidIdentifier(key, this.entityClass.name);
        }

        throw new UnknownColumnError({
            column: key,
            entity: this.entityClass.name,
            table: this.entityClass.tableName,
            knownColumns: this.getColumnNames(),
        });
    }

    /**
     * Resolve a caller-supplied `LIMIT` to the number to bind, or throw.
     *
     * The driver encodes the bind marker as an `int`, and rejects anything it
     * cannot fit with a `RangeError` from its buffer writer — an error that
     * names neither the entity nor the offending option. Checking here instead
     * means a bad `limit` fails locally, against the range the wire type can
     * actually carry, with a message about what the caller passed.
     *
     * @param {unknown} limit The limit supplied by the caller.
     * @returns {number} The limit to bind.
     */
    private assertLimit(limit: unknown): number {
        const coerced = typeof limit === 'string' ? Number(limit) : limit;

        if (typeof coerced !== 'number' || !Number.isInteger(coerced) || coerced <= 0 || coerced > MAX_CQL_INT) {
            throw InvalidQueryError.invalidLimit(limit, this.entityClass.name);
        }

        return coerced;
    }

    /**
     * Resolve a caller-supplied TTL to the number to bind, or throw.
     *
     * Checked locally for the same reason as `LIMIT`: the bind marker is an
     * `int`, and the driver's own rejection would name neither the entity nor
     * the offending option. Zero is rejected too — CQL reads it as "no TTL",
     * which a caller passing one never means.
     *
     * @param {unknown} ttl The TTL supplied by the caller, in seconds.
     * @returns {number} The TTL to bind.
     */
    private assertTtl(ttl: unknown): number {
        if (typeof ttl !== 'number' || !Number.isSafeInteger(ttl) || ttl <= 0 || ttl > MAX_CQL_INT) {
            throw InvalidQueryError.invalidTtl(ttl, this.entityClass.name);
        }

        return ttl;
    }

    /**
     * Validate a value about to be written to a column, or throw.
     *
     * Runs the column's declared type predicate and its `validate` option, if
     * any. Only the write builders call this — reads and deletes bind values as
     * supplied, so a driver type the ORM does not model still reaches the server.
     *
     * @param {string} key The property name being written; already on the whitelist.
     * @param {unknown} value The value about to be bound.
     * @throws {ColumnValidationError} If the value fails the type predicate or the custom validator.
     */
    private assertValue(key: string, value: unknown): void {
        const definition = (this.entityClass.columns ?? []).find((col) => col.name === key);

        if (definition !== undefined) {
            validateColumnValue(this.entityClass.name, key, definition.type, value, definition.options?.validate);
        }
    }

    /**
     * Get the entity's column map, building it on first use.
     *
     * Built lazily rather than in the constructor because `getRepository()` is a
     * plain factory whose contract is total — a malformed entity should fail on
     * the query that touches it, not on the call that returned the repository.
     *
     * @returns {ReadonlyMap<string, string>} Property name to emitted column name.
     */
    private getColumnMap(): ReadonlyMap<string, string> {
        const cached = columnMaps.get(this.entityClass);

        if (cached !== undefined) {
            return cached;
        }

        // Not cached on failure, so the error surfaces on every offending query
        const built = buildColumnMap(this.entityClass);
        columnMaps.set(this.entityClass, built);

        return built;
    }

    /**
     * Build the `col = ? AND …` fragment shared by `findOneBy()` and `delete()`.
     *
     * Values are bound as supplied rather than type-checked, so a driver type the
     * ORM does not model — a `Date`, a UDT — still reaches the server.
     *
     * @param {object} conditions The equality conditions supplied by the caller.
     * @param {string} clause How to name the conditions if they turn out to be empty.
     * @returns {{ conditionString: string, params: SimpleConditionValue[] }} The fragment and its parameters.
     */
    private buildEqualityConditions(
        conditions: object,
        clause: string
    ): { conditionString: string; params: SimpleConditionValue[] } {
        const entity = this.entityClass.name;

        // A single pass over the entries, because reading keys and values separately
        // lets an enumerable getter that mutates the object bind a value to the wrong
        // column, or emit a placeholder with no parameter behind it
        const entries = Object.entries(conditions);

        if (entries.length === 0) {
            throw InvalidQueryError.emptyConditions(clause, entity);
        }

        const conditionStrings: string[] = [];
        const params: SimpleConditionValue[] = [];

        for (const [key, value] of entries) {
            const column = this.assertColumn(key);

            if (value === null || value === undefined) {
                throw InvalidQueryError.nullCondition(key, entity);
            }

            conditionStrings.push(`${column} = ?`);
            params.push(value as SimpleConditionValue);
        }

        return { conditionString: conditionStrings.join(' AND '), params };
    }

    /**
     * Build a condition string and parameters for the given conditions.
     * @param {NestedConditions} conditions The conditions to build the string and parameters for.
     * @returns {{ conditionString: string, params: SimpleConditionValue[] }} The condition string and parameters.
     */
    private buildConditionStringAndParams(conditions: NestedConditions): {
        conditionString: string;
        params: SimpleConditionValue[];
    } {
        const entity = this.entityClass.name;
        const entries = Object.entries(conditions);

        if (entries.length === 0) {
            throw InvalidQueryError.emptyConditions('where clause', entity);
        }

        const conditionStrings: string[] = [];
        const params: SimpleConditionValue[] = [];

        entries.forEach(([key, value]) => {
            // Resolved once, so every branch below emits a whitelisted name and a
            // later branch cannot be added that forgets to validate
            const column = this.assertColumn(key);

            if (value === null || value === undefined) {
                throw InvalidQueryError.nullCondition(key, entity);
            }

            if (isCondition(value)) {
                // Read through own properties only: with `Object.prototype.operator = 'IN'`
                // set, an ordinary object value would otherwise be rerouted into the IN
                // branch and bound to values the caller never passed
                const operator = ownProperty(value, 'operator');
                const operand = ownProperty(value, 'value');

                switch (operator) {
                    case 'IN': {
                        if (!Array.isArray(operand)) {
                            throw InvalidQueryError.invalidInValues(key, entity, operand);
                        }

                        // Copied index by index rather than with `map` or `slice`: an Array
                        // subclass can override either, and `slice` would hand back another
                        // instance of that subclass. Deriving the placeholders from this copy
                        // is what keeps their count equal to the number of bound parameters
                        const operands: SimpleConditionValue[] = [];

                        for (let index = 0; index < operand.length; index++) {
                            const element = operand[index];

                            if (!isBindable(element)) {
                                throw InvalidQueryError.invalidConditionValue(key, entity, 'IN', element);
                            }

                            operands.push(element);
                        }

                        if (operands.length === 0) {
                            throw InvalidQueryError.emptyInValues(key, entity);
                        }

                        conditionStrings.push(`${column} IN (${new Array(operands.length).fill('?').join(', ')})`);
                        params.push(...operands);
                        break;
                    }
                    case 'BETWEEN': {
                        if (!Array.isArray(operand) || operand.length !== 2) {
                            throw InvalidQueryError.invalidBetweenValues(key, entity, operand);
                        }

                        // Read by index like the IN branch: `map`/destructuring can be
                        // overridden by an Array subclass
                        const from = operand[0];
                        const to = operand[1];

                        if (!isBindable(from)) {
                            throw InvalidQueryError.invalidConditionValue(key, entity, 'BETWEEN', from);
                        }

                        if (!isBindable(to)) {
                            throw InvalidQueryError.invalidConditionValue(key, entity, 'BETWEEN', to);
                        }

                        // Expanded rather than emitted as CQL BETWEEN, which only newer
                        // servers parse; the expansion is what BETWEEN means
                        conditionStrings.push(`${column} >= ? AND ${column} <= ?`);
                        params.push(from, to);
                        break;
                    }
                    case 'CONTAINS':
                    case 'CONTAINS KEY': {
                        if (!isBindable(operand)) {
                            throw InvalidQueryError.invalidConditionValue(key, entity, operator, operand);
                        }

                        // `operator` is the matched case literal here, never caller input
                        conditionStrings.push(`${column} ${operator} ?`);
                        params.push(operand);
                        break;
                    }
                    case '<':
                    case '<=':
                    case '>':
                    case '>=':
                    case '=': {
                        if (!isBindable(operand)) {
                            throw InvalidQueryError.invalidConditionValue(key, entity, operator, operand);
                        }

                        conditionStrings.push(`${column} ${operator} ?`);
                        params.push(operand);
                        break;
                    }
                    default:
                        throw InvalidQueryError.unsupportedOperator(operator, key, entity);
                }
            } else {
                if (!isBindable(value)) {
                    throw InvalidQueryError.invalidConditionValue(key, entity, '=', value);
                }

                conditionStrings.push(`${column} = ?`);
                params.push(value);
            }
        });

        return {
            conditionString: conditionStrings.join(' AND '),
            params,
        };
    }

    /* eslint-disable @typescript-eslint/no-explicit-any */
    /**
     * Map a row from the database to an entity.
     *
     * Columns absent from the row — a projection via `options.select`, or a raw
     * query narrower than the table — are skipped, so the property keeps its
     * constructor default or stays undefined.
     *
     * @param {any} row The row from the database.
     * @returns {T} The entity.
     */
    private mapRowToEntity(row: any): T {
        const entity = new this.entityClass() as T;
        for (const col of this.entityClass.columns || []) {
            if (!Object.prototype.hasOwnProperty.call(row, col.name)) {
                continue;
            }
            const rawValue = row[col.name];
            (entity as any)[col.name] = this.transformValue(rawValue, col.type);
        }
        return entity;
    }

    /**
     * Transform the value from the database to a JavaScript value.
     * @param {any} value The value from the database.
     * @param {string} type The type of the column.
     * @returns {any} The transformed value
     */
    private transformValue(value: any, type: string): any {
        if (value === null || value === undefined) return value;

        switch (type) {
            case 'ASCII':
            case 'DURATION':
            case 'INET':
            case 'TEXT':
            case 'TIME':
            case 'VARCHAR':
                return value;
            case 'BIGINT':
            case 'COUNTER':
            case 'VARINT':
                // Preserve Long/BigInteger objects from the driver to avoid precision loss
                return value;
            case 'INT':
            case 'SMALLINT':
            case 'TINYINT':
                // Already numbers from the driver
                return value;
            case 'BLOB':
                // Already a Buffer from the driver
                return value;
            case 'BOOLEAN':
                return Boolean(value);
            case 'DATE':
            case 'TIMESTAMP':
                return new Date(value);
            case 'DECIMAL':
                // Preserve BigDecimal objects from the driver to avoid precision loss
                return value;
            case 'DOUBLE':
            case 'FLOAT':
                // Already numbers from the driver
                return value;
            case 'TIMEUUID':
            case 'UUID':
                return value.toString();
            default:
                // Pass through for collection types (LIST, SET, MAP, TUPLE, FROZEN) and any other types
                return value;
        }
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */
}
