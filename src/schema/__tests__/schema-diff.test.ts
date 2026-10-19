import { describe, it, expect } from 'vitest';
import { BaseModel } from '../../model/BaseModel';
import { Entity } from '../../decorators/Entity';
import { Column, UserDefinedType } from '../../decorators/Column';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';
import { diffTable, diffType } from '../SchemaBuilder';

@Entity('ks.events')
class Event extends BaseModel {
    @PrimaryKeyColumn('INT', { partitionKey: true })
    pid: number;

    @PrimaryKeyColumn('INT', { clusteringKey: true, name: 'seq' })
    seq: number;

    @Column('TEXT')
    title: string;

    @Column('TEXT', { static: true })
    owner: string;

    @Column('VARCHAR', { name: 'note' })
    memo: string;

    @Column('LIST', { of: 'TEXT' })
    tags: string[];
}

const live = [
    { column_name: 'pid', kind: 'partition_key', type: 'int' },
    { column_name: 'seq', kind: 'clustering', type: 'int' },
    { column_name: 'title', kind: 'regular', type: 'text' },
    { column_name: 'owner', kind: 'static', type: 'text' },
    { column_name: 'note', kind: 'regular', type: 'text' },
    { column_name: 'tags', kind: 'regular', type: 'list<text>' },
];

describe('diffTable()', () => {
    it('finds nothing to do on an up-to-date table (varchar reads back as text)', () => {
        expect(diffTable(Event, live)).toEqual({ statements: [], warnings: [] });
    });

    it('adds a missing column, and STATIC for a static one', () => {
        const rows = live.filter((row) => !['owner', 'tags'].includes(row.column_name));

        expect(diffTable(Event, rows).statements).toEqual([
            'ALTER TABLE ks.events ADD owner text STATIC',
            'ALTER TABLE ks.events ADD tags list<text>',
        ]);
    });

    it('only warns about a missing key column', () => {
        const diff = diffTable(
            Event,
            live.filter((row) => row.column_name !== 'seq')
        );

        expect(diff.statements).toEqual([]);
        expect(diff.warnings).toHaveLength(1);
        expect(diff.warnings[0]).toMatch(/Event.*seq.*ks\.events.*keys cannot be altered/);
    });

    it('warns about a different type, ignoring case, spacing and varchar', () => {
        const rows = live.map((row) =>
            row.column_name === 'title'
                ? { ...row, type: 'int' }
                : row.column_name === 'tags'
                  ? { ...row, type: 'LIST< varchar >' }
                  : row
        );
        const diff = diffTable(Event, rows);

        expect(diff.statements).toEqual([]);
        expect(diff.warnings).toHaveLength(1);
        expect(diff.warnings[0]).toMatch(/column title.*int in the database but declared as text/);
    });

    it('warns about a kind mismatch', () => {
        const rows = live.map((row) => (row.column_name === 'owner' ? { ...row, kind: 'regular' } : row));
        const diff = diffTable(Event, rows);

        expect(diff.warnings).toHaveLength(1);
        expect(diff.warnings[0]).toMatch(/column owner.*regular in the database but declared as static/);
    });

    it('warns about undeclared database columns and keeps them', () => {
        const diff = diffTable(Event, [...live, { column_name: 'legacy', kind: 'regular', type: 'text' }]);

        expect(diff.statements).toEqual([]);
        expect(diff.warnings).toHaveLength(1);
        expect(diff.warnings[0]).toMatch(/column legacy.*not declared/);
    });

    it('does nothing for a table that could not be read', () => {
        const diff = diffTable(Event, []);

        expect(diff.statements).toEqual([]);
        expect(diff.warnings).toHaveLength(1);
    });
});

describe('diffType()', () => {
    const udt: UserDefinedType = {
        name: 'address',
        fields: { street: 'TEXT', zip: 'VARCHAR', geo: { type: 'UDT', udt: 'geo' } },
    };
    const row = { field_names: ['street', 'zip', 'geo'], field_types: ['text', 'text', 'frozen<geo>'] };

    it('finds nothing to do on an up-to-date type', () => {
        expect(diffType(udt, 'ks.', row, 'Place')).toEqual({ statements: [], warnings: [] });
    });

    it('adds missing fields', () => {
        const diff = diffType(udt, 'ks.', { field_names: ['street'], field_types: ['text'] }, 'Place');

        expect(diff.statements).toEqual([
            'ALTER TYPE ks.address ADD zip varchar',
            'ALTER TYPE ks.address ADD geo frozen<geo>',
        ]);
        expect(diff.warnings).toEqual([]);
    });

    it('warns about a different field type and an undeclared field', () => {
        const diff = diffType(
            udt,
            '',
            { field_names: ['street', 'zip', 'geo', 'old'], field_types: ['int', 'text', 'frozen<geo>', 'text'] },
            'Place'
        );

        expect(diff.statements).toEqual([]);
        expect(diff.warnings).toHaveLength(2);
        expect(diff.warnings[0]).toMatch(/Place.*field street of type address is int/);
        expect(diff.warnings[1]).toMatch(/field old of type address.*not declared/);
    });

    it('does nothing for a type that could not be read', () => {
        const diff = diffType(udt, '', undefined, 'Place');

        expect(diff.statements).toEqual([]);
        expect(diff.warnings).toHaveLength(1);
    });
});
