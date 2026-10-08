import { describe, it, expect, vi, beforeEach } from 'vitest';
import { types } from 'cassandra-driver';
import { DataSource } from '../../data-source/DataSource';
import { Repository } from '../Repository';
import { BaseModel } from '../../model/BaseModel';
import { Entity } from '../../decorators/Entity';
import { Column } from '../../decorators/Column';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';
import { InvalidQueryError } from '../../errors';

vi.mock('cassandra-driver', async (importOriginal) => {
    class MockClient {
        connect = vi.fn().mockResolvedValue(undefined);
        shutdown = vi.fn().mockResolvedValue(undefined);
        execute = vi.fn().mockResolvedValue({ rows: [] });
    }
    return { ...(await importOriginal<typeof import('cassandra-driver')>()), Client: MockClient };
});

@Entity('items')
class Item extends BaseModel {
    @PrimaryKeyColumn('TEXT')
    id: string;

    @Column('TEXT')
    name: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function setup() {
    const ds = new DataSource({
        contactPoints: ['x'],
        localDataCenter: 'dc1',
        logger: { error() {}, warn() {}, info() {}, debug() {} } as any,
    });
    await ds.initialize();
    const executeQuery = vi.fn().mockResolvedValue([]);
    const executeQueryPage = vi.fn().mockResolvedValue({ rows: [], pageState: undefined });
    const streamQuery = vi.fn(async function* () {});
    (ds as any).executeQuery = executeQuery;
    (ds as any).executeQueryPage = executeQueryPage;
    (ds as any).streamQuery = streamQuery;
    return { repo: ds.getRepository<Item>(Item), executeQuery, executeQueryPage, streamQuery };
}

const INVALID: [string, unknown][] = [
    ['a fraction', 1.5],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['2**53', 2 ** 53],
    ['a numeric string', '123'],
    ['a BigInt', 123n],
    ['null', null],
    ['an empty object', {}],
];

describe('write timestamp', () => {
    let repo: Repository<Item>;
    let executeQuery: ReturnType<typeof vi.fn>;
    const entity = () => repo.create({ id: 'a', name: 'b' });
    const ts = 1700000000000000;
    // A number is bound as a Long, so it encodes as bigint even unprepared
    const bound = types.Long.fromNumber(ts);

    beforeEach(async () => {
        ({ repo, executeQuery } = await setup());
    });

    describe('insert', () => {
        it('renders USING TIMESTAMP alone', () => {
            expect(repo.saveStatement(entity(), { timestamp: ts })).toEqual({
                query: 'INSERT INTO items (id, name) VALUES (?, ?) USING TIMESTAMP ?',
                params: ['a', 'b', bound],
            });
        });

        it('renders TTL first then TIMESTAMP', () => {
            expect(repo.saveStatement(entity(), { ttl: 60, timestamp: ts })).toEqual({
                query: 'INSERT INTO items (id, name) VALUES (?, ?) USING TTL ? AND TIMESTAMP ?',
                params: ['a', 'b', 60, bound],
            });
        });

        it('save() sends the same CQL', async () => {
            await repo.save(entity(), { ttl: 60, timestamp: ts });
            expect(executeQuery.mock.calls[0][0]).toBe(
                'INSERT INTO items (id, name) VALUES (?, ?) USING TTL ? AND TIMESTAMP ?'
            );
            expect(executeQuery.mock.calls[0][1]).toEqual(['a', 'b', 60, bound]);
        });

        it('binds a number as a Long, never as a double', () => {
            const [, , param] = repo.saveStatement(entity(), { timestamp: ts }).params;

            expect(param).toBeInstanceOf(types.Long);
            expect(String(param)).toBe(String(ts));
        });

        it('accepts a types.Long', () => {
            const long = types.Long.fromNumber(ts);
            expect(repo.saveStatement(entity(), { timestamp: long }).params).toEqual(['a', 'b', long]);
        });
    });

    describe('update', () => {
        it('renders USING TIMESTAMP after the table', () => {
            expect(repo.updateStatement({ id: 'a' }, { name: 'c' }, { timestamp: ts })).toEqual({
                query: 'UPDATE items USING TIMESTAMP ? SET name = ? WHERE id = ?',
                params: [bound, 'c', 'a'],
            });
        });

        it('renders TTL and TIMESTAMP', () => {
            expect(repo.updateStatement({ id: 'a' }, { name: 'c' }, { ttl: 30, timestamp: ts })).toEqual({
                query: 'UPDATE items USING TTL ? AND TIMESTAMP ? SET name = ? WHERE id = ?',
                params: [30, bound, 'c', 'a'],
            });
        });

        it('update() sends the same CQL', async () => {
            await repo.update({ id: 'a' }, { name: 'c' }, { timestamp: ts });
            expect(executeQuery.mock.calls[0][0]).toBe('UPDATE items USING TIMESTAMP ? SET name = ? WHERE id = ?');
            expect(executeQuery.mock.calls[0][1]).toEqual([bound, 'c', 'a']);
        });

        it('accepts a types.Long', () => {
            const long = types.Long.fromNumber(ts);
            expect(repo.updateStatement({ id: 'a' }, { name: 'c' }, { timestamp: long }).params[0]).toBe(long);
        });
    });

    describe('delete', () => {
        it('renders USING TIMESTAMP before WHERE', () => {
            expect(repo.deleteStatement({ id: 'a' }, { timestamp: ts })).toEqual({
                query: 'DELETE FROM items USING TIMESTAMP ? WHERE id = ?',
                params: [bound, 'a'],
            });
        });

        it('delete() sends the same CQL', async () => {
            await repo.delete({ id: 'a' }, { timestamp: ts });
            expect(executeQuery.mock.calls[0][0]).toBe('DELETE FROM items USING TIMESTAMP ? WHERE id = ?');
            expect(executeQuery.mock.calls[0][1]).toEqual([bound, 'a']);
        });

        it('accepts a types.Long', () => {
            const long = types.Long.fromNumber(ts);
            expect(repo.deleteStatement({ id: 'a' }, { timestamp: long }).params).toEqual([long, 'a']);
        });
    });

    describe('invalid timestamps', () => {
        it.each(INVALID)('rejects %s everywhere and executes nothing', async (_l, bad) => {
            const t = bad as any;
            expect(() => repo.saveStatement(entity(), { timestamp: t })).toThrow(InvalidQueryError);
            expect(() => repo.updateStatement({ id: 'a' }, { name: 'c' }, { timestamp: t })).toThrow(InvalidQueryError);
            expect(() => repo.deleteStatement({ id: 'a' }, { timestamp: t })).toThrow(InvalidQueryError);
            await expect(repo.save(entity(), { timestamp: t })).rejects.toThrow(InvalidQueryError);
            await expect(repo.update({ id: 'a' }, { name: 'c' }, { timestamp: t })).rejects.toThrow(InvalidQueryError);
            await expect(repo.delete({ id: 'a' }, { timestamp: t })).rejects.toThrow(InvalidQueryError);
            expect(executeQuery).not.toHaveBeenCalled();
        });
    });

    describe('conditional writes', () => {
        it('refuse a timestamp and execute nothing', async () => {
            await expect(repo.insertIfNotExists(entity(), { timestamp: ts })).rejects.toThrow(InvalidQueryError);
            await expect(repo.updateIfExists({ id: 'a' }, { name: 'c' }, { timestamp: ts })).rejects.toThrow(
                InvalidQueryError
            );
            await expect(repo.deleteIfExists({ id: 'a' }, { timestamp: ts } as any)).rejects.toThrow(InvalidQueryError);
            await expect(repo.insertIfNotExists(entity(), { timestamp: ts })).rejects.toThrow(/timestamp/i);
            expect(executeQuery).not.toHaveBeenCalled();
        });

        it('refuse a timestamp before running any hook', async () => {
            const item = entity();
            item.beforeSave = vi.fn();
            Item.beforeUpdate = vi.fn();
            Item.beforeDelete = vi.fn();

            try {
                await expect(repo.insertIfNotExists(item, { timestamp: ts })).rejects.toThrow(InvalidQueryError);
                await expect(repo.updateIfExists({ id: 'a' }, { name: 'c' }, { timestamp: ts })).rejects.toThrow(
                    InvalidQueryError
                );
                await expect(repo.deleteIfExists({ id: 'a' }, { timestamp: ts } as any)).rejects.toThrow(
                    InvalidQueryError
                );

                expect(item.beforeSave).not.toHaveBeenCalled();
                expect(Item.beforeUpdate).not.toHaveBeenCalled();
                expect(Item.beforeDelete).not.toHaveBeenCalled();
            } finally {
                delete (Item as any).beforeUpdate;
                delete (Item as any).beforeDelete;
            }
        });
    });

    describe('without a timestamp the CQL is unchanged', () => {
        it('insert', () => {
            expect(repo.saveStatement(entity())).toEqual({
                query: 'INSERT INTO items (id, name) VALUES (?, ?)',
                params: ['a', 'b'],
            });
            expect(repo.saveStatement(entity(), { ttl: 60 })).toEqual({
                query: 'INSERT INTO items (id, name) VALUES (?, ?) USING TTL ?',
                params: ['a', 'b', 60],
            });
            expect(repo.saveStatement(entity(), {}).query).toBe('INSERT INTO items (id, name) VALUES (?, ?)');
        });

        it('update', () => {
            expect(repo.updateStatement({ id: 'a' }, { name: 'c' })).toEqual({
                query: 'UPDATE items SET name = ? WHERE id = ?',
                params: ['c', 'a'],
            });
            expect(repo.updateStatement({ id: 'a' }, { name: 'c' }, { ttl: 30 })).toEqual({
                query: 'UPDATE items USING TTL ? SET name = ? WHERE id = ?',
                params: [30, 'c', 'a'],
            });
        });

        it('delete', () => {
            expect(repo.deleteStatement({ id: 'a' })).toEqual({
                query: 'DELETE FROM items WHERE id = ?',
                params: ['a'],
            });
            expect(repo.deleteStatement({ id: 'a' }, {})).toEqual({
                query: 'DELETE FROM items WHERE id = ?',
                params: ['a'],
            });
        });

        it('delete() and deleteIfExists() still run', async () => {
            await repo.delete({ id: 'a' });
            expect(executeQuery.mock.calls[0][0]).toBe('DELETE FROM items WHERE id = ?');
            executeQuery.mockResolvedValue([{ '[applied]': true }]);
            await repo.deleteIfExists({ id: 'a' });
            expect(executeQuery.mock.calls[1][0]).toBe('DELETE FROM items WHERE id = ? IF EXISTS');
        });
    });
});
