import { Client, QueryOptions, errors, types } from 'cassandra-driver';
import { ConnectionOptions } from './ConnectionOptions';
import { Repository } from '../repository';
import { BaseModel } from '../model';
import { BindableValue } from '../repository/query-utils';

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
    private readonly MAX_RETRIES = 3; // Maximum number of retries

    constructor(options: ConnectionOptions) {
        this.client = new Client(options);
    }

    /**
     * Initialize ScyllaDB client.
     */
    public async initialize(): Promise<void> {
        if (!this.connected) {
            try {
                await this.client.connect();
                this.connected = true;
                console.info('Connected to ScyllaDB successfully.');
            } catch (error) {
                console.error('Failed to connect to ScyllaDB.', error);
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
        if (!this.connected) {
            console.warn('ScyllaDB is not connected. Attempting to reconnect...');
            await this.reconnect();
        }
        try {
            return await this.client.execute(query, params, options);
        } catch (error) {
            if (
                (error instanceof errors.NoHostAvailableError || error instanceof errors.DriverInternalError) &&
                retries < this.MAX_RETRIES
            ) {
                retries++;
                console.warn(`Connection lost. Retrying query attempt ${retries}/${this.MAX_RETRIES}.`);
                return this.runQuery(query, params, options, retries);
            } else {
                console.error(`Query failed: ${error}`);
                throw error;
            }
        }
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
     * Reconnect to ScyllaDB.
     * @returns A promise that resolves when the reconnection is complete.
     */
    private async reconnect(): Promise<void> {
        console.log('Reconnecting to ScyllaDB...');
        await this.shutdown(); // Close the existing, possibly broken connection
        await this.initialize(); // Re-establish the connection
    }
}
