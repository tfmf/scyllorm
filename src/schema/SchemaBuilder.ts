import { BaseModel } from '../model/BaseModel';
import { ColumnType, ColumnOptions, UserDefinedType, UserDefinedTypeField } from '../decorators/Column';
import { columnName } from '../decorators/metadata-utils';
import { InvalidQueryError, UnknownColumnError } from '../errors';

/**
 * The only shape an identifier may take before it is interpolated into DDL.
 *
 * CQL cannot parameterize identifiers, so this whitelist — not escaping — is
 * the injection barrier for every table, column and index name emitted here.
 */
const SCHEMA_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

/** A table name: a schema identifier, optionally qualified by its keyspace (`keyspace.table`). */
const TABLE_IDENTIFIER = /^([A-Za-z][A-Za-z0-9_]*\.)?[A-Za-z][A-Za-z0-9_]*$/;

/** A UDT field name: lowercase, because the driver matches written object keys to the folded names exactly. */
const UDT_FIELD_NAME = /^[a-z][a-z0-9_]*$/;

/** Collection types, which need an element type from `options.of` to render. */
const COLLECTION_TYPES: ReadonlySet<string> = new Set(['LIST', 'SET', 'MAP']);

/** Types the builder cannot express; tables using them must be created manually. */
const UNSUPPORTED_TYPES: ReadonlySet<string> = new Set(['TUPLE', 'FROZEN']);

/**
 * Asserts an identifier is safe to interpolate into DDL, or throws.
 *
 * @param {string} kind What the identifier names: 'table', 'column' or 'index'.
 * @param {string} identifier The identifier to check.
 * @param {string} entity The name of the entity class the schema is built for.
 * @returns {string} The identifier, unchanged.
 */
function assertIdentifier(kind: string, identifier: string, entity: string): string {
    const pattern = kind === 'table' ? TABLE_IDENTIFIER : SCHEMA_IDENTIFIER;

    if (!pattern.test(identifier)) {
        throw InvalidQueryError.invalidSchemaIdentifier(kind, identifier, entity);
    }

    return identifier;
}

/**
 * Resolves the name of the user-defined type a column or field refers to.
 *
 * @param {string | UserDefinedType | undefined} udt The `udt` option.
 * @param {string} column The column (or `type.field`) being rendered.
 * @param {string} entity The name of the entity class the schema is built for.
 * @returns {string} The type name, as written.
 * @throws {InvalidQueryError} If there is no `udt`, or its name is not a schema identifier.
 */
function udtName(udt: string | UserDefinedType | undefined, column: string, entity: string): string {
    if (udt === undefined) {
        throw InvalidQueryError.missingUdt(column, entity);
    }

    return assertIdentifier('type', typeof udt === 'string' ? udt : udt.name, entity);
}

/**
 * Renders a collection element type, which must be scalar or a UDT — a
 * collection, TUPLE or FROZEN element cannot be expressed without frozen<>
 * semantics the builder does not model. UDT elements are always frozen.
 *
 * @param {unknown} element The declared element type.
 * @param {string} column The collection column being rendered.
 * @param {string} entity The name of the entity class the schema is built for.
 * @param {string | UserDefinedType} [udt] The column's `udt` option, for `'UDT'` elements.
 * @returns {string} The lowercase CQL type name.
 */
function renderElementType(element: unknown, column: string, entity: string, udt?: string | UserDefinedType): string {
    if (element === 'UDT') {
        return `frozen<${udtName(udt, column, entity)}>`;
    }

    if (typeof element !== 'string' || COLLECTION_TYPES.has(element) || UNSUPPORTED_TYPES.has(element)) {
        throw InvalidQueryError.unsupportedSchemaType(column, entity, String(element));
    }

    return element.toLowerCase();
}

/**
 * Renders the CQL type of a column definition.
 *
 * @param {string} name The column name, for error reporting.
 * @param {ColumnType} type The declared column type.
 * @param {ColumnOptions | undefined} options The column options, read for `of`, `udt` and `frozen`.
 * @param {string} entity The name of the entity class the schema is built for.
 * @returns {string} The CQL type, e.g. `text`, `list<text>` or `map<text, int>`.
 */
