import { describe, it, expect, vi } from 'vitest';
import { types } from 'cassandra-driver';
import { DataSource } from '../../data-source/DataSource';
import { BaseModel } from '../../model/BaseModel';
import { Entity } from '../../decorators/Entity';
import { Column } from '../../decorators/Column';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';
import { InvalidQueryError, UnknownColumnError } from '../../errors';

vi.mock('cassandra-driver', async (importOriginal) => {
    class MockClient {
        connect = vi.fn().mockResolvedValue(undefined);
        shutdown = vi.fn().mockResolvedValue(undefined);
        execute = vi.fn().mockResolvedValue({ rows: [] });
    }
    // Partial mock: the real value types (`types.Long`, …) stay available
    return {
        ...(await importOriginal<typeof import('cassandra-driver')>()),
        Client: MockClient,
        errors: {
            NoHostAvailableError: class extends Error {},
            DriverInternalError: class extends Error {},
        },
    };
});

@Entity('scan_items')
class Item extends BaseModel {
    @PrimaryKeyColumn('INT', { partitionKey: true })
    id: number;

    @Column('TEXT', { transformer: { to: (v: string) => v, from: (v: string) => v.toUpperCase() } })
    label: string;

    loaded = false;

    async afterLoad(): Promise<void> {
        this.loaded = true;
    }
}

@Entity('scan_composite')
class Composite extends BaseModel {
    @PrimaryKeyColumn('INT', { partitionKey: true, name: 'org_id' })
    orgId: number;

    @PrimaryKeyColumn('INT', { partitionKey: true, name: 'user_id' })
    userId: number;

    @PrimaryKeyColumn('INT', { clusteringKey: true })
    seq: number;
}

@Entity('scan_no_pk')
class NoPartition extends BaseModel {
    @PrimaryKeyColumn('INT', { clusteringKey: true })
    seq: number;
}

type Call = { query: string; params: unknown[]; options: Record<string, unknown> };

function setup(pages: (call: Call, n: number) => { rows: unknown[]; pageState?: string } = () => ({ rows: [] })) {
    const ds = new DataSource({ contactPoints: ['x'], localDataCenter: 'dc1' } as never);
    const calls: Call[] = [];

    vi.spyOn(ds, 'executeQueryPage').mockImplementation((async (
        query: string,
        params: unknown[],
        options: Record<string, unknown>
    ) => {
        const call = { query, params, options };
        calls.push(call);
        return pages(call, calls.length - 1);
    }) as never);

    return { ds, calls };
}

async function drain<T>(iterator: AsyncIterableIterator<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const item of iterator) {
        out.push(item);
    }
    return out;
}

