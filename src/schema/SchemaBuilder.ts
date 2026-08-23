import { BaseModel } from '../model/BaseModel';
import { ColumnType, ColumnOptions } from '../decorators/Column';
import { InvalidQueryError, UnknownColumnError } from '../errors';

/**
 * The only shape an identifier may take before it is interpolated into DDL.
 *
 * CQL cannot parameterize identifiers, so this whitelist — not escaping — is
 * the injection barrier for every table, column and index name emitted here.
 */
const SCHEMA_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
    if (!SCHEMA_IDENTIFIER.test(identifier)) {
        throw InvalidQueryError.invalidSchemaIdentifier(kind, identifier, entity);
    }

    return identifier;
}

/**
 * Renders a collection element type, which must be scalar — a collection,
 * TUPLE or FROZEN element cannot be expressed without frozen<> semantics the
 * builder does not model.
 *
 * @param {unknown} element The declared element type.
 * @param {string} column The collection column being rendered.
 * @param {string} entity The name of the entity class the schema is built for.
 * @returns {string} The lowercase CQL type name.
 */
function renderElementType(element: unknown, column: string, entity: string): string {
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
 * @param {ColumnOptions | undefined} options The column options, read for `of`.
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

        return `${type.toLowerCase()}<${renderElementType(options.of, name, entity)}>`;
    }

    if (type === 'MAP') {
        if (!Array.isArray(options?.of) || options.of.length !== 2) {
            throw InvalidQueryError.missingCollectionElementType(name, entity, type);
        }

        const [key, value] = options.of;

        return `map<${renderElementType(key, name, entity)}, ${renderElementType(value, name, entity)}>`;
    }

    return type.toLowerCase();
}

/**
 * Builds the `CREATE TABLE IF NOT EXISTS` statement for an entity.
 *
 * Partition keys are the primary keys declared with `partitionKey: true`,
 * clustering keys those with `clusteringKey: true`, both in declaration order.
 * A `WITH CLUSTERING ORDER BY` clause is appended only when at least one
 * clustering key declares an `order`; unspecified keys render `ASC` there.
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

    const definitions = (entity.columns ?? []).map(
        (column) =>
            `${assertIdentifier('column', column.name, entityName)} ` +
            renderType(column.name, column.type, column.options, entityName)
    );

    const partition = partitionKeys.map((key) => assertIdentifier('column', key.name, entityName));
    const clustering = clusteringKeys.map((key) => assertIdentifier('column', key.name, entityName));
    const partitionPart = partition.length === 1 ? partition[0] : `(${partition.join(', ')})`;
    const primaryKey = `PRIMARY KEY (${[partitionPart, ...clustering].join(', ')})`;

    let statement = `CREATE TABLE IF NOT EXISTS ${table} (${[...definitions, primaryKey].join(', ')})`;

    if (clusteringKeys.some((key) => key.options?.order !== undefined)) {
        const ordering = clusteringKeys.map((key) => {
            const order = key.options?.order ?? 'ASC';

            if (order !== 'ASC' && order !== 'DESC') {
                throw InvalidQueryError.invalidDirection(order, key.name, entityName);
            }

            return `${key.name} ${order}`;
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
        const column = assertIdentifier('column', index.column, entityName);

        return `CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${column})`;
    });
}

/**
 * Builds the full schema for an entity: the table first, then its indexes.
 *
 * @param {typeof BaseModel} entity The entity class to build the schema for.
 * @returns {string[]} The DDL statements, in execution order.
 */
export function buildSchema(entity: typeof BaseModel): string[] {
    return [buildCreateTable(entity), ...buildCreateIndexes(entity)];
}
