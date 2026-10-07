import { ClientOptions } from 'cassandra-driver';

/**
 * Where Scyllorm reports connection and query events. `console` satisfies it,
 * and so do most logging libraries (pino, winston, bunyan).
 */
export interface Logger {
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}

/**
 * Interface for defining connection options for ScyllaDB.
 * This extends the ClientOptions provided by the cassandra-driver package
 */
export interface ConnectionOptions extends ClientOptions {
    /**
     * Receives connection and query events. Defaults to `console`; pass your
     * application's logger, or one with no-op methods to silence Scyllorm.
     * Not passed on to the driver.
     */
    logger?: Logger;
}
