import { Entity } from './Entity';

/**
 * Decorator for defining the table name of a model.
 *
 * @deprecated Use `Entity(name, options)` instead.
 *
 * @param {Object} options The options object containing the name of the table.
 * @returns {ClassDecorator} The class decorator.
 */
export function Table(options: { name: string }): ClassDecorator {
    console.warn(
        `The 'Table' decorator is deprecated and will be removed in a future version. Please use 'Entity(name, options)' instead.`
    );

    // Forward the arguments to the new `@Entity` decorator
    return Entity(options.name, {});
}