function renderType(name: string, type: ColumnType, options: ColumnOptions | undefined, entity: string): string {
    if (UNSUPPORTED_TYPES.has(type)) {
        throw InvalidQueryError.unsupportedSchemaType(name, entity, type);
    }

    if (type === 'LIST' || type === 'SET') {
        if (typeof options?.of !== 'string') {
            throw InvalidQueryError.missingCollectionElementType(name, entity, type);
        }

        return `${type.toLowerCase()}<${renderElementType(options.of, name, entity, options.udt)}>`;
    }

    if (type === 'MAP') {
        if (!Array.isArray(options?.of) || options.of.length !== 2) {
            throw InvalidQueryError.missingCollectionElementType(name, entity, type);
        }

        const [key, value] = options.of;

        return `map<${renderElementType(key, name, entity, options?.udt)}, ${renderElementType(value, name, entity, options?.udt)}>`;
    }

    if (type === 'UDT') {
        const rendered = udtName(options?.udt, name, entity);

        if (options?.frozen !== false) {
            return `frozen<${rendered}>`;
        }

        // Refused by the server, but only at CREATE TABLE — after the type was created, or after
        // alter added the collection field, which no ALTER TYPE can take back
        const udt = options.udt;
        const hasCollection =
            typeof udt === 'object' &&
            Object.values(udt.fields).some((spec) =>
                COLLECTION_TYPES.has(typeof spec === 'string' ? spec : spec?.type)
            );

        if (hasCollection) {
            throw InvalidQueryError.unsupportedSchemaType(name, entity, 'non-frozen UDT with a collection field');
        }

        return rendered;
    }

    return type.toLowerCase();
}

/**
 * Lists the user-defined type objects a column or field refers to. A string
 * `udt` names a type managed elsewhere and is never created, so it is skipped.
 *
 * @param {ColumnType} type The declared type.
 * @param {ColumnOptions['of']} of The declared element type(s).
 * @param {string | UserDefinedType} [udt] The `udt` option.
 * @returns {UserDefinedType[]} Zero or one definition object.
 */
function referencedUdts(type: ColumnType, of: ColumnOptions['of'], udt?: string | UserDefinedType): UserDefinedType[] {
    const holdsUdt = type === 'UDT' || of === 'UDT' || (Array.isArray(of) && of.includes('UDT'));

    return holdsUdt && typeof udt === 'object' ? [udt] : [];
}

/**
 * Renders the fields of a user-defined type as `[name, cqlType]` pairs.
 *
 * @param {UserDefinedType} udt The type definition.
 * @param {string} entity The name of the entity class the schema is built for.
 * @returns {Array<[string, string]>} The fields, in declaration order.
 * @throws {InvalidQueryError} If the type has no fields, a field name is not lowercase snake case,
 *   or a field has an unsupported type.
 */
function renderFields(udt: UserDefinedType, entity: string): Array<[string, string]> {
    const names = Object.keys(udt.fields);

    if (names.length === 0) {
        throw InvalidQueryError.emptyUdt(udt.name, entity);
    }

    return names.map((field) => {
        // A field named after an Object.prototype member (`constructor`) would read the inherited
        // member whenever a written object leaves it out, which the driver then fails to encode; and
        // a value owning `operator` reads as an operator object when used as a condition
        if (!UDT_FIELD_NAME.test(field) || field in Object.prototype || field === 'operator') {
            throw InvalidQueryError.invalidSchemaIdentifier('field', field, entity);
        }

        const spec = udt.fields[field];
        const { type, of, udt: nested }: UserDefinedTypeField = typeof spec === 'string' ? { type: spec } : spec;
        const label = `${udt.name}.${field}`;

        // A counter cannot live inside a type; the server's message would not name the field
        if (type === 'COUNTER') {
            throw InvalidQueryError.unsupportedSchemaType(label, entity, type);
        }

        // `frozen` is left at its default, so a nested UDT always renders frozen<>
        return [field, renderType(label, type, { of, udt: nested }, entity)];
    });
}

/**
 * Builds the `CREATE TABLE IF NOT EXISTS` statement for an entity.
 *
 * Partition keys are the primary keys declared with `partitionKey: true`,
 * clustering keys those with `clusteringKey: true`, both in declaration order.
 * A `WITH CLUSTERING ORDER BY` clause is appended only when at least one
 * clustering key declares an `order`; unspecified keys render `ASC` there.
 * Columns render under their `name` option when they declare one, and a
 * `static: true` column renders `STATIC`, which needs a clustering key.
 *
 * @param {typeof BaseModel} entity The entity class to build the table for.
 * @returns {string} The CREATE TABLE statement.
 */
