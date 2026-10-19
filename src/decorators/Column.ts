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
    | 'UDT'
    | 'UUID'
    | 'VARINT'
    | 'VARCHAR';

/**
 * Converts a column's value between the shape the entity holds and the shape
 * the database stores — JSON in a TEXT column, an enum as an INT.
 *
 * Neither function is ever called with `null` or `undefined`: those keep
 * meaning "delete the cell" and "leave it unset" on write, and "no value" on read.
 */
export interface ColumnTransformer {
    /**
     * Entity value to database value. Runs on every value written to the
     * column and on every `where` value compared against it (equality,
     * comparisons, `IN` elements, `BETWEEN` ends), but not on `Contains()`,
     * `ContainsKey()` or collection-update operands. The type check and
     * `validate` see its result.
     */
    to(value: unknown): unknown;
    /** Database value to entity value. Runs on every non-null value read, after the built-in conversion. */
    from(value: unknown): unknown;
}

/** One field of a {@link UserDefinedType}: a bare type, or a type with the options it needs. */
export interface UserDefinedTypeField {
    /** The field's CQL type. COUNTER, TUPLE and FROZEN are not supported. */
    type: ColumnType;
    /** Element type for a LIST, SET or MAP field, as in {@link ColumnOptions.of}. */
    of?: ColumnType | [ColumnType, ColumnType];
    /** The type a `'UDT'` field (or a collection of them) names, as in {@link ColumnOptions.udt}. Always frozen. */
    udt?: string | UserDefinedType;
}

/**
 * A user-defined type, created by `synchronize()` as `CREATE TYPE IF NOT EXISTS`.
 *
 * Field names must be lowercase (`/^[a-z][a-z0-9_]*$/`): the driver matches the
 * keys of a written object to the folded field names exactly and silently drops
 * the rest.
 */
export interface UserDefinedType {
    /** The type's name: an unqualified schema identifier. */
    name: string;
    /** The fields, in declaration order; a string is shorthand for `{ type }`. */
    fields: Record<string, ColumnType | UserDefinedTypeField>;
}

export interface ColumnOptions {
    default?: unknown; // Default value for the column
    /**
     * The column's name in the database, when it differs from the property's —
     * a camelCase model over a snake_case table. Every API call still takes the
     * property name; only the CQL uses this one. Must be an unquoted CQL
     * identifier.
     */
    name?: string;
    /** Converts the value on write and on read; see {@link ColumnTransformer}. */
    transformer?: ColumnTransformer;
    /**
     * Declare the column `STATIC`: one value shared by every row of a
     * partition. Only affects `synchronize()`/`buildCreateTable()`, which
     * require the entity to have a clustering key.
     */
    static?: boolean;
    /**
     * Element type for collection columns, used when generating schema.
     *
     * A single type for LIST and SET (`{ of: 'TEXT' }` → `list<text>`), a
     * `[key, value]` pair for MAP (`{ of: ['TEXT', 'INT'] }` → `map<text, int>`).
     * Element types must be scalar — nested collections are not supported.
     */
    of?: ColumnType | [ColumnType, ColumnType];
    /**
     * The user-defined type of a `'UDT'` column, or of the `'UDT'` elements of a
     * LIST/SET/MAP column (one `udt` applies to every `'UDT'` element).
     *
     * A string names a type managed outside the ORM, which `synchronize()` does
     * not create; an object is created by `synchronize()`.
     */
    udt?: string | UserDefinedType;
    /**
     * Whether a `'UDT'` column renders `frozen<type>`. Defaults to true; `false`
     * renders the bare type name, which the server rejects for types with
     * collection fields. Collection elements are always frozen.
     */
    frozen?: boolean;
    /**
     * Custom validator run on write, after the type check, only on non-null,
     * non-undefined values.
     *
     * Return `true` to accept, `false` to reject with a generic message, or a
     * string to reject with that string as the reason. The reason is carried on
     * the thrown `ColumnValidationError`, so never put the value itself in it.
     */
    validate?: (value: unknown) => boolean | string;
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
