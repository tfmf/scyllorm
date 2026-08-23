import { PrimaryKeyColumnOptions, PrimaryKeyColumnType } from '../decorators/PrimaryKey';
import { ColumnOptions, ColumnType } from '../decorators/Column';
import { EntityOptions } from '../decorators/Entity';
import { IndexDefinition } from '../decorators/IndexDecorator';

export class BaseModel {
    static tableName?: string;
    static primaryKeys?: Array<{ name: string; type: PrimaryKeyColumnType; options?: PrimaryKeyColumnOptions }>;
    static columns?: Array<{ name: string; type: ColumnType; options?: ColumnOptions }>;
    static indexes?: Array<IndexDefinition>;
    static entityOptions?: EntityOptions; // Add this line to support entity options

    /**
     * Called by `Repository.save()` before the INSERT is built; throwing aborts the save.
     * Declare-only: implement it on a subclass to opt in.
     */
    beforeSave?(): void | Promise<void>;

    /**
     * Called by `Repository.save()` after the INSERT succeeds; throwing propagates to the caller.
     */
    afterSave?(): void | Promise<void>;

    /**
     * Called by `Repository.update()` before the UPDATE runs; throwing aborts it.
     * Static because an update targets rows by conditions — no entity instance exists.
     */
    static beforeUpdate?: (
        conditions: Record<string, unknown>,
        values: Record<string, unknown>
    ) => void | Promise<void>;

    /**
     * Called by `Repository.update()` after the UPDATE succeeds; throwing propagates to the caller.
     */
    static afterUpdate?: (conditions: Record<string, unknown>, values: Record<string, unknown>) => void | Promise<void>;

    /**
     * Called by `Repository.delete()` before the DELETE runs; throwing aborts it.
     * Static because a delete targets rows by conditions — no entity instance exists.
     */
    static beforeDelete?: (conditions: Record<string, unknown>) => void | Promise<void>;

    /**
     * Called by `Repository.delete()` after the DELETE succeeds; throwing propagates to the caller.
     */
    static afterDelete?: (conditions: Record<string, unknown>) => void | Promise<void>;

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

    static getEntityOptions(): EntityOptions {
        return this.entityOptions ?? {};
    }

    private assignColumnValue<T>(columnName: string, value: T): void {
        (this as Record<string, T>)[columnName] = value;
    }
}
