// Exporting the DataSource class for managing database connections
export { DataSource, PagedResult } from './data-source/DataSource';

// Exporting the Repository class for handling CRUD operations
export { Repository } from './repository/Repository';

// Export the schema builders, so callers can generate or inspect DDL without a connection
export { buildCreateTable, buildCreateIndexes, buildSchema } from './schema';

// Export operators and interfaces for defining query conditions
export {
    In,
    LessThan,
    LessThanOrEqual,
    MoreThan,
    MoreThanOrEqual,
    GreaterThan,
    GreaterThanOrEqual,
    Between,
    Contains,
    ContainsKey,
} from './repository/query-utils';

// Export the query and result types used by the Repository API
export {
    BatchStatement,
    BindableValue,
    Condition,
    FindOptions,
    NestedConditions,
    OperatorType,
    OrderByOption,
    Page,
    RawQueryOptions,
    RawQueryParams,
    RawRow,
    SimpleConditionValue,
    WriteOptions,
} from './repository/query-utils';

// Exporting the BaseModel class that all models should extend
export { BaseModel } from './model/BaseModel';

// Export the error types, so callers can map bad input to a response instead of matching on messages
export {
    ScyllormError,
    UnknownColumnError,
    InvalidQueryError,
    QueryFailedError,
    EntityNotFoundError,
    ColumnValidationError,
} from './errors';
export type { UnknownColumnDetails, EntityNotFoundDetails, ColumnValidationDetails } from './errors';

// Exporting the Column, Table, and PrimaryKey decorators for defining model structures
export { Column } from './decorators/Column';
export type { ColumnType, ColumnOptions } from './decorators/Column';
export type { PrimaryKeyColumnType, PrimaryKeyColumnOptions } from './decorators/PrimaryKey';
export { Table } from './decorators/Table';
export { PrimaryKeyColumn } from './decorators/PrimaryKey';
export { Index } from './decorators/IndexDecorator';
export { Entity } from './decorators/Entity';
