import { Client, ClientOptions, QueryOptions, errors, types } from 'cassandra-driver';
import { ConnectionOptions, Logger } from './ConnectionOptions';
import { Repository } from '../repository';
import { BaseModel } from '../model';
import { BatchStatement, BindableValue, ConcurrencyOptions, RawRow } from '../repository/query-utils';
import { buildCreateIndexes, buildCreateTable } from '../schema';
import { diffTable, diffType, planTypes, ExistingColumn, ExistingType } from '../schema/SchemaBuilder';
import { InvalidQueryError } from '../errors';

/** How many queries `executeConcurrent()` and `saveMany()` run at once when the caller does not say. */
const DEFAULT_CONCURRENCY = 100;

/** Options for {@link DataSource.synchronize}. */
export interface SynchronizeOptions {
    /**
     * Opt in to reconciling existing tables and types with the entities: adds
     * missing columns and UDT fields. It never drops or changes anything —
     * every other difference is logged as a warning.
     */
    alter?: boolean;
}

/** A query the caller says nothing about is only assumed safe to run twice if it is a read. */
const SELECT = /^\s*SELECT\b/i;

/** A conditional (LWT) clause: `IF EXISTS`, `IF NOT EXISTS` or `IF col = ?`. */
const CONDITIONAL = /\bIF\b/i;

/** String literals and quoted identifiers, where an `if` is text rather than a clause. */
const QUOTED = /'(?:[^']|'')*'|"(?:[^"]|"")*"/g;

/**
 * Map items through an async function, at most `concurrency` at a time.
 *
 * Results keep the order of `items`. On the first failure no new item starts;
 * the ones already running are awaited, then that first error is thrown, so
 * nothing is left in flight once the promise settles.
 *
 * @param items The items to map.
 * @param concurrency How many to run at once; a positive integer.
 * @param fn The async function to run per item.
 * @returns The results, in the order of `items`.
 * @throws {InvalidQueryError} If `concurrency` is not a positive integer.
 */
export async function mapConcurrent<I, R>(
    items: readonly I[],
    concurrency: number = DEFAULT_CONCURRENCY,
    fn: (item: I) => Promise<R>
): Promise<R[]> {
    if (typeof concurrency !== 'number' || !Number.isSafeInteger(concurrency) || concurrency < 1) {
        throw InvalidQueryError.invalidConcurrency(concurrency);
    }

    const results: R[] = new Array(items.length);
    let next = 0;
    let failed = false;
    let failure: unknown;

    const worker = async (): Promise<void> => {
        while (!failed && next < items.length) {
            const index = next++;

            try {
                results[index] = await fn(items[index]);
            } catch (error) {
                if (!failed) {
                    failed = true;
                    failure = error;
                }
            }
        }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));

    if (failed) {
        throw failure;
    }

    return results;
}

/**
 * A single page of a result set.
 * `pageState` is only present when further pages are available — pass it back
 * in the query options to fetch the next page.
 */
export interface PagedResult<T> {
    rows: T[];
    pageState?: string;
}

export class DataSource {
    private client: Client;
    private connected: boolean = false;
    // The driver refuses to connect a Client that has been shut down, so the next initialize() replaces it
    private shutDown: boolean = false;
    private readonly MAX_RETRIES = 3; // Maximum number of retries
    private readonly RETRY_BASE_DELAY_MS = 50; // First backoff; doubles on every retry
    private readonly clientOptions: ClientOptions;
    private readonly logger: Logger;

    constructor(options: ConnectionOptions) {
        const { logger, ...clientOptions } = options;

        this.logger = logger ?? console;
        this.clientOptions = clientOptions;
        this.client = new Client(clientOptions);
    }

    /**
     * Initialize ScyllaDB client.
     * Safe to call again after `shutdown()`: a fresh driver client is created.
     */
    public async initialize(): Promise<void> {
        if (!this.connected) {
            if (this.shutDown) {
                this.client = new Client(this.clientOptions);
                this.shutDown = false;
            }

            try {
                await this.client.connect();
                this.connected = true;
                this.logger.info('Connected to ScyllaDB successfully.');
            } catch (error) {
                this.logger.error('Failed to connect to ScyllaDB.', error);
                throw error;
            }
        }
    }

    /**
     * Close ScyllaDB client.
     */
    public async shutdown(): Promise<void> {
        await this.client.shutdown();
        this.connected = false;
        this.shutDown = true;
    }

