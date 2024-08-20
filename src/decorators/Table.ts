import { BaseModel } from '../model/BaseModel';

/**
 * Decorator for defining the table name of a model.
 *
 * @param {string} options.name The name of the table.
 * @returns {ClassDecorator} The class decorator.
 */
export function Table(options: { name: string }): ClassDecorator {
    return function (constructor: unknown) {
        const baseConstructor = constructor as typeof BaseModel;
        baseConstructor.tableName = options.name;
    };
}
