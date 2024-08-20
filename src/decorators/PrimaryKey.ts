import { BaseModel } from '../model/BaseModel';

export type PrimaryKeyColumnType = 'INT' | 'UUID' | 'TEXT';

export interface PrimaryKeyColumnOptions {
    default?: unknown; // Default value for the column
    partitionKey?: boolean; // Whether the column is a partition key
    clusteringKey?: boolean; // Whether the column is a clustering key
}

/**
 * Decorator for defining a column in a table.
 *
 * @param {ColumnType} type The type of the column.
 * @param {ColumnOptions} options Additional options for the column.
 * @returns {PropertyDecorator} The property decorator.
 */
export function PrimaryKeyColumn(type: PrimaryKeyColumnType, options?: PrimaryKeyColumnOptions): PropertyDecorator {
    return function (target: object, propertyName: string | symbol) {
        const constructor = target.constructor as typeof BaseModel;

        // Ensure the primaryKeys array is initialized
        if (!constructor.primaryKeys) {
            constructor.primaryKeys = [];
        }

        // Ensure the columns array is initialized
        if (!constructor.columns) {
            constructor.columns = [];
        }

        // Convert the property key to a string
        const columnName = propertyName.toString();

        // Create the base primary key definition
        const primaryKeyDefinition = {
            name: columnName,
            type, // Use the type provided to the decorator
        } as { name: string; type: PrimaryKeyColumnType; options?: PrimaryKeyColumnOptions };

        // Create the base column definition
        const columnDefinition = {
            name: columnName,
            type, // Use the type provided to the decorator
        } as { name: string; type: PrimaryKeyColumnType; options?: PrimaryKeyColumnOptions };

        // Conditionally add options if they are provided
        if (options) {
            primaryKeyDefinition.options = options;
            columnDefinition.options = options;
        }

        // Add the primary key metadata to the primaryKeys array
        constructor.primaryKeys.push(primaryKeyDefinition);

        // Add the column metadata to the columns array
        constructor.columns.push(columnDefinition);
    };
}
