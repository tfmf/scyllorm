// Condition type that will be used in the find method
export type SimpleConditionValue = string | number | boolean | Buffer;

// Supported operators for the condition https://opensource.docs.scylladb.com/stable/cql/dml/select.html#select
export type OperatorType = 'IN' | '=' | '<' | '<=' | '>' | '>=';

export interface Condition {
    operator: OperatorType;
    value: SimpleConditionValue | SimpleConditionValue[];
}

export interface NestedConditions {
    [key: string]: Condition | SimpleConditionValue | NestedConditions;
}

export interface OrderByOption {
    column: string;
    direction?: 'ASC' | 'DESC';
}

export interface FindOptions {
    where: NestedConditions;
    orderBy?: { [column: string]: 'ASC' | 'DESC' };
}

// Utility functions for various operations
export function In<T extends SimpleConditionValue>(values: T[]): Condition {
    return {
        operator: 'IN',
        value: values,
    };
}

export function LessThan<T extends SimpleConditionValue>(value: T): Condition {
    return {
        operator: '<',
        value,
    };
}

export function LessThanOrEqual<T extends SimpleConditionValue>(value: T): Condition {
    return {
        operator: '<=',
        value,
    };
}

export function MoreThan<T extends SimpleConditionValue>(value: T): Condition {
    return {
        operator: '>',
        value,
    };
}

export function MoreThanOrEqual<T extends SimpleConditionValue>(value: T): Condition {
    return {
        operator: '>=',
        value,
    };
}
