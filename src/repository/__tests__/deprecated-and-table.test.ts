import { describe, it, expect, vi } from 'vitest';
import { BaseModel } from '../../model/BaseModel';
import { Table } from '../../decorators/Table';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';
import { MoreThan, MoreThanOrEqual, GreaterThan, GreaterThanOrEqual } from '../query-utils';

describe('MoreThan / MoreThanOrEqual (deprecated aliases)', () => {
    it('MoreThan() returns the same condition object as GreaterThan()', () => {
        expect(MoreThan(10)).toEqual(GreaterThan(10));
    });

    it('MoreThanOrEqual() returns the same condition object as GreaterThanOrEqual()', () => {
        expect(MoreThanOrEqual(5)).toEqual(GreaterThanOrEqual(5));
    });
});

describe('@Table decorator (deprecated)', () => {
    it('sets the table name like @Entity does', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        @Table({ name: 'legacy_widgets' })
        class LegacyWidget extends BaseModel {
            @PrimaryKeyColumn('INT')
            id: number;
        }

        expect(LegacyWidget.getTableName()).toBe('legacy_widgets');
        expect(warnSpy).toHaveBeenCalled();

        warnSpy.mockRestore();
    });
});

describe('@PrimaryKeyColumn with options', () => {
    it('attaches the options to both the primaryKeys and columns metadata', () => {
        class Sharded extends BaseModel {
            @PrimaryKeyColumn('TEXT', { partitionKey: true })
            shardKey: string;
        }

        expect(Sharded.getPrimaryKeys()).toEqual([
            { name: 'shardKey', type: 'TEXT', options: { partitionKey: true } },
        ]);
        expect(Sharded.columns).toEqual([{ name: 'shardKey', type: 'TEXT', options: { partitionKey: true } }]);
    });
});