export function buildCreateTable(entity: typeof BaseModel): string {
    const entityName = entity.name;
    const table = assertIdentifier('table', entity.getTableName(), entityName);
    const primaryKeys = entity.getPrimaryKeys();

    // Every key must land in exactly one part of the PRIMARY KEY. A key with
    // neither flag would silently render as a plain column — a table whose key
    // structure disagrees with the entity's own metadata — and one with both
    // would render twice, DDL the server rejects a round trip away.
    for (const key of primaryKeys) {
        const isPartition = key.options?.partitionKey === true;
        const isClustering = key.options?.clusteringKey === true;

        if (isPartition === isClustering) {
            throw InvalidQueryError.ambiguousPrimaryKeyRole(key.name, entityName, isPartition);
        }
    }

    const partitionKeys = primaryKeys.filter((key) => key.options?.partitionKey === true);
    const clusteringKeys = primaryKeys.filter((key) => key.options?.clusteringKey === true);

    if (partitionKeys.length === 0) {
        throw InvalidQueryError.missingPartitionKey(entityName);
    }

    const definitions = (entity.columns ?? []).map((column) => {
        const definition =
            `${assertIdentifier('column', columnName(column), entityName)} ` +
            renderType(column.name, column.type, column.options, entityName);

        if (column.options?.static !== true) {
            return definition;
        }

        // Checked locally: the server refuses it, with a message that names no entity
        if (clusteringKeys.length === 0) {
            throw InvalidQueryError.staticWithoutClustering(column.name, entityName);
        }

        return `${definition} STATIC`;
    });

    const partition = partitionKeys.map((key) => assertIdentifier('column', columnName(key), entityName));
    const clustering = clusteringKeys.map((key) => assertIdentifier('column', columnName(key), entityName));
    const partitionPart = partition.length === 1 ? partition[0] : `(${partition.join(', ')})`;
    const primaryKey = `PRIMARY KEY (${[partitionPart, ...clustering].join(', ')})`;

    let statement = `CREATE TABLE IF NOT EXISTS ${table} (${[...definitions, primaryKey].join(', ')})`;

    if (clusteringKeys.some((key) => key.options?.order !== undefined)) {
        const ordering = clusteringKeys.map((key) => {
            const order = key.options?.order ?? 'ASC';

            if (order !== 'ASC' && order !== 'DESC') {
                throw InvalidQueryError.invalidDirection(order, key.name, entityName);
            }

            return `${columnName(key)} ${order}`;
        });

        statement += ` WITH CLUSTERING ORDER BY (${ordering.join(', ')})`;
    }

    return statement;
}

/**
 * Builds one `CREATE INDEX IF NOT EXISTS` statement per `@Index` on the entity.
 *
 * Every index column is whitelisted against the entity's declared columns —
 * a name that is not on the list never reaches the server.
 *
 * @param {typeof BaseModel} entity The entity class to build the indexes for.
 * @returns {string[]} The CREATE INDEX statements, in declaration order.
 */
export function buildCreateIndexes(entity: typeof BaseModel): string[] {
    const entityName = entity.name;
    const table = assertIdentifier('table', entity.getTableName(), entityName);
    const knownColumns = (entity.columns ?? []).map((column) => column.name);

    return entity.getIndexes().map((index) => {
        if (!knownColumns.includes(index.column)) {
            throw new UnknownColumnError({
                column: index.column,
                entity: entityName,
                table,
                knownColumns,
            });
        }

        const name = assertIdentifier('index', index.name, entityName);
        // `@Index` names the property, like every other API; the DDL needs the column's database name
        const definition = (entity.columns ?? []).find((column) => column.name === index.column);
        const column = assertIdentifier('column', definition ? columnName(definition) : index.column, entityName);

        return `CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${column})`;
    });
}

/** A user-defined type to create for an entity, with what the diff and the dedupe need. */
export interface TypePlan {
    /** The definition object. */
    udt: UserDefinedType;
    /** The type name, as written. */
    name: string;
    /** `keyspace.` when the entity's table is keyspace-qualified, else empty. */
    prefix: string;
    /** `prefix + name`, case-folded: the type's identity. */
    qualified: string;
    /** The rendered field list, `(f1 t1, f2 t2)`: two types with one identity must agree on it. */
    definition: string;
    /** The `CREATE TYPE IF NOT EXISTS` statement. */
    statement: string;
}