describe('Repository.scan', () => {
    it('queries each token range with exact CQL and Long bounds', async () => {
        const { ds, calls } = setup();
        await drain(ds.getRepository(Item).scan({ concurrency: 1, splits: 2 }));

        expect(calls.map((c) => c.query)).toEqual(
            Array(2).fill('SELECT * FROM scan_items WHERE token(id) > ? AND token(id) <= ?')
        );
        expect(calls.every((c) => c.params.every((p) => p instanceof types.Long))).toBe(true);
        expect(calls.map((c) => c.params.map(String))).toEqual([
            ['-9223372036854775808', '0'],
            ['0', '9223372036854775807'],
        ]);
    });

    it('defaults to 64 splits', async () => {
        const { ds, calls } = setup();
        await drain(ds.getRepository(Item).scan());
        expect(calls).toHaveLength(64);
    });

    it('defaults splits to concurrency * 4', async () => {
        const { ds, calls } = setup();
        await drain(ds.getRepository(Item).scan({ concurrency: 3 }));
        expect(calls).toHaveLength(12);
    });

    it('uses every partition key, by column name, inside token()', async () => {
        const { ds, calls } = setup();
        await drain(ds.getRepository(Composite).scan({ splits: 1 }));
        expect(calls[0].query).toBe(
            'SELECT * FROM scan_composite WHERE token(org_id, user_id) > ? AND token(org_id, user_id) <= ?'
        );
    });

    it('projects select columns', async () => {
        const { ds, calls } = setup();
        await drain(ds.getRepository(Composite).scan({ splits: 1, select: ['orgId', 'seq'] }));
        expect(calls[0].query).toBe(
            'SELECT org_id, seq FROM scan_composite WHERE token(org_id, user_id) > ? AND token(org_id, user_id) <= ?'
        );
    });

    it('forwards consistency and fetchSize, and the pageState on later pages', async () => {
        const { ds, calls } = setup((_call, n) => (n === 0 ? { rows: [], pageState: 'p2' } : { rows: [] }));
        await drain(
            ds.getRepository(Item).scan({ splits: 1, fetchSize: 7, consistency: types.consistencies.localQuorum })
        );

        expect(calls).toHaveLength(2);
        expect(calls[0].options).toMatchObject({ fetchSize: 7, consistency: types.consistencies.localQuorum });
        expect(calls[0].options.pageState).toBeUndefined();
        expect(calls[1].options).toMatchObject({ fetchSize: 7, pageState: 'p2' });
    });

    it('omits fetchSize when not set', async () => {
        const { ds, calls } = setup();
        await drain(ds.getRepository(Item).scan({ splits: 1 }));
        expect('fetchSize' in calls[0].options).toBe(false);
    });

    it('reads multi-page ranges to the end and yields every row', async () => {
        const { ds } = setup((call, n) => {
            if (String(call.params[0]) === '-9223372036854775808') {
                return n === 0 ? { rows: [{ id: 1, label: 'a' }], pageState: 'x' } : { rows: [{ id: 2, label: 'b' }] };
            }
            return { rows: [{ id: 3, label: 'c' }] };
        });
        const items = await drain(ds.getRepository(Item).scan({ concurrency: 1, splits: 2 }));
        expect(items.map((i) => i.id).sort()).toEqual([1, 2, 3]);
    });

    it('applies transformer.from and afterLoad to each row', async () => {
        const { ds } = setup(() => ({
            rows: [
                { id: 1, label: 'a' },
                { id: 2, label: 'b' },
            ],
        }));
        const items = await drain(ds.getRepository(Item).scan({ splits: 1 }));

        expect(items.map((i) => i.label)).toEqual(['A', 'B']);
        expect(items.every((i) => i instanceof Item && i.loaded)).toBe(true);
    });

    it.each([0, -1, 1.5, NaN, '4'])('rejects concurrency %s before any query', async (concurrency) => {
        const { ds, calls } = setup();
        await expect(drain(ds.getRepository(Item).scan({ concurrency: concurrency as number }))).rejects.toThrow(
            /Invalid concurrency/
        );
        expect(calls).toHaveLength(0);
    });

    it.each([0, -1, 1.5, NaN, '4'])('rejects splits %s before any query', async (splits) => {
        const { ds, calls } = setup();
        await expect(drain(ds.getRepository(Item).scan({ splits: splits as number }))).rejects.toThrow(
            /Invalid splits/
        );
        expect(calls).toHaveLength(0);
    });

    it('rejects an empty select and an unknown select column', async () => {
        const { ds, calls } = setup();
        const repo = ds.getRepository(Item);
        await expect(drain(repo.scan({ select: [] }))).rejects.toThrow(InvalidQueryError);
        await expect(drain(repo.scan({ select: ['nope'] }))).rejects.toThrow(UnknownColumnError);
        expect(calls).toHaveLength(0);
    });

    it('rejects an entity without a partition key', async () => {
        const { ds, calls } = setup();
        await expect(drain(ds.getRepository(NoPartition).scan())).rejects.toThrow(/no partition key/);
        expect(calls).toHaveLength(0);
    });
});
