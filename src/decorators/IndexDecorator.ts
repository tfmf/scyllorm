import { BaseModel } from '../model/BaseModel';

export interface IndexDefinition {
    name: string;
    column: string;
}

/**
 * Decorator for defining an index on a table.
 *
 * @param {string[]} keys The keys to include in the index.
 * @returns {ClassDecorator} The class decorator.
 */
export function Index<T extends typeof BaseModel>(name: string, column: string): ClassDecorator {
    return function (constructor: unknown) {
        const baseConstructor = constructor as T;

        if (!baseConstructor.indexes) {
            baseConstructor.indexes = [];
        }

        baseConstructor.indexes.push({
            name,
            column,
        });
    };
}
