import { QueryOptions } from 'cassandra-driver';
import { DataSource, PagedResult } from '../data-source/DataSource';
import { BaseModel } from '../model/BaseModel';
import { InvalidQueryError, QueryFailedError, UnknownColumnError } from '../errors';
import { BoundQuery, bindNamedParameters } from './named-parameters';
import {
    SimpleConditionValue,
    NestedConditions,
    FindOptions,
    Page,
    RawQueryOptions,
    RawQueryParams,
    RawRow,
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
     * @param {T} entity - The entity to save.
     * @returns {Promise<T>} The saved entity.
     */
    public async save(entity: T): Promise<T> {
        // Routed through the same whitelist as every other query builder, so a
        // malformed entity fails here too instead of reaching the driver unchecked
        const columnMap = this.getColumnMap();
        const keys = [...columnMap.keys()];
        const emitted = [...columnMap.values()];
        const placeholders = keys.map(() => '?').join(', ');
        const params = keys.map((key) => entity[key as keyof T] as string | number | boolean | Buffer);

        // Construct and execute the INSERT query
        const insertQuery = `INSERT INTO ${this.entityClass.getTableName()} (${emitted.join(
            ', '
        )}) VALUES (${placeholders})`;
        await this.dataSource.executeQuery<null>(insertQuery, params, this.options);

        return entity;
    }

    /**
     * Find entities in the database based on the given conditions.
     * If no options are provided, it selects all rows from the table.
     * @param {FindOptions} [options] The options including conditions to filter the entities.
     * @param {boolean} [allowFiltering=false] Whether to allow filtering on the query.
     * @returns {Promise<T[]>} The entities that match the conditions.
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
     * @param {Partial<T>} conditions The conditions to filter the entities.
     * @returns {Promise<void>}
     */
    public async delete(conditions: Partial<T>): Promise<void> {
        const { conditionString, params } = this.buildEqualityConditions(conditions, 'delete() conditions');
        const deleteQuery = `DELETE FROM ${this.entityClass.getTableName()} WHERE ${conditionString}`;
        await this.dataSource.executeQuery<null>(deleteQuery, params, this.options);
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
     * @param {FindOptions} [options] The options including conditions, ordering and limit.
     * @param {boolean} [allowFiltering=false] Whether to allow filtering on the query.
     * @returns {{ query: string, params: Array<SimpleConditionValue> }} The query and its parameters.
     */
    private buildSelectQuery(
        options?: FindOptions,
        allowFiltering: boolean = false
    ): { query: string; params: Array<string | number | Buffer | boolean> } {
        let query = `SELECT * FROM ${this.entityClass.getTableName()}`;
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
            query += ` LIMIT ${Math.floor(options.limit)}`;
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
     * @param {any} row The row from the database.
     * @returns {T} The entity.
     */
    private mapRowToEntity(row: any): T {
        const entity = new this.entityClass() as T;
        for (const col of this.entityClass.columns || []) {
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
