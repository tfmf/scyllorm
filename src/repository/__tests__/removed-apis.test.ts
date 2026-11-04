import { describe, it, expect } from 'vitest';
import * as scyllorm from '../../index';
import * as decorators from '../../decorators';
import { BaseModel } from '../../model/BaseModel';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';

describe('APIs removed in 1.0', () => {
    it.each(['MoreThan', 'MoreThanOrEqual', 'Table'])('the package no longer exports %s', (name) => {
        expect(scyllorm).not.toHaveProperty(name);
    });

    it('the decorators barrel no longer exports Table', () => {
        expect(decorators).not.toHaveProperty('Table');
    });

    it('keeps the replacements exported', () => {
        expect(typeof scyllorm.GreaterThan).toBe('function');
        expect(typeof scyllorm.GreaterThanOrEqual).toBe('function');
        expect(typeof scyllorm.Entity).toBe('function');
        expect(typeof decorators.Entity).toBe('function');
    });
});

describe('@PrimaryKeyColumn with options', () => {
    it('attaches the options to both the primaryKeys and columns metadata', () => {
        class Sharded extends BaseModel {
            @PrimaryKeyColumn('TEXT', { partitionKey: true })
            shardKey: string;
        }

        expect(Sharded.getPrimaryKeys()).toEqual([{ name: 'shardKey', type: 'TEXT', options: { partitionKey: true } }]);
        expect(Sharded.columns).toEqual([{ name: 'shardKey', type: 'TEXT', options: { partitionKey: true } }]);
    });
});
