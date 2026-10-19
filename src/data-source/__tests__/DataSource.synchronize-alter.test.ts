import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataSource } from '../DataSource';
import { BaseModel } from '../../model/BaseModel';
import { Entity } from '../../decorators/Entity';
import { Column, UserDefinedType } from '../../decorators/Column';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';
import { Index } from '../../decorators/IndexDecorator';
import { InvalidQueryError } from '../../errors';

const geo: UserDefinedType = { name: 'geo', fields: { lat: 'DOUBLE', lon: 'DOUBLE' } };

@Entity('ks.shops')
@Index('shops_by_name', 'name')
class Shop extends BaseModel {
    @PrimaryKeyColumn('UUID', { partitionKey: true })
    id: string;

    @Column('TEXT')
    name: string;

    @Column('UDT', { udt: geo })
    loc: unknown;
}

@Entity('ks.depots')
class Depot extends BaseModel {
    @PrimaryKeyColumn('UUID', { partitionKey: true })
    id: string;

    @Column('UDT', { udt: geo })
    loc: unknown;
}

@Entity('ks.clash')
class Clash extends BaseModel {
    @PrimaryKeyColumn('UUID', { partitionKey: true })
    id: string;

    @Column('UDT', { udt: { name: 'geo', fields: { lat: 'INT' } } })
    loc: unknown;
}

@Entity('bare')
class Bare extends BaseModel {
    @PrimaryKeyColumn('UUID', { partitionKey: true })
    id: string;
}

const TYPE = 'CREATE TYPE IF NOT EXISTS ks.geo (lat double, lon double)';
const TABLE = 'CREATE TABLE IF NOT EXISTS ks.shops (id uuid, name text, loc frozen<geo>, PRIMARY KEY (id))';
const INDEX = 'CREATE INDEX IF NOT EXISTS shops_by_name ON ks.shops (name)';

type Call = { query: string; params: unknown[]; options: Record<string, unknown> };

/** A data source whose executeQuery records its calls and answers system_schema reads from the given rows. */
function setup(
    answers: { types?: object[]; columns?: object[] } = {},
    options: { keyspace?: string } = {}
): { ds: DataSource; calls: Call[]; warn: ReturnType<typeof vi.fn> } {
    const warn = vi.fn();
    const ds = new DataSource({
        contactPoints: ['x'],
        localDataCenter: 'dc1',
        logger: { info: vi.fn(), warn, error: vi.fn() },
        ...options,
    } as never);
    const calls: Call[] = [];

    vi.spyOn(ds, 'executeQuery').mockImplementation((async (query: string, params: unknown[], opts: object) => {
        calls.push({ query, params, options: opts as Record<string, unknown> });

        if (query.includes('system_schema.types')) return answers.types ?? [];
        if (query.includes('system_schema.columns')) return answers.columns ?? [];

        return [];
    }) as never);

    return { ds, calls, warn };
}

const upToDateColumns = [
    { column_name: 'id', kind: 'partition_key', type: 'uuid' },
    { column_name: 'name', kind: 'regular', type: 'text' },
    { column_name: 'loc', kind: 'regular', type: 'frozen<geo>' },
];
const upToDateType = [{ field_names: ['lat', 'lon'], field_types: ['double', 'double'] }];

beforeEach(() => {
    vi.clearAllMocks();
});

describe('synchronize() without alter', () => {
    it('runs the types, then the table, then the indexes, all unprepared and idempotent', async () => {
        const { ds, calls } = setup();
        await ds.synchronize([Shop]);

        expect(calls.map((c) => c.query)).toEqual([TYPE, TABLE, INDEX]);
        for (const call of calls) {
            expect(call.params).toEqual([]);
            expect(call.options).toEqual({ prepare: false, isIdempotent: true });
        }
    });

    it('creates a type shared by several entities once per call', async () => {
        const { ds, calls } = setup();
        await ds.synchronize([Shop, Depot]);

        expect(calls.map((c) => c.query).filter((q) => q.startsWith('CREATE TYPE'))).toEqual([TYPE]);
        expect(calls).toHaveLength(4);
    });

    it('throws conflictingUdt when the entity is reached, after the earlier DDL ran', async () => {
        const { ds, calls } = setup();

        await expect(ds.synchronize([Shop, Clash])).rejects.toThrow(InvalidQueryError);
        expect(calls.map((c) => c.query)).toEqual([TYPE, TABLE, INDEX]);
    });

    it('checks every type of an entity before running any of its DDL', async () => {
        @Entity('ks.stray')
        class Stray extends BaseModel {
            @PrimaryKeyColumn('INT', { partitionKey: true })
            id: number;

            @Column('UDT', { udt: { name: 'pin', fields: { x: 'INT' } } })
            pin: unknown;

            @Column('UDT', { udt: { name: 'geo', fields: { lat: 'INT' } } })
            loc: unknown;
        }

        const { ds, calls } = setup();

        await expect(ds.synchronize([Shop, Stray])).rejects.toThrow(/defined twice/);
        expect(calls.map((c) => c.query)).toEqual([TYPE, TABLE, INDEX]);
    });

    it('treats one type reached through differently cased qualifiers as the same type', async () => {
        @Entity('KS.upper')
        class Upper extends BaseModel {
            @PrimaryKeyColumn('INT', { partitionKey: true })
            id: number;

            @Column('UDT', { udt: geo })
            loc: unknown;
        }

        const { ds, calls } = setup();
        await ds.synchronize([Shop, Upper]);

        expect(calls.map((c) => c.query).filter((q) => q.startsWith('CREATE TYPE'))).toEqual([TYPE]);
    });

    it('never reads system_schema and does not need a keyspace', async () => {
        const { ds, calls } = setup();
        await ds.synchronize([Bare]);

        expect(calls.map((c) => c.query)).toEqual(['CREATE TABLE IF NOT EXISTS bare (id uuid, PRIMARY KEY (id))']);
    });
});

