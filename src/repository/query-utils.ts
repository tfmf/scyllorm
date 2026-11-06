import type { types } from 'cassandra-driver';

/**
 * A value accepted in a `where` condition: a primitive, a `Buffer`, a `Date`, a
 * `bigint`, or one of the driver's value classes.
 */
export type SimpleConditionValue =
    | string
    | number
    | boolean
    | Buffer
    | Date
    | bigint
    | types.Long
    | types.Uuid
    | types.LocalDate
    | types.LocalTime
    | types.InetAddress
    | types.BigDecimal
    | types.Integer
    | types.Duration;

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

/**
 * Conditions without a column check at compile time: any string key, any condition value.
 * The shape to build a `where` dynamically in; it assigns to `FindOptionsWhere<T>` for a
 * concrete entity type. Every key is still checked against the entity when the query is built.
 */
export interface NestedConditions {
    [key: string]: Condition | SimpleConditionValue | NestedConditions;
}

/**
 * The column properties of an entity: every public key of `T` whose value is not a function, so
 * methods and lifecycle hooks are left out. TypeScript cannot tell a getter from a column, so a
 * getter is kept (and throws `UnknownColumnError` when the query is built); a private or protected
 * column is left out, as it is from `Partial<T>`.
 */
export type ColumnKeys<T> = {
    // `Function` rather than a call signature, which a property typed `Function` does not extend
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    [K in keyof T]-?: NonNullable<T[K]> extends Function ? never : K;
}[keyof T] &
    string;

/** True when `T` is `any`: a bare `FindOptions`, whose fields stay unchecked. */
type IsAny<T> = 0 extends 1 & T ? true : false;

/** The names `select` takes: any key of `T`, or anything in a bare `FindOptions`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SelectKeys<T> = IsAny<T> extends true ? any : keyof T & string;

/**
 * An equality value of the property's own type. Arrays, Sets and Maps are left out: an equality
 * on a LIST, SET or MAP column always throws when the query is built (use `Contains()`), as 0.9
 * refused them at compile time.
 */
type EqualityValue<V> = V extends readonly unknown[] | ReadonlySet<unknown> | ReadonlyMap<unknown, unknown> ? never : V;

/**
 * `where` conditions checked against the entity at compile time: each key must be a column
 * property. A value is an equality, either of the property's own type (a UDT interface
 * included) or any scalar the driver binds, or an operator such as `In()` or `GreaterThan()`.
 * Values are not tied to the property type: a UUID column typed `string` takes a `types.Uuid`.
 * An array, Set or Map is not an equality value. Each value is checked against the column's CQL
 * type when the query is built.
 * `null` does not compile; `undefined` does for an optional key (it is optional), and throws like `null`.
 *
 * In code generic over the entity type, TypeScript cannot resolve the keys; cast there with
 * `{ id } as unknown as FindOptionsWhere<T>`, and whole options with `as unknown as FindOptions<T>`.
 * A `Repository<BaseModel>` has no columns, so nothing is checked against it.
 */
export type FindOptionsWhere<T> = {
    // NonNullable: a null condition throws when the query is built, so it should not compile
    [K in ColumnKeys<T>]?: EqualityValue<NonNullable<T[K]>> | SimpleConditionValue | Condition;
};

export interface OrderByOption {
    column: string;
    direction?: 'ASC' | 'DESC';
}

/** Options shared by every call that runs a query. */
export interface ConsistencyOptions {
    /**
     * The consistency level for this query, overriding the client default
     * (`queryOptions.consistency` on the connection options). A value of
     * `consistencies`, e.g. `consistencies.localQuorum`; anything else throws
     * `InvalidQueryError`. Ignored by the statement builders — a batch takes
     * its consistency from `DataSource.executeBatch()`'s options.
     */
    consistency?: types.consistencies;
}

