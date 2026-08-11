import { QueryOptions } from 'cassandra-driver';
import { DataSource } from '../data-source/DataSource';
import { BaseModel } from '../model/BaseModel';
import { InvalidQueryError, UnknownColumnError } from '../errors';
import { SimpleConditionValue, NestedConditions, FindOptions, Page } from './query-utils';

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
        const conditionStrings = Object.keys(conditions).map((key) => `${this.assertColumn(key)} = ?`);
        let query = `SELECT * FROM ${this.entityClass.getTableName()} WHERE ${conditionStrings.join(' AND ')} LIMIT 1`;
        if (allowFiltering) {
            query += ' ALLOW FILTERING';
        }
        const params = Object.values(conditions) as (string | number | boolean | Buffer)[];
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
        const deleteQuery = `DELETE FROM ${this.entityClass.getTableName()} WHERE ${Object.keys(conditions)
            .map((key) => `${this.assertColumn(key)} = ?`)
            .join(' AND ')}`;
        const deleteParams = Object.values(conditions) as (string | number | boolean | Buffer)[];
        await this.dataSource.executeQuery<null>(deleteQuery, deleteParams, this.options);
    }

    /**
     * Delete entities from the database based on the given conditions.
     * @param {[key: string]: SimpleConditionValue} conditions The conditions to filter the entities.
     * @param {boolean} allowFiltering Whether to allow filtering on the query.
     * @returns {Promise<boolean>} True if the entities are deleted, false otherwise.
     */
    public async runRawQuery(
        query: string,
        params: { [key: string]: SimpleConditionValue },
        allowFiltering: boolean = false
    ): Promise<T[]> {
        const paramKeys = Object.keys(params);
        const paramValues: SimpleConditionValue[] = [];

        // Replace the named parameters in the query with `?`
        let formattedQuery = query.replace(/:(\w+)/g, (match, p1) => {
            if (paramKeys.includes(p1)) {
                paramValues.push(params[p1]);
                return '?';
            } else {
                throw new Error(`Missing value for parameter: ${p1}`);
            }
        });

        if (allowFiltering) {
            formattedQuery += ' ALLOW FILTERING';
        }

        // Execute the query with the extracted values
        try {
            const results = await this.dataSource.executeQuery<T>(formattedQuery, paramValues, this.options);
            return results.map((row) => this.mapRowToEntity(row));
        } catch (error) {
            throw new Error(`Query failed: ${error.message}`);
        }
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
            const orderStrings = Object.entries(options.orderBy).map(([key, direction]) => {
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
     * @param {FindOptions} [options] The find options holding `fetchSize` and `pageState`.
     * @returns {QueryOptions} The options to pass to the driver.
     */
    private buildQueryOptions(options?: FindOptions): QueryOptions {
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
     * Build a condition string and parameters for the given conditions.
     * @param {NestedConditions} conditions The conditions to build the string and parameters for.
     * @returns {{ conditionString: string, params: SimpleConditionValue[] }} The condition string and parameters.
     */
    private buildConditionStringAndParams(conditions: NestedConditions): {
        conditionString: string;
        params: SimpleConditionValue[];
    } {
        const conditionStrings: string[] = [];
        const params: SimpleConditionValue[] = [];

        Object.entries(conditions).forEach(([key, value]) => {
            // Resolved once, so every branch below emits a whitelisted name and a
            // later branch cannot be added that forgets to validate
            const column = this.assertColumn(key);

            if (value !== null && typeof value === 'object' && 'operator' in value) {
                switch (value.operator) {
                    case 'IN': {
                        if (Array.isArray(value.value)) {
                            const placeholders = value.value.map(() => '?').join(', ');
                            conditionStrings.push(`${column} IN (${placeholders})`);
                            params.push(...(value.value as SimpleConditionValue[]));
                        } else {
                            throw new Error(`Expected an array for IN condition on key ${key}`);
                        }
                        break;
                    }
                    case '<':
                    case '<=':
                    case '>':
                    case '>=':
                    case '=': {
                        if (
                            typeof value.value === 'string' ||
                            typeof value.value === 'number' ||
                            typeof value.value === 'boolean' ||
                            value.value instanceof Buffer
                        ) {
                            conditionStrings.push(`${column} ${value.operator} ?`);
                            params.push(value.value);
                        } else {
                            throw new Error(
                                `Invalid value type for operator ${value.operator} on key ${key}: ${typeof value.value}`
                            );
                        }
                        break;
                    }
                    default:
                        throw new Error(`Unsupported operator: ${value.operator}`);
                }
            } else {
                if (
                    typeof value === 'string' ||
                    typeof value === 'number' ||
                    typeof value === 'boolean' ||
                    value instanceof Buffer
                ) {
                    conditionStrings.push(`${column} = ?`);
                    params.push(value);
                } else {
                    throw new Error(`Invalid value type for key ${key}: ${typeof value}`);
                }
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
