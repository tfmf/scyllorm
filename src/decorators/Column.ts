import { BaseModel } from '../model/BaseModel';
import { ownMetadataArray, upsertByName } from './metadata-utils';

export type ColumnType =
    | 'ASCII'
    | 'BIGINT'
    | 'BLOB'
    | 'BOOLEAN'
    | 'COUNTER'
    | 'DATE'
    | 'DECIMAL'
    | 'DOUBLE'
    | 'DURATION'
    | 'FLOAT'
    | 'FROZEN'
    | 'INET'
    | 'INT'
    | 'LIST'
    | 'MAP'
    | 'SET'
    | 'SMALLINT'
    | 'TINYINT'
    | 'TIME'
    | 'TIMESTAMP'
    | 'TIMEUUID'
    | 'TEXT'
    | 'TUPLE'
    | 'UUID'
    | 'VARINT'
    | 'VARCHAR';

export interface ColumnOptions {
    default?: unknown; // Default value for the column
}

/**
 * Decorator for defining a column in a table.
 *
 * @param {ColumnType} type The type of the column.
 * @param {ColumnOptions} options Additional options for the column.
 * @returns {PropertyDecorator} The property decorator.
 */
export function Column(type: ColumnType, options?: ColumnOptions): PropertyDecorator {
    return function (target: object, propertyName: string | symbol) {
        const constructor = target.constructor as typeof BaseModel;

        // Get the columns array this class owns, seeded from any inherited columns
        const columns = ownMetadataArray<{ name: string; type: ColumnType; options?: ColumnOptions }>(
            constructor,
            'columns'
        );

        // Convert the property key to a string
        const columnName = propertyName.toString();

        // Create the base column definition
        const columnDefinition = {
            name: columnName,
            type, // Use the type provided to the decorator
        } as { name: string; type: ColumnType; options?: ColumnOptions };

        // Conditionally add options if they are provided
        if (options) {
            columnDefinition.options = options;
        }

        // Add the column metadata to the columns array
        upsertByName(columns, columnDefinition);
    };
}
