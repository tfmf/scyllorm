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
export type OperatorType = 'IN' | '=' | '<' | '<=' | '>' | '>=';

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
    where?: NestedConditions;
    orderBy?: { [column: string]: 'ASC' | 'DESC' };
    limit?: number;
    /** Page size. Only used by `findPaged()` and `stream()`; ignored by `find()`. */
    fetchSize?: number;
    /** Cursor returned by a previous `findPaged()`. Only used by `findPaged()` and `stream()`. */
    pageState?: string;
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
