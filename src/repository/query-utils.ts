// Condition type that will be used in the find method
export type SimpleConditionValue = string | number | boolean | Buffer;

/**
 * A value bound to a `?` placeholder.
 *
 * Deliberately wider than `SimpleConditionValue`: the driver binds plenty the ORM
 * does not model — `Date`, `uuid`, `Long`, collections, UDTs — and the raw-query
 * family exists precisely to reach them.
 */
export type BindableValue = unknown;

// Supported operators for the condition https://opensource.docs.scylladb.com/stable/cql/dml/select.html#select
export type OperatorType = 'IN' | '=' | '<' | '<=' | '>' | '>=' | 'BETWEEN' | 'CONTAINS' | 'CONTAINS KEY';

export interface Condition {
    operator: OperatorType;
    value: SimpleConditionValue | SimpleConditionValue[];
}

export interface NestedConditions {
    [key: string]: Condition | SimpleConditionValue | NestedConditions;
}

export interface OrderByOption {
    column: string;
    direction?: 'ASC' | 'DESC';
}

export interface FindOptions {
    /**
     * The columns to read instead of `*`, as property names declared on the
     * entity; validated against the entity's metadata. Unselected properties
     * of the mapped entities keep their constructor defaults, or stay
     * undefined. An empty array throws `InvalidQueryError`.
     */
    select?: string[];
    where?: NestedConditions;
    orderBy?: { [column: string]: 'ASC' | 'DESC' };
    /** Must be an integer from 1 to 2147483647 at runtime; anything else throws `InvalidQueryError`. */
    limit?: number;
    /** Page size. Only used by `findPaged()` and `stream()`; ignored by `find()`. */
    fetchSize?: number;
    /** Cursor returned by a previous `findPaged()`. Only used by `findPaged()` and `stream()`. */
    pageState?: string;
}

/** Options for the write family: `save()`, `update()`, their statement builders and the LWT variants. */
export interface WriteOptions {
    /**
     * Time to live in seconds; the written columns expire once it elapses.
     * Must be a positive integer no larger than 2147483647 at runtime; anything
     * else throws `InvalidQueryError`. Bound as a parameter, never interpolated.
     */
    ttl?: number;
}

/** The values for a raw query's `:name` placeholders, keyed by name without the colon. */
export interface RawQueryParams {
    [name: string]: BindableValue;
}

/** Options for the raw-query family: `runRawQuery()`, `runRawQueryPaged()` and `streamRawQuery()`. */
export interface RawQueryOptions {
    /** Append `ALLOW FILTERING` to the query. */
    allowFiltering?: boolean;
    /**
     * Return the driver's rows as they arrive instead of mapping them onto the
     * entity. Set this for anything the entity cannot represent — an aggregate,
     * a projection, another table.
     *
     * The return type follows the literal `true`, so pass the options inline;
     * through a variable widened to `boolean` the call still types as entities.
     */
    raw?: boolean;
    /** Page size. Only used by `runRawQueryPaged()` and `streamRawQuery()`. */
    fetchSize?: number;
    /** Cursor returned by a previous `runRawQueryPaged()`. */
    pageState?: string;
}

/**
 * A single statement of a batch: the CQL to run and the values bound to its
 * `?` placeholders. Built by the `Repository` statement builders and executed
 * by `DataSource.executeBatch()`.
 */
export interface BatchStatement {
    query: string;
    params: BindableValue[];
}

/** A row as the driver returned it, when `raw` is set. */
export interface RawRow {
    [column: string]: unknown;
}

/** A single page of entities, as returned by `Repository.findPaged()`. */
export interface Page<T> {
    rows: T[];
    /** Cursor for the next page; `undefined` once the result set is exhausted. */
    pageState?: string;
    hasMore: boolean;
}

// Utility functions for various operations
export function In<T extends SimpleConditionValue>(values: T[]): Condition {
    return {
        operator: 'IN',
        value: values,
    };
}

export function LessThan<T extends SimpleConditionValue>(value: T): Condition {
    return {
        operator: '<',
        value,
    };
}

export function LessThanOrEqual<T extends SimpleConditionValue>(value: T): Condition {
    return {
        operator: '<=',
        value,
    };
}

export function GreaterThan<T extends SimpleConditionValue>(value: T): Condition {
    return {
        operator: '>',
        value,
    };
}

export function GreaterThanOrEqual<T extends SimpleConditionValue>(value: T): Condition {
    return {
        operator: '>=',
        value,
    };
}

/**
 * Match values from `from` to `to`, both ends included.
 *
 * Emitted as `col >= ? AND col <= ?` rather than CQL's `BETWEEN`, which only
 * newer server versions parse — the expansion is what BETWEEN means and runs
 * everywhere.
 */
export function Between<T extends SimpleConditionValue>(from: T, to: T): Condition {
    return {
        operator: 'BETWEEN',
        value: [from, to],
    };
}

/**
 * Match rows whose LIST, SET or MAP column contains the value.
 *
 * ScyllaDB requires an index on the collection or `allowFiltering` for this
 * operator.
 */
export function Contains<T extends SimpleConditionValue>(value: T): Condition {
    return {
        operator: 'CONTAINS',
        value,
    };
}

/**
 * Match rows whose MAP column contains the key.
 *
 * ScyllaDB requires an index on the map's keys or `allowFiltering` for this
 * operator.
 */
export function ContainsKey<T extends SimpleConditionValue>(key: T): Condition {
    return {
        operator: 'CONTAINS KEY',
        value: key,
    };
}

/**
 * @deprecated Use `GreaterThan` instead.
 */
export function MoreThan<T extends SimpleConditionValue>(value: T): Condition {
    return GreaterThan(value);
}

/**
 * @deprecated Use `GreaterThanOrEqual` instead.
 */
export function MoreThanOrEqual<T extends SimpleConditionValue>(value: T): Condition {
    return GreaterThanOrEqual(value);
}
