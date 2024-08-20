import { BaseModel } from '../model/BaseModel';

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
    | 'INET'
    | 'INT'
    | 'SMALLINT'
    | 'TINYINT'
    | 'TIME'
    | 'TIMESTAMP'
    | 'TIMEUUID'
    | 'TEXT'
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

        // Ensure the columns array is initialized
        if (!constructor.columns) {
            constructor.columns = [];
        }

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
        constructor.columns.push(columnDefinition);
    };
}