/**
 * Plans the user-defined types an entity needs, dependencies before dependents.
 *
 * Walks the columns in declaration order, then each type's fields depth first.
 * A type reached twice under one case-folded name is created once.
 *
 * @param {typeof BaseModel} entity The entity class to plan the types for.
 * @returns {TypePlan[]} The types to create, in creation order.
 * @throws {InvalidQueryError} If a type is invalid, defined two ways, or contains itself.
 */
export function planTypes(entity: typeof BaseModel): TypePlan[] {
    const entityName = entity.name;
    const roots = (entity.columns ?? []).flatMap((column) =>
        referencedUdts(column.type, column.options?.of, column.options?.udt)
    );

    if (roots.length === 0) {
        return [];
    }

    // A table may only use types of its own keyspace, so the types follow the table's qualifier
    const table = assertIdentifier('table', entity.getTableName(), entityName);
    const prefix = table.includes('.') ? table.slice(0, table.indexOf('.') + 1) : '';
    const plans = new Map<string, TypePlan>();
    const visiting = new Set<string>();

    const visit = (udt: UserDefinedType): void => {
        const name = assertIdentifier('type', udt.name, entityName);
        const qualified = `${prefix}${name}`.toLowerCase();

        if (visiting.has(qualified)) {
            throw InvalidQueryError.recursiveUdt(name, entityName);
        }

        const definition = `(${renderFields(udt, entityName)
            .map(([field, type]) => `${field} ${type}`)
            .join(', ')})`;

        visiting.add(qualified);

        for (const spec of Object.values(udt.fields)) {
            if (typeof spec === 'object') {
                referencedUdts(spec.type, spec.of, spec.udt).forEach(visit);
            }
        }

        visiting.delete(qualified);

        const existing = plans.get(qualified);

        if (existing === undefined) {
            // Set after the fields' own types, which makes the map order dependencies-first
            plans.set(qualified, {
                udt,
                name,
                prefix,
                qualified,
                definition,
                statement: `CREATE TYPE IF NOT EXISTS ${prefix}${name} ${definition}`,
            });
        } else if (existing.definition.toLowerCase() !== definition.toLowerCase()) {
            throw InvalidQueryError.conflictingUdt(name, entityName);
        }
    };

    roots.forEach(visit);

    return [...plans.values()];
}

/**
 * Builds the `CREATE TYPE IF NOT EXISTS` statements for the user-defined types
 * an entity's columns reference by definition object.
 *
 * Types come dependencies first and once each (by case-folded name). A type
 * named by a string is managed elsewhere and never created. Field names must be
 * lowercase snake case: the driver silently drops written keys that do not
 * match a folded field name.
 *
 * @param {typeof BaseModel} entity The entity class to build the types for.
 * @returns {string[]} The CREATE TYPE statements, in execution order.
 * @throws {InvalidQueryError} If a type is invalid, defined two ways, or contains itself.
 */
export function buildCreateTypes(entity: typeof BaseModel): string[] {
    return planTypes(entity).map((plan) => plan.statement);
}

/**
 * Builds the full schema for an entity: its types, then the table, then its indexes.
 *
 * @param {typeof BaseModel} entity The entity class to build the schema for.
 * @returns {string[]} The DDL statements, in execution order.
 */
export function buildSchema(entity: typeof BaseModel): string[] {
    return [...buildCreateTypes(entity), buildCreateTable(entity), ...buildCreateIndexes(entity)];
}

/** What a schema diff found: DDL to run, and differences it will not touch. */
export interface SchemaDiff {
    /** `ALTER` statements to run, in order. */
    statements: string[];
    /** Differences that are reported but never changed. */
    warnings: string[];
}

/** A row of `system_schema.columns`, as far as the diff reads it. */
export interface ExistingColumn {
    column_name: string;
    kind: string;
    type: string;
}

/** The row of `system_schema.types` for one type. */
export interface ExistingType {
    field_names: string[];
    field_types: string[];
}

/**
 * Normalizes a CQL type for comparison: the server renders varchar as text and
 * its own spacing, so case, whitespace and that alias are ignored.
 *
 * @param {string} type A CQL type, as rendered here or read from `system_schema`.
 * @returns {string} The comparable form.
 */
function normalizeType(type: string): string {
    return type
        .toLowerCase()
        .replace(/\bvarchar\b/g, 'text')
        .replace(/\s+/g, '');
}