describe('synchronize() with alter', () => {
    it('reads the type and the table back, folded, and issues nothing when up to date', async () => {
        const { ds, calls, warn } = setup({ types: upToDateType, columns: upToDateColumns });
        await ds.synchronize([Shop], { alter: true });

        expect(calls.map((c) => c.query)).toEqual([
            TYPE,
            'SELECT field_names, field_types FROM system_schema.types WHERE keyspace_name = ? AND type_name = ?',
            TABLE,
            'SELECT column_name, kind, type FROM system_schema.columns WHERE keyspace_name = ? AND table_name = ?',
            INDEX,
        ]);
        expect(calls[1].params).toEqual(['ks', 'geo']);
        expect(calls[1].options).toEqual({ prepare: true });
        expect(calls[3].params).toEqual(['ks', 'shops']);
        expect(warn).not.toHaveBeenCalled();
    });

    it('adds missing fields and columns with non-idempotent unprepared ALTERs, indexes last', async () => {
        const { ds, calls } = setup({
            types: [{ field_names: ['lat'], field_types: ['double'] }],
            columns: upToDateColumns.filter((c) => c.column_name !== 'name'),
        });
        await ds.synchronize([Shop], { alter: true });

        const alters = calls.filter((c) => c.query.startsWith('ALTER'));

        expect(alters.map((c) => c.query)).toEqual([
            'ALTER TYPE ks.geo ADD lon double',
            'ALTER TABLE ks.shops ADD name text',
        ]);
        for (const alter of alters) {
            expect(alter.options).toEqual({ prepare: false, isIdempotent: false });
        }
        expect(calls[calls.length - 1].query).toBe(INDEX);
        expect(calls.indexOf(alters[1])).toBeLessThan(calls.length - 1);
    });

    it('warns, naming entity and column, about differences it does not change', async () => {
        const { ds, calls, warn } = setup({
            types: upToDateType,
            columns: [
                { column_name: 'id', kind: 'partition_key', type: 'uuid' },
                { column_name: 'name', kind: 'regular', type: 'int' },
                { column_name: 'loc', kind: 'regular', type: 'frozen<geo>' },
                { column_name: 'legacy', kind: 'regular', type: 'text' },
            ],
        });
        await ds.synchronize([Shop], { alter: true });

        expect(calls.some((c) => c.query.startsWith('ALTER'))).toBe(false);
        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn.mock.calls[0][0]).toMatch(/Shop.*name.*ks\.shops/);
        expect(warn.mock.calls[1][0]).toMatch(/Shop.*legacy.*not declared/);
    });

    it('diffs a type shared by several entities once', async () => {
        const { ds, calls } = setup({ types: upToDateType, columns: upToDateColumns });
        await ds.synchronize([Shop, Depot], { alter: true });

        expect(calls.filter((c) => c.query.includes('system_schema.types'))).toHaveLength(1);
    });

    it('resolves an unqualified table against the connection keyspace, kept as the driver holds it', async () => {
        const { ds, calls } = setup(
            { columns: [{ column_name: 'id', kind: 'partition_key', type: 'uuid' }] },
            {
                keyspace: 'Main',
            }
        );
        await ds.synchronize([Bare], { alter: true });

        const read = calls.find((c) => c.query.includes('system_schema.columns'));

        // The driver USEs the keyspace quoted, so its case is the keyspace's own
        expect(read?.params).toEqual(['Main', 'bare']);
    });

    it('throws unknownKeyspace before any statement of that entity', async () => {
        const { ds, calls } = setup();

        await expect(ds.synchronize([Bare], { alter: true })).rejects.toThrow(/keyspace is unknown/);
        expect(calls).toEqual([]);
    });

    it('runs a second pass against an up-to-date schema without any ALTER', async () => {
        const { ds, calls } = setup({ types: upToDateType, columns: upToDateColumns });
        await ds.synchronize([Shop], { alter: true });
        await ds.synchronize([Shop], { alter: true });

        expect(calls.filter((c) => c.query.startsWith('ALTER'))).toEqual([]);
    });
});
