import { ClientOptions } from 'cassandra-driver';

/**
 * Interface for defining connection options for ScyllaDB.
 * This extends the ClientOptions provided by the cassandra-driver package
 */
export interface ConnectionOptions extends ClientOptions {
    // left empty on purpose
}
