import { describe, it, expect, vi, beforeEach } from 'vitest';
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

describe('perPartitionLimit', () => {
    let repo: Repository<Item>;
    let executeQuery: ReturnType<typeof vi.fn>;
    let executeQueryPage: ReturnType<typeof vi.fn>;
    let streamQuery: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        ({ repo, executeQuery, executeQueryPage, streamQuery } = await setup());
    });

    const full = { where: { id: 'a' }, orderBy: { name: 'ASC' as const }, perPartitionLimit: 2, limit: 10 };
    const fullQuery =
        'SELECT * FROM items WHERE id = ? ORDER BY name ASC PER PARTITION LIMIT ? LIMIT ? ALLOW FILTERING';

    it('find renders clauses and params in order', async () => {
        await repo.find(full, true);
        expect(executeQuery.mock.calls[0][0]).toBe(fullQuery);
        expect(executeQuery.mock.calls[0][1]).toEqual(['a', 2, 10]);
    });

    it('findPaged renders clauses and params in order', async () => {
        await repo.findPaged(full, true);
        expect(executeQueryPage.mock.calls[0][0]).toBe(fullQuery);
        expect(executeQueryPage.mock.calls[0][1]).toEqual(['a', 2, 10]);
    });

    it('stream renders clauses and params in order', async () => {
        await repo.stream(full, true).next();
        expect(streamQuery.mock.calls[0][0]).toBe(fullQuery);
        expect(streamQuery.mock.calls[0][1]).toEqual(['a', 2, 10]);
    });

    it('works alone without where', async () => {
        await repo.find({ perPartitionLimit: 3 });
        expect(executeQuery.mock.calls[0][0]).toBe('SELECT * FROM items PER PARTITION LIMIT ?');
        expect(executeQuery.mock.calls[0][1]).toEqual([3]);
    });

    it('coerces a numeric string like limit', async () => {
        await repo.find({ perPartitionLimit: '5' as unknown as number });
        expect(executeQuery.mock.calls[0][1]).toEqual([5]);
    });

    it('accepts the largest CQL int', async () => {
        await repo.find({ perPartitionLimit: 2147483647 });
        expect(executeQuery.mock.calls[0][1]).toEqual([2147483647]);
    });

    it.each([
        ['zero', 0],
        ['negative', -1],
        ['a fraction', 1.5],
        ['past CQL int', 2147483648],
        ['non-numeric string', 'abc'],
        ['NaN', NaN],
    ])('rejects %s naming perPartitionLimit', async (_l, bad) => {
        const options = { perPartitionLimit: bad as unknown as number };
        await expect(repo.find(options)).rejects.toThrow(InvalidQueryError);
        await expect(repo.find(options)).rejects.toThrow(/perPartitionLimit/);
        await expect(repo.findPaged(options)).rejects.toThrow(/perPartitionLimit/);
        await expect(repo.stream(options).next()).rejects.toThrow(/perPartitionLimit/);
        expect(executeQuery).not.toHaveBeenCalled();
        expect(executeQueryPage).not.toHaveBeenCalled();
        expect(streamQuery).not.toHaveBeenCalled();
    });

    it('invalid limit message is unchanged', async () => {
        await expect(repo.find({ limit: 0 })).rejects.toThrow(
            'Invalid limit "0" on entity Item. A limit must be an integer from 1 to 2147483647, or a numeric string of one.'
        );
    });

    it('without perPartitionLimit the CQL is unchanged', async () => {
        await repo.find({ where: { id: 'a' }, limit: 4 });
        expect(executeQuery.mock.calls[0][0]).toBe('SELECT * FROM items WHERE id = ? LIMIT ?');
        expect(executeQuery.mock.calls[0][1]).toEqual(['a', 4]);
    });
});
