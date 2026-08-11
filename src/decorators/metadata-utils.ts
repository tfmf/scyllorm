/**
 * Shared metadata helpers for the decorators.
 *
 * Internal — not re-exported from `src/decorators/index.ts` or `src/index.ts`.
 */

/**
 * Get the metadata array this class owns, seeding it from the inherited one.
 *
 * Decorators must not push into an array they inherited, or a subclass would
 * mutate its parent's metadata. Creating an empty array instead loses every
 * inherited definition, so the own array is seeded with a copy of the parent's.
 *
 * @param {object} target The class constructor holding the metadata.
 * @param {string} key The name of the metadata property.
 * @returns {T[]} The array owned by this class, safe to mutate.
 */
export function ownMetadataArray<T>(target: object, key: string): T[] {
    const holder = target as Record<string, T[] | undefined>;

    if (!Object.prototype.hasOwnProperty.call(target, key)) {
        holder[key] = [...(holder[key] ?? [])];
    }

    return holder[key] as T[];
}

/**
 * Add a definition to the list, replacing any existing entry with the same name.
 *
 * A subclass that redeclares an inherited property overrides it rather than
 * adding a duplicate — two entries for one name would make `save()` emit the
 * same column twice.
 *
 * @param {T[]} list The metadata array to add to.
 * @param {T} definition The definition to add or replace.
 * @returns {void}
 */
export function upsertByName<T extends { name: string }>(list: T[], definition: T): void {
    const existing = list.findIndex((item) => item.name === definition.name);

    if (existing === -1) {
        list.push(definition);
    } else {
        list[existing] = definition;
    }
}
