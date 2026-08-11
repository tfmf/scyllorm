// Exporting the DataSource class for managing database connections
export { DataSource, PagedResult } from './data-source/DataSource';

// Exporting the Repository class for handling CRUD operations
export { Repository } from './repository/Repository';

// Export operators and interfaces for defining query conditions
export {
    In,
    LessThan,
    LessThanOrEqual,
    MoreThan,
    MoreThanOrEqual,
    GreaterThan,
    GreaterThanOrEqual,
} from './repository/query-utils';

// Export the query and result types used by the Repository API
export {
    Condition,
    FindOptions,
    NestedConditions,
    OperatorType,
    OrderByOption,
    Page,
    SimpleConditionValue,
} from './repository/query-utils';

// Exporting the BaseModel class that all models should extend
export { BaseModel } from './model/BaseModel';

// Export the error types, so callers can map bad input to a response instead of matching on messages
export { ScyllormError, UnknownColumnError, InvalidQueryError, UnknownColumnDetails } from './errors';

// Exporting the Column, Table, and PrimaryKey decorators for defining model structures
export { Column } from './decorators/Column';
export { Table } from './decorators/Table';
export { PrimaryKeyColumn } from './decorators/PrimaryKey';
export { Index } from './decorators/IndexDecorator';
export { Entity } from './decorators/Entity';