/**
 * Options for `find()`, `findPaged()` and `stream()`. `T` is the entity type; `Repository<T>`
 * fills it in. Left out, as in a bare `FindOptions`, nothing is checked at compile time: any
 * column name, any value. A bare `FindOptions`, spread or not, assigns to `FindOptions<Entity>`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface FindOptions<T = any> extends ConsistencyOptions {
    /**
     * The columns to read instead of `*`, as property names declared on the
     * entity; validated against the entity's metadata. Unselected properties
     * of the mapped entities keep their constructor defaults, or stay
     * undefined. An empty array throws `InvalidQueryError`.
     *
     * Typed as any key of `T`, methods included, rather than `ColumnKeys<T>`: an array of the
     * filtered keys stops `Repository<Base>` from being cast to `Repository<Entity>`. A method
     * name still throws `UnknownColumnError` when the query is built. `any[]` in a bare
     * `FindOptions`, so that spreading one into a typed call compiles.
     */
    select?: SelectKeys<T>[];
    where?: FindOptionsWhere<T>;
    orderBy?: IsAny<T> extends true ? { [column: string]: 'ASC' | 'DESC' } : { [K in ColumnKeys<T>]?: 'ASC' | 'DESC' };
    /** Must be an integer from 1 to 2147483647 at runtime; anything else throws `InvalidQueryError`. */
    limit?: number;
    /**
     * Rows to return per partition, rendered as `PER PARTITION LIMIT ?` — the
     * "latest N per sensor" query. Validated like `limit`.
     */
    perPartitionLimit?: number;
    /** Page size. Only used by `findPaged()` and `stream()`; ignored by `find()`. */
    fetchSize?: number;
    /** Cursor returned by a previous `findPaged()`. Only used by `findPaged()` and `stream()`. */
    pageState?: string;
}

/** Options for `delete()` and `deleteStatement()`. */
export interface DeleteOptions extends ConsistencyOptions {
    /**
     * The write timestamp in microseconds since the epoch, rendered as
     * `USING TIMESTAMP ?`. Orders writes inside a batch, and makes a retried
     * write land with the same timestamp. A safe integer or a `Long`; anything
     * else throws `InvalidQueryError`. Refused on the LWT variants, which CQL
     * does not allow it on.
     */
    timestamp?: number | types.Long;
}

/** Options for the write family: `save()`, `update()`, their statement builders and the LWT variants. */
export interface WriteOptions extends DeleteOptions {
    /**
     * Time to live in seconds; the written columns expire once it elapses.
     * Must be a positive integer no larger than 2147483647 at runtime; anything
     * else throws `InvalidQueryError`. Bound as a parameter, never interpolated.
     */
    ttl?: number;
}

/** Options for the calls that fan work out: `DataSource.executeConcurrent()` and `Repository.saveMany()`. */
export interface ConcurrencyOptions {
    /** How many queries run at once; a positive integer, 100 by default. */
    concurrency?: number;
}

/** Options for `Repository.scan()`. `T` is the entity type, as for `FindOptions`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ScanOptions<T = any> extends ConsistencyOptions {
    /** How many token ranges are read at once; a positive integer, 16 by default. */
    concurrency?: number;
    /** How many token ranges the ring is cut into; a positive integer, `concurrency * 4` by default. */
    splits?: number;
    /** The page size of each range query. */
    fetchSize?: number;
    /** The columns to read instead of `*`, as `FindOptions.select`. */
    select?: SelectKeys<T>[];
}

/** The values for a raw query's `:name` placeholders, keyed by name without the colon. */
export interface RawQueryParams {
    [name: string]: BindableValue;
}

/** Options for the raw-query family: `runRawQuery()`, `runRawQueryPaged()` and `streamRawQuery()`. */
export interface RawQueryOptions extends ConsistencyOptions {
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
    /**
     * Whether the query is safe to run twice. Only idempotent queries are
     * retried, and only they are eligible for speculative execution. Defaults
     * to the client's `queryOptions.isIdempotent`, and failing that to true for
     * a `SELECT` and false for anything else.
     */
    isIdempotent?: boolean;
}

