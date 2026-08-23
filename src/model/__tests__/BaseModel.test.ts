import { describe, it, expect } from 'vitest';
import { BaseModel } from '../BaseModel';
import { Entity } from '../../decorators/Entity';
import { Column } from '../../decorators/Column';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';

@Entity('with_defaults')
class WithDefaults extends BaseModel {
    @PrimaryKeyColumn('INT')
    id: number;

    @Column('TEXT', { default: 'plain-default' })
    plainDefault: string;

    @Column('TEXT', { default: () => 'function-default' })
    functionDefault: string;

    @Column('TEXT')
    noDefault: string;
}

class Bare extends BaseModel {}

describe('BaseModel', () => {
    describe('constructor', () => {
        it('applies a plain (non-function) default value', () => {
            const instance = new WithDefaults();
            expect(instance.plainDefault).toBe('plain-default');
        });

        it('applies a function default by invoking it', () => {
            const instance = new WithDefaults();
            expect(instance.functionDefault).toBe('function-default');
        });

        it('leaves a column with no default undefined', () => {
            const instance = new WithDefaults();
            expect(instance.noDefault).toBeUndefined();
        });

        it('constructs without error when the class has no columns metadata at all', () => {
            expect(() => new Bare()).not.toThrow();
        });
    });

    describe('static getters', () => {
        it('getTableName() returns the configured table name', () => {
            expect(WithDefaults.getTableName()).toBe('with_defaults');
        });

        it('getTableName() falls back to an empty string when unset', () => {
            expect(Bare.getTableName()).toBe('');
        });

        it('getPrimaryKeys() returns the configured primary keys', () => {
            expect(WithDefaults.getPrimaryKeys()).toEqual([{ name: 'id', type: 'INT' }]);
        });

        it('getPrimaryKeys() falls back to an empty array when unset', () => {
            expect(Bare.getPrimaryKeys()).toEqual([]);
        });

        it('getIndexes() falls back to an empty array when unset', () => {
            expect(Bare.getIndexes()).toEqual([]);
        });

        it('getEntityOptions() returns the configured entity options', () => {
            expect(WithDefaults.getEntityOptions()).toEqual({});
        });

        it('getEntityOptions() falls back to an empty object when unset', () => {
            expect(Bare.getEntityOptions()).toEqual({});
        });
    });
});
