import { BaseModel } from '../model/BaseModel';

export interface EntityOptions {
    //TODO: add more options as needed
}

/**
 * Decorator for defining the entity (table) with a name and options.
 *
 * @param {string} name The name of the entity (table).
 * @param {EntityOptions} options Options for the entity, like synchronize.
 * @returns {ClassDecorator} The class decorator.
 */
export function Entity(name: string, options: EntityOptions = {}): ClassDecorator {
    return function (constructor: unknown) {
        const baseConstructor = constructor as typeof BaseModel;
        baseConstructor.tableName = name;
        baseConstructor.entityOptions = options;
    };
}