/**
 * Diffs a user-defined type against the live one: a missing field is added,
 * everything else that differs is only reported.
 *
 * @param {UserDefinedType} udt The declared type.
 * @param {string} keyspacePrefix `keyspace.` for a qualified table, else empty.
 * @param {ExistingType | undefined} existing The live type, or undefined if it could not be read.
 * @param {string} entity The name of the entity class being synchronized.
 * @returns {SchemaDiff} The ALTER TYPE statements and the warnings.
 */
export function diffType(
    udt: UserDefinedType,
    keyspacePrefix: string,
    existing: ExistingType | undefined,
    entity: string
): SchemaDiff {
    const diff: SchemaDiff = { statements: [], warnings: [] };

    if (existing === undefined) {
        diff.warnings.push(`Entity ${entity}: type ${udt.name} could not be read from the schema; not altered.`);

        return diff;
    }

    // Live names are kept as stored: system_schema already folds unquoted names, so one with
    // capitals belongs to a quoted identifier, which is not the field this ORM writes
    const live = new Map(existing.field_names.map((field, i) => [field, existing.field_types[i]]));
    const declared = renderFields(udt, entity);

    for (const [field, type] of declared) {
        const current = live.get(field);

        if (current === undefined) {
            diff.statements.push(`ALTER TYPE ${keyspacePrefix}${udt.name} ADD ${field} ${type}`);
        } else if (normalizeType(current) !== normalizeType(type)) {
            diff.warnings.push(
                `Entity ${entity}: field ${field} of type ${udt.name} is ${current} in the database ` +
                    `but declared as ${type}; not altered.`
            );
        }
    }

    for (const field of live.keys()) {
        if (!declared.some(([name]) => name === field)) {
            diff.warnings.push(
                `Entity ${entity}: field ${field} of type ${udt.name} exists in the database but is not declared; kept.`
            );
        }
    }

    return diff;
}

/**
 * Diffs an entity's table against the live columns: a missing column is added,
 * everything else that differs is only reported. Key columns cannot be altered.
 *
 * @param {typeof BaseModel} entity The entity class being synchronized.
 * @param {ExistingColumn[]} existing The live rows of `system_schema.columns`.
 * @returns {SchemaDiff} The ALTER TABLE statements and the warnings.
 */
export function diffTable(entity: typeof BaseModel, existing: ExistingColumn[]): SchemaDiff {
    const entityName = entity.name;
    const table = assertIdentifier('table', entity.getTableName(), entityName);
    const diff: SchemaDiff = { statements: [], warnings: [] };

    if (existing.length === 0) {
        diff.warnings.push(`Entity ${entityName}: table ${table} could not be read from the schema; not altered.`);

        return diff;
    }

    // Kept as stored, like diffType's fields: a capitalised live name is a quoted identifier,
    // never the unquoted one the entity emits
    const live = new Map(existing.map((row) => [row.column_name, row]));
    const declared = new Set<string>();

    for (const column of entity.columns ?? []) {
        const name = assertIdentifier('column', columnName(column), entityName);
        const folded = name.toLowerCase();
        const type = renderType(column.name, column.type, column.options, entityName);
        const key = entity.getPrimaryKeys().find((candidate) => candidate.name === column.name);
        const kind = key
            ? key.options?.partitionKey === true
                ? 'partition_key'
                : 'clustering'
            : column.options?.static === true
              ? 'static'
              : 'regular';
        const current = live.get(folded);

        declared.add(folded);

        if (current === undefined) {
            if (key) {
                diff.warnings.push(
                    `Entity ${entityName}: key column ${name} of table ${table} is missing in the database; ` +
                        'keys cannot be altered.'
                );
            } else {
                diff.statements.push(`ALTER TABLE ${table} ADD ${name} ${type}${kind === 'static' ? ' STATIC' : ''}`);
            }

            continue;
        }

        if (normalizeType(current.type) !== normalizeType(type)) {
            diff.warnings.push(
                `Entity ${entityName}: column ${name} of table ${table} is ${current.type} in the database ` +
                    `but declared as ${type}; not altered.`
            );
        }

        if (current.kind !== kind) {
            diff.warnings.push(
                `Entity ${entityName}: column ${name} of table ${table} is ${current.kind} in the database ` +
                    `but declared as ${kind}; not altered.`
            );
        }
    }

    for (const name of live.keys()) {
        if (!declared.has(name)) {
            diff.warnings.push(
                `Entity ${entityName}: column ${name} of table ${table} exists in the database but is not declared; kept.`
            );
        }
    }

    return diff;
}