    /**
     * Execute a query against ScyllaDB, reading every page of the result set.
     *
     * ScyllaDB returns results one page at a time (`fetchSize`, 5000 rows by
     * default), so this walks the pages until the result set is exhausted.
     * For result sets too large to hold in memory, use `streamQuery()` or
     * `executeQueryPage()` instead.
     *
     * @param query The CQL query string.
     * @param params The parameters for the query.
     * @param options Query options, such as preparation settings.
     * @param retries The current retry count.
     * @returns The array of rows returned by the query.
     */
    public async executeQuery<T extends object>(
        query: string,
        params: BindableValue[],
        options: QueryOptions = { prepare: true },
        retries: number = 0
    ): Promise<T[]> {
        const rows: T[] = [];
        let pageState = options.pageState;

        do {
            const result = await this.runQuery(query, params, { ...options, pageState }, retries);
            // `rows` is undefined for VOID results — INSERT, UPDATE, DELETE, DDL
            rows.push(...((result.rows ?? []) as T[]));
            pageState = result.pageState;
        } while (pageState);

        return rows;
    }

    /**
     * Execute a query against ScyllaDB, returning a single page of results.
     *
     * The returned `pageState` is only set when further pages are available;
     * pass it back in `options.pageState` to read the next page.
     *
     * @param query The CQL query string.
     * @param params The parameters for the query.
     * @param options Query options, such as page size (`fetchSize`) and `pageState`.
     * @param retries The current retry count.
     * @returns The page of rows and the cursor to the next page, if any.
     */
    public async executeQueryPage<T extends object>(
        query: string,
        params: BindableValue[],
        options: QueryOptions = { prepare: true },
        retries: number = 0
    ): Promise<PagedResult<T>> {
        const result = await this.runQuery(query, params, options, retries);

        // The driver reports exhaustion as null; the Page contract says undefined
        return { rows: (result.rows ?? []) as T[], pageState: result.pageState ?? undefined };
    }

    /**
     * Execute a query against ScyllaDB, yielding rows one at a time.
     *
     * Pages are fetched lazily, so only a single page is ever held in memory —
     * this is the way to scan a result set larger than the process can hold.
     *
     * @param query The CQL query string.
     * @param params The parameters for the query.
     * @param options Query options, such as page size (`fetchSize`).
     * @returns An async iterator over the rows of the result set.
     */
    public async *streamQuery<T extends object>(
        query: string,
        params: BindableValue[],
        options: QueryOptions = { prepare: true }
    ): AsyncIterableIterator<T> {
        let pageState = options.pageState;

        do {
            const result = await this.runQuery(query, params, { ...options, pageState });
            yield* (result.rows ?? []) as T[];
            pageState = result.pageState;
        } while (pageState);
    }

    /**
     * Execute a single query against ScyllaDB, retrying on connection errors.
     * @param query The CQL query string.
     * @param params The parameters for the query.
     * @param options Query options, such as preparation settings.
     * @param retries The current retry count.
     * @returns The raw driver result set.
     */
    private async runQuery(
        query: string,
        params: BindableValue[],
        options: QueryOptions,
        retries: number = 0
    ): Promise<types.ResultSet> {
        const isIdempotent =
            options.isIdempotent ?? this.clientOptions.queryOptions?.isIdempotent ?? SELECT.test(query);

        return this.withRetry(
            () => this.client.execute(query, params, { ...options, isIdempotent }),
            isIdempotent,
            retries
        );
    }

    /**
     * Run a driver call with the shared reconnect and retry behavior:
     * reconnect first if the client is not connected, then retry an idempotent
     * call on NoHostAvailableError/DriverInternalError up to MAX_RETRIES times,
     * with exponential backoff and jitter.
     * @param action The driver call to run.
     * @param isIdempotent Whether the call is safe to run twice; only then is it retried.
     * @param retries The current retry count.
     * @returns Whatever the driver call resolves to.
     */
    private async withRetry<T>(action: () => Promise<T>, isIdempotent: boolean, retries: number = 0): Promise<T> {
        if (!this.connected) {
            this.logger.warn('ScyllaDB is not connected. Attempting to reconnect...');
            await this.reconnect();
        }
        try {
            return await action();
        } catch (error) {
            // The error can arrive after the driver already sent the statement to a host
            // that applied it, so only a statement that is safe to run twice is tried again
            if (
                isIdempotent &&
                (error instanceof errors.NoHostAvailableError || error instanceof errors.DriverInternalError) &&
                retries < this.MAX_RETRIES
            ) {
                retries++;
                this.logger.warn(`Connection lost. Retrying query attempt ${retries}/${this.MAX_RETRIES}.`);

                // 50ms, 100ms, 200ms, each scaled to 50-100% so clients that failed together retry apart
                const delay = this.RETRY_BASE_DELAY_MS * 2 ** (retries - 1);
                await new Promise((resolve) => setTimeout(resolve, delay * (0.5 + Math.random() / 2)));

                return this.withRetry(action, isIdempotent, retries);
            } else {
                this.logger.error(`Query failed: ${error}`);
                throw error;
            }
        }
    }

