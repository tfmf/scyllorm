import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BaseModel, Column, DataSource, Entity, PrimaryKeyColumn, Repository } from '../src';

// Token-range parallel scan, which only a real server can vouch for.

const KS = 'scyllorm_v090_scan';
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

@Entity(`${KS}.items`)
class Item extends BaseModel {
    @PrimaryKeyColumn('INT', { partitionKey: true, name: 'part_id' })
    partId: number;

    @PrimaryKeyColumn('INT', { clusteringKey: true })
    seq: number;

    @Column('TEXT')
    label: string;
}

@Entity(`${KS}.pairs`)
class Pair extends BaseModel {
    @PrimaryKeyColumn('INT', { partitionKey: true })
    a: number;

    @PrimaryKeyColumn('TEXT', { partitionKey: true })
    b: string;

    @Column('INT')
    v: number;
}

@Entity(`${KS}.empty_items`)
class EmptyItem extends BaseModel {
    @PrimaryKeyColumn('INT', { partitionKey: true })
    id: number;
}

describe('scan (e2e)', () => {
    let ds: DataSource;
    let items: Repository<Item>;
    let pairs: Repository<Pair>;
    let empties: Repository<EmptyItem>;
    const itemKeys = new Set<string>();
    const pairKeys = new Set<string>();

    const keysOf = async (iterator: AsyncIterableIterator<Item>): Promise<string[]> => {
        const keys: string[] = [];
        for await (const item of iterator) {
            keys.push(`${item.partId}/${item.seq}`);
        }
        return keys;
    };

    beforeAll(async () => {
        ds = new DataSource({ contactPoints: ['127.0.0.1'], localDataCenter: 'datacenter1', logger: silent });
        await ds.initialize();
        await ds.executeQuery(
            `CREATE KEYSPACE IF NOT EXISTS ${KS} ` +
                "WITH replication = { 'class': 'SimpleStrategy', 'replication_factor': 1 } " +
                "AND tablets = { 'enabled': false }",
            [],
            { prepare: false }
        );
        await ds.synchronize([Item, Pair, EmptyItem]);
        items = ds.getRepository(Item);
        pairs = ds.getRepository(Pair);
        empties = ds.getRepository(EmptyItem);

        // 150 partitions, two rows each
        for (let p = 0; p < 150; p++) {
            for (let s = 0; s < 2; s++) {
                await items.save(Object.assign(new Item(), { partId: p, seq: s, label: `l${p}-${s}` }));
                itemKeys.add(`${p}/${s}`);
            }
        }
        for (let a = 0; a < 20; a++) {
            for (const b of ['x', 'y', 'z']) {
                await pairs.save(Object.assign(new Pair(), { a, b, v: a }));
                pairKeys.add(`${a}/${b}`);
            }
        }
    }, 120_000);

    afterAll(async () => {
        if (ds) {
            try {
                await ds.executeQuery(`DROP KEYSPACE IF EXISTS ${KS}`, [], { prepare: false });
            } finally {
                await ds.shutdown();
            }
        }
    });

    it.each([
        [1, 1],
        [4, 16],
        [16, undefined],
        [8, 1000],
    ])(
        'returns exactly the inserted rows with concurrency %s and splits %s',
        async (concurrency, splits) => {
            const keys = await keysOf(items.scan({ concurrency, splits }));

            expect(keys).toHaveLength(itemKeys.size);
            expect(new Set(keys)).toEqual(itemKeys);
        },
        60_000
    );

    it('reads many pages with a small fetchSize', async () => {
        const keys = await keysOf(items.scan({ concurrency: 2, splits: 2, fetchSize: 7 }));

        expect(keys).toHaveLength(itemKeys.size);
        expect(new Set(keys)).toEqual(itemKeys);
    });

    it('scans a composite partition key', async () => {
        const keys: string[] = [];
        for await (const pair of pairs.scan({ splits: 10, fetchSize: 5 })) {
            keys.push(`${pair.a}/${pair.b}`);
        }

        expect(keys).toHaveLength(pairKeys.size);
        expect(new Set(keys)).toEqual(pairKeys);
    });

    it('projects selected columns', async () => {
        const rows: Item[] = [];
        for await (const item of items.scan({ select: ['partId', 'seq'], splits: 4 })) {
            rows.push(item);
        }

        expect(rows).toHaveLength(itemKeys.size);
        expect(rows.every((r) => r.label === undefined)).toBe(true);
    });

    it('stops cleanly on an early break', async () => {
        let taken = 0;
        for await (const item of items.scan({ concurrency: 4, splits: 16, fetchSize: 5 })) {
            expect(item).toBeInstanceOf(Item);
            if (++taken === 3) {
                break;
            }
        }

        expect(taken).toBe(3);
        // The connection is still good afterwards
        expect(await items.count()).toBe(itemKeys.size);
    });

    it('yields nothing for an empty table', async () => {
        const rows: EmptyItem[] = [];
        for await (const row of empties.scan({ splits: 8 })) {
            rows.push(row);
        }

        expect(rows).toEqual([]);
    });
});
