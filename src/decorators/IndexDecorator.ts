import { BaseModel } from '../model/BaseModel';
import { ownMetadataArray, upsertByName } from './metadata-utils';

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

        // Get the indexes array this class owns, seeded from any inherited indexes
        const indexes = ownMetadataArray<IndexDefinition>(baseConstructor, 'indexes');

        upsertByName(indexes, {
            name,
            column,
        });
    };
}