    /**
     * Execute a batch of statements, atomically as a CQL logged batch by default.
     * An unlogged or counter batch is not atomic across partitions.
     *
     * Build the statements with the `Repository` statement builders —
     * `saveStatement()`, `updateStatement()`, `deleteStatement()`,
     * `incrementStatement()`, `decrementStatement()` — which run no lifecycle
     * hooks; nothing is executed until the batch is passed here.
     *
     * Pass `{ logged: false }` for a batch confined to one partition, which
     * needs no batch log. A batch of counter statements is sent as a counter
     * batch on its own; mixing them with other statements throws, as CQL
     * requires. The batch is retried on NoHostAvailableError/DriverInternalError
     * only if it is idempotent: no counter, no LIST append or prepend and no
     * `IF` condition, unless `options.isIdempotent` says otherwise.
     *
     * @param statements The statements to run, at least one.
     * @param options Query options, such as `logged` or `consistency`; statements are prepared unless
     *     `prepare: false` is passed.
     * @returns A promise that resolves when the batch has been applied.
     * @throws {InvalidQueryError} If `statements` is empty or mixes counter updates with other statements.
     */
    public async executeBatch(statements: BatchStatement[], options: QueryOptions = {}): Promise<void> {
        if (statements.length === 0) {
            throw InvalidQueryError.emptyBatch();
        }

        const counters = statements.filter((statement) => statement.counter).length;

        if (counters > 0 && counters < statements.length) {
            throw InvalidQueryError.mixedCounterBatch();
        }

        const counter = options.counter ?? counters > 0;
        // A counter moves again when replayed, a list append lands twice, and a conditional
        // write may report a different outcome
        const isIdempotent =
            options.isIdempotent ??
            (!counter &&
                !statements.some(
                    (statement) =>
                        statement.isIdempotent === false || CONDITIONAL.test(statement.query.replace(QUOTED, ''))
                ));
        // The driver only reads query and params; the counter and idempotence markers are ours
        const queries = statements.map(({ query, params }) => ({ query, params }));

        await this.withRetry(
            () => this.client.batch(queries, { prepare: true, ...options, counter, isIdempotent }),
            isIdempotent
        );
    }

    /**
     * Execute statements in parallel, at most `concurrency` at a time.
     *
     * The recommended way to touch many partitions: parallel single-partition
     * queries rather than a multi-partition `IN` or batch. Each statement runs
     * like `executeQuery()` — prepared, every page read, reconnect and retry
     * included. A statement is retried only if it is idempotent, resolved like
     * `executeQuery()`: `options.isIdempotent`, then the client's
     * `queryOptions.isIdempotent`, then whether it is a `SELECT` — pass
     * `isIdempotent: true` for writes from `saveStatement()`, `updateStatement()`
     * or `deleteStatement()`. A counter statement, or one that appends or
     * prepends to a LIST, is never retried.
     *
     * On the first failure no new statement starts; the ones already running
     * finish, then the error is thrown. Statements that ran are not undone.
     *
     * @param statements The statements to run, usually from the `Repository` statement builders.
     * @param options Query options applied to every statement, plus `concurrency` (100 by default).
     * @returns The rows of each statement, in the order of `statements`; empty for writes.
     * @throws {InvalidQueryError} If `concurrency` is not a positive integer.
     */
    public async executeConcurrent<T extends object = RawRow>(
        statements: BatchStatement[],
        options: QueryOptions & ConcurrencyOptions = {}
    ): Promise<T[][]> {
        const { concurrency, ...queryOptions } = options;

        // A counter moves again and a list append lands twice when replayed, whatever the
        // caller or the client default says
        return mapConcurrent(statements, concurrency, ({ query, params, counter, isIdempotent }) =>
            this.executeQuery<T>(query, params, {
                prepare: true,
                ...queryOptions,
                ...((counter || isIdempotent === false) && { isIdempotent: false }),
            })
        );
    }

    /**
     * Get whether or not the ScyllaDB client is connected.
     * @returns Whether or not the ScyllaDB client is connected.
     */
    public isConnected(): boolean {
        return this.connected;
    }

    /**
     * Get a repository for a specific entity class.
     * @param entityClass
     * @returns
     */
    public getRepository<T extends BaseModel>(entityClass: (new () => T) & typeof BaseModel): Repository<T> {
        return new Repository<T>(this, entityClass);
    }

