import { DataSource } from '../data-source/DataSource';
import { BaseModel } from '../model/BaseModel';
import { SimpleConditionValue, NestedConditions, FindOptions } from './query-utils';

export class Repository<T extends BaseModel> {
    protected entityClass: typeof BaseModel;

    constructor(private dataSource: DataSource, entityClass: typeof BaseModel) {
        this.entityClass = entityClass;
    }

    private options = { prepare: true };

    /**
     * Save the entity to the database.
     * @param {T} entity - The entity to save.
     * @returns {Promise<T | null>} The entity after saving, or null if saving fails.
     */
    public async save(entity: T): Promise<T> {
        // Get the primary keys and their values from the entity
        const primaryKeyFields = this.entityClass.getPrimaryKeys();
        const primaryKeyValues = primaryKeyFields.map(
            (pk) => entity[pk.name as keyof T] as string | number | boolean | Buffer
        );

        // Get all the keys and values to insert from the entity
        const columns = this.entityClass.columns ?? [];
        const keys = columns.map((col) => col.name);
        const placeholders = keys.map(() => '?').join(', ');
        const params = keys.map((key) => entity[key as keyof T] as string | number | boolean | Buffer);

        // Construct the INSERT query
        const insertQuery = `INSERT INTO ${this.entityClass.getTableName()} (${keys.join(
            ', '
        )}) VALUES (${placeholders})`;
        await this.dataSource.executeQuery<null>(insertQuery, params, this.options);

        // Construct the SELECT query to retrieve the newly saved entity
        const fetchQuery =
            `SELECT * FROM ${this.entityClass.getTableName()} WHERE ` +
            primaryKeyFields.map((pk) => `${pk.name} = ?`).join(' AND ');

        // Execute the SELECT query and return the entity
        const fetchResults = await this.dataSource.executeQuery<T>(fetchQuery, primaryKeyValues, this.options);
        return fetchResults.length > 0 ? this.mapRowToEntity(fetchResults[0]) : null;
    }

    /**
     * Find entities in the database based on the given conditions.
     * If no options are provided, it selects all rows from the table.
     * @param {FindOptions} [options] The options including conditions to filter the entities.
     * @param {boolean} [allowFiltering=false] Whether to allow filtering on the query.
     * @returns {Promise<T[]>} The entities that match the conditions.
     */
    public async find(options?: FindOptions, allowFiltering: boolean = false): Promise<T[]> {
        let query = `SELECT * FROM ${this.entityClass.getTableName()}`;
        let params: Array<string | number | Buffer | boolean> = [];

        if (options?.where) {
            const { where, orderBy } = options;
            const { conditionString, params: conditionParams } = this.buildConditionStringAndParams(where);
            query += ` WHERE ${conditionString}`;
            params = conditionParams;

            if (orderBy) {
                const orderStrings = Object.entries(orderBy).map(([column, direction]) => {
                    return `${column} ${direction}`;
                });
                query += ` ORDER BY ${orderStrings.join(', ')}`;
            }
        }

        if (allowFiltering) {
            query += ' ALLOW FILTERING';
        }

        const results = await this.dataSource.executeQuery<T>(query, params, this.options);
        return results.map((row) => this.mapRowToEntity(row));
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
        const conditionStrings = Object.keys(conditions).map((key) => `${key} = ?`);
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
     * @param {Partial<T>} conditions The conditions to filter the entities.
     * @returns {Promise<boolean>} True if the entities are deleted, false otherwise.
     */
    public async delete(conditions: Partial<T>): Promise<boolean> {
        const existQuery = `SELECT * FROM ${this.entityClass.getTableName()} WHERE ${Object.keys(conditions)
            .map((key) => `${key} = ?`)
            .join(' AND ')} LIMIT 1`;
        const existParams = Object.values(conditions) as (string | number | boolean | Buffer)[];
        const existResults = await this.dataSource.executeQuery<T>(existQuery, existParams, this.options);

        if (existResults.length > 0) {
            const deleteQuery = `DELETE FROM ${this.entityClass.getTableName()} WHERE ${Object.keys(conditions)
                .map((key) => `${key} = ?`)
                .join(' AND ')}`;
            const deleteParams = Object.values(conditions) as (string | number | boolean | Buffer)[];
            await this.dataSource.executeQuery<null>(deleteQuery, deleteParams, this.options);

            const postDeleteResults = await this.dataSource.executeQuery<T>(existQuery, existParams, this.options);
            return postDeleteResults.length === 0;
        }

        return false;
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
            if (typeof value === 'object' && 'operator' in value) {
                switch (value.operator) {
                    case 'IN': {
                        if (Array.isArray(value.value)) {
                            const placeholders = value.value.map(() => '?').join(', ');
                            conditionStrings.push(`${key} IN (${placeholders})`);
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
                            conditionStrings.push(`${key} ${value.operator} ?`);
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
                    conditionStrings.push(`${key} = ?`);
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

        // Check if value is a BigDecimal-like object
        if (value && typeof value === 'object' && '_scale' in value && '_intVal' in value) {
            return Number(value._intVal.toString()) / Math.pow(10, value._scale);
        }

        switch (type) {
            case 'ASCII':
            case 'DURATION': // Consider custom handling
            case 'INET': // Leave as is, can be treated as string
            case 'TEXT':
            case 'TIME': // Consider custom handling
            case 'VARCHAR':
                return value;
            case 'BIGINT':
            case 'COUNTER':
            case 'INT':
            case 'SMALLINT':
            case 'TINYINT':
            case 'VARINT':
                return parseInt(value, 10); // Convert to JavaScript number
            case 'BLOB':
                return Buffer.from(value, 'base64'); // Convert to Buffer
            case 'BOOLEAN':
                return Boolean(value); // Convert to boolean
            case 'DATE':
            case 'TIMESTAMP':
                return new Date(value); // Convert to JavaScript Date
            case 'DECIMAL':
            case 'DOUBLE':
            case 'FLOAT':
                return parseFloat(value); // Convert to JavaScript number
            case 'TIMEUUID':
            case 'UUID':
                return value.toString(); // Convert to string
            default:
                throw new Error(`Unsupported type: ${type}`);
        }
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */
}
