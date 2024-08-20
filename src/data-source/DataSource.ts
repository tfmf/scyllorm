import { Client, QueryOptions, errors } from 'cassandra-driver';
import { ConnectionOptions } from './ConnectionOptions';
import { Repository } from '../repository';
import { BaseModel } from '../model';

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
    }

    /**
     * Execute a query against ScyllaDB.
     * @param query The CQL query string.
     * @param params The parameters for the query.
     * @param options Query options, such as preparation settings.
     * @param retries The current retry count.
     * @returns The array of rows returned by the query.
     */
    public async executeQuery<T extends object>(
        query: string,
        params: Array<string | number | Buffer | boolean>,
        options: QueryOptions = { prepare: true },
        retries: number = 0
    ): Promise<T[] | null> {
        if (!this.connected) {
            console.warn('ScyllaDB is not connected. Attempting to reconnect...');
            await this.reconnect();
        }
        try {
            const result = await this.client.execute(query, params, options);
            return result.rows as T[];
        } catch (error) {
            if (
                (error instanceof errors.NoHostAvailableError || error instanceof errors.DriverInternalError) &&
                retries < this.MAX_RETRIES
            ) {
                retries++;
                console.warn(`Connection lost. Retrying query attempt ${retries}/${this.MAX_RETRIES}.`);
                return this.executeQuery(query, params, options, retries);
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
    public getRepository<T extends BaseModel>(entityClass: typeof BaseModel): Repository<T> {
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