/**
 * A single statement of a batch: the CQL to run and the values bound to its
 * `?` placeholders. Built by the `Repository` statement builders and executed
 * by `DataSource.executeBatch()`.
 */
export interface BatchStatement {
    query: string;
    params: BindableValue[];
    /**
     * Marks a counter update; set by `incrementStatement()` and
     * `decrementStatement()`. `executeBatch()` sends a batch of these as a
     * counter batch, and refuses one that mixes them with other statements.
     */
    counter?: boolean;
    /**
     * Set to `false` to mark a statement that is not safe to run twice;
     * `updateStatement()` does so when it appends or prepends to a LIST.
     * `executeBatch()` then does not retry the batch unless told to, and
     * `executeConcurrent()` never retries the statement. Any other value is ignored.
     */
    isIdempotent?: boolean;
}

/** The collection updates, as named by the helper that builds them. */
export type CollectionOperation = 'Append' | 'Prepend' | 'Remove' | 'PutKeys' | 'RemoveKeys';

/**
 * An update applied to a collection column in place, instead of overwriting it.
 * Built by `Append()`, `Prepend()`, `Remove()`, `PutKeys()` and `RemoveKeys()`;
 * a class so that a MAP value — a plain object — can never be mistaken for one.
 */
export class CollectionUpdate {
    constructor(
        readonly operation: CollectionOperation,
        readonly value: unknown
    ) {}
}

/** The values `update()` accepts: each column's own type, or a collection update. */
export type UpdateValues<T> = { [K in keyof T]?: T[K] | CollectionUpdate };

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
export function In<T extends SimpleConditionValue | object>(values: T[]): Condition {
    return {
        operator: 'IN',
        // A plain object is a UDT value; whether the column takes one is checked when the query is built
        value: values as SimpleConditionValue[],
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
export function Contains<T extends SimpleConditionValue | object>(value: T): Condition {
    return {
        operator: 'CONTAINS',
        value: value as SimpleConditionValue,
    };
}

/**
 * Match rows whose MAP column contains the key.
 *
 * ScyllaDB requires an index on the map's keys or `allowFiltering` for this
 * operator.
 */
export function ContainsKey<T extends SimpleConditionValue | object>(key: T): Condition {
    return {
        operator: 'CONTAINS KEY',
        value: key as SimpleConditionValue,
    };
}

/**
 * Add elements to the end of a LIST, or to a SET, in `update()`: `col = col + ?`.
 * A LIST takes an array only; the driver cannot encode a `Set` as one.
 *
 * Appending to a LIST is not idempotent — a replay appends twice — so such an
 * update is never retried.
 */
export function Append<T>(values: T[] | Set<T>): CollectionUpdate {
    return new CollectionUpdate('Append', values);
}

/**
 * Add elements to the start of a LIST in `update()`: `col = ? + col`.
 *
 * Not idempotent — a replay prepends twice — so such an update is never retried.
 */
export function Prepend<T>(values: T[]): CollectionUpdate {
    return new CollectionUpdate('Prepend', values);
}

/** Remove every occurrence of the elements from a LIST, or remove them from a SET, in `update()`: `col = col - ?`. */
export function Remove<T>(values: T[] | Set<T>): CollectionUpdate {
    return new CollectionUpdate('Remove', values);
}

/** Add or overwrite entries of a MAP in `update()`: `col = col + ?`. */
export function PutKeys(entries: Record<string, unknown> | Map<unknown, unknown>): CollectionUpdate {
    return new CollectionUpdate('PutKeys', entries);
}

/** Remove keys from a MAP in `update()`: `col = col - ?`. */
export function RemoveKeys<K>(keys: K[] | Set<K>): CollectionUpdate {
    return new CollectionUpdate('RemoveKeys', keys);
}