    /**
     * Create the types, tables and indexes for the given entities from their metadata.
     *
     * Per entity, runs each `CREATE TYPE IF NOT EXISTS` (dependencies first),
     * then `CREATE TABLE IF NOT EXISTS`, then the `CREATE INDEX IF NOT EXISTS`
     * statements, in order. A type shared by several entities is created once
     * per call. DDL is executed with `prepare: false` — schema statements must
     * not be prepared.
     *
     * With `alter: true`, each type and table is also read back from
     * `system_schema` and missing columns and UDT fields are added with
     * `ALTER`; indexes run last so new columns can be indexed. Nothing is
     * dropped or changed: other differences are logged as warnings.
     *
     * @param entities The entity classes to synchronize.
     * @param options See {@link SynchronizeOptions}.
     * @returns A promise that resolves when every statement has run.
     * @throws {InvalidQueryError} If a type is defined two ways, or, with `alter`, an entity's keyspace is unknown.
     */
    public async synchronize(entities: Array<typeof BaseModel>, options?: SynchronizeOptions): Promise<void> {
        const alter = options?.alter === true;
        // The definition each type was created with in this call, by case-folded qualified name; folded
        // too, since every part of it is an unquoted identifier or a lowercase field name to the server
        const createdTypes = new Map<string, string>();

        for (const entity of entities) {
            // Everything is built and checked before anything runs, so an invalid entity leaves no partial DDL behind
            const types = planTypes(entity);
            const table = buildCreateTable(entity);
            const indexes = buildCreateIndexes(entity);
            const keyspace = alter ? this.keyspaceOf(entity) : '';

            for (const plan of types) {
                const earlier = createdTypes.get(plan.qualified);

                if (earlier !== undefined && earlier !== plan.definition.toLowerCase()) {
                    throw InvalidQueryError.conflictingUdt(plan.name, entity.name);
                }
            }

            for (const plan of types) {
                if (createdTypes.has(plan.qualified)) {
                    continue;
                }

                createdTypes.set(plan.qualified, plan.definition.toLowerCase());
                // IF NOT EXISTS makes every statement safe to run twice
                await this.executeQuery(plan.statement, [], { prepare: false, isIdempotent: true });

                if (alter) {
                    const [row] = await this.executeQuery<ExistingType>(
                        'SELECT field_names, field_types FROM system_schema.types WHERE keyspace_name = ? AND type_name = ?',
                        [keyspace, plan.name.toLowerCase()],
                        { prepare: true }
                    );

                    await this.applyDiff(diffType(plan.udt, plan.prefix, row, entity.name));
                }
            }

            await this.executeQuery(table, [], { prepare: false, isIdempotent: true });

            if (alter) {
                const rows = await this.executeQuery<ExistingColumn>(
                    'SELECT column_name, kind, type, position, clustering_order FROM system_schema.columns WHERE keyspace_name = ? AND table_name = ?',
                    [keyspace, entity.getTableName().split('.').pop()!.toLowerCase()],
                    { prepare: true }
                );

                await this.applyDiff(diffTable(entity, rows));
            }

            for (const statement of indexes) {
                await this.executeQuery(statement, [], { prepare: false, isIdempotent: true });
            }
        }
    }

    /**
     * Resolve the keyspace an entity's table lives in: its qualifier, else the connection's.
     *
     * @param entity The entity class.
     * @returns The keyspace name.
     * @throws {InvalidQueryError} If the table is unqualified and no keyspace is set on the connection.
     */
    private keyspaceOf(entity: typeof BaseModel): string {
        const table = entity.getTableName();
        const keyspace = table.includes('.')
            ? // An unquoted qualifier, which the server folds; a connection keyspace is used as the driver holds it
              table.slice(0, table.indexOf('.')).toLowerCase()
            : (this.client.keyspace ?? this.clientOptions.keyspace);

        if (!keyspace) {
            throw InvalidQueryError.unknownKeyspace(entity.name);
        }

        return keyspace;
    }

    /**
     * Run the ALTER statements of a schema diff and log its warnings.
     *
     * @param diff The statements and warnings.
     */
    private async applyDiff(diff: { statements: string[]; warnings: string[] }): Promise<void> {
        diff.warnings.forEach((warning) => this.logger.warn(warning));

        for (const statement of diff.statements) {
            // Replaying an ADD fails, so a retry must not happen
            await this.executeQuery(statement, [], { prepare: false, isIdempotent: false });
        }
    }

    /**
     * Reconnect to ScyllaDB.
     * @returns A promise that resolves when the reconnection is complete.
     */
    private async reconnect(): Promise<void> {
        this.logger.info('Reconnecting to ScyllaDB...');
        await this.shutdown(); // Close the existing, possibly broken connection
        await this.initialize(); // Re-establish the connection
    }
}
