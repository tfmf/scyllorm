import { PrimaryKeyColumnOptions, PrimaryKeyColumnType } from '../decorators/PrimaryKey';
import { ColumnOptions, ColumnType } from '../decorators/Column';
import { IndexDefinition } from '../decorators/IndexDecorator';

export class BaseModel {
    static tableName?: string;
    static primaryKeys?: Array<{ name: string; type: PrimaryKeyColumnType; options?: PrimaryKeyColumnOptions }>;
    static columns?: Array<{ name: string; type: ColumnType; options?: ColumnOptions }>;
    static indexes?: Array<IndexDefinition>;

    /* eslint-disable @typescript-eslint/no-explicit-any */
    constructor() {
        const columns = (this.constructor as typeof BaseModel).columns ?? [];
        for (const col of columns) {
            if (col.options?.default !== undefined) {
                // Check if the default is a function and call it if it is
                if (typeof col.options.default === 'function') {
                    const defaultValue = (col.options.default as () => any)();
                    this.assignColumnValue(col.name, defaultValue);
                } else {
                    this.assignColumnValue(col.name, col.options.default);
                }
            }
        }
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */

    static getTableName(): string {
        return this.tableName ?? '';
    }

    static getPrimaryKeys(): Array<{ name: string; type: PrimaryKeyColumnType; options?: PrimaryKeyColumnOptions }> {
        return this.primaryKeys ?? [];
    }

    static getIndexes(): Array<IndexDefinition> {
        return this.indexes ?? [];
    }

    private assignColumnValue<T>(columnName: string, value: T): void {
        (this as Record<string, T>)[columnName] = value;
    }
}
