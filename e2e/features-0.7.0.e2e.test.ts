import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BaseModel, Column, DataSource, Entity, InvalidQueryError, PrimaryKeyColumn, Repository } from '../src';

// Features of 0.7.0 that only a real server can vouch for: write timestamps,
// PER PARTITION LIMIT, counter and unlogged batches, concurrent execution.

const KS = 'scyllorm_v070';
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

@Entity(`${KS}.items`)
class Item extends BaseModel {
    @PrimaryKeyColumn('INT', { partitionKey: true })
    id: number;

    @Column('TEXT')
    body: string;
}

@Entity(`${KS}.events`)
class Event extends BaseModel {
    @PrimaryKeyColumn('INT', { partitionKey: true })
    pid: number;

    @PrimaryKeyColumn('INT', { clusteringKey: true, order: 'DESC' })
    seq: number;
}

@Entity(`${KS}.counters`)
class Hits extends BaseModel {
    @PrimaryKeyColumn('TEXT', { partitionKey: true })
    id: string;

    @Column('COUNTER')
    hits: unknown;
}

describe('0.7.0 features against a live ScyllaDB', () => {
    let ds: DataSource;
    let items: Repository<Item>;
    let events: Repository<Event>;
    let counters: Repository<Hits>;

    // Microsecond write times, far enough in the future that a plain write cannot beat them
    const base = (Date.now() + 3_600_000) * 1000;

    const item = (id: number, body = 'x'): Item => items.create({ id, body });
    const writetime = async (id: number): Promise<string | undefined> => {
        const rows = await items.runRawQuery(
            `SELECT WRITETIME(body) AS wt, TTL(body) AS ttl FROM ${KS}.items WHERE id = :id`,
            { id },
            { raw: true }
        );
        return rows[0] ? String(rows[0].wt) : undefined;
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
        await ds.synchronize([Item, Event, Hits]);
        items = ds.getRepository(Item);
        events = ds.getRepository(Event);
        counters = ds.getRepository(Hits);
    });

    afterAll(async () => {
        if (ds) {
            try {
                await ds.executeQuery(`DROP KEYSPACE IF EXISTS ${KS}`, [], { prepare: false });
            } finally {
                await ds.shutdown();
            }
        }
    });

    it('save/update/delete honour the write timestamp', async () => {
        await items.save(item(1), { timestamp: base });
        expect(await writetime(1)).toBe(String(base));

        await items.update({ id: 1 }, { body: 'y' }, { ttl: 1000, timestamp: base + 10 });
        const rows = await items.runRawQuery(
            `SELECT WRITETIME(body) AS wt, TTL(body) AS ttl, body FROM ${KS}.items WHERE id = 1`,
            {},
            { raw: true }
        );
        expect(String(rows[0].wt)).toBe(String(base + 10));
        expect(Number(rows[0].ttl)).toBeGreaterThan(0);
        expect(rows[0].body).toBe('y');

        // An older delete loses to the existing write; a newer one wins
        await items.delete({ id: 1 }, { timestamp: base });
        expect(await items.findOneBy({ id: 1 })).not.toBeNull();
        await items.delete({ id: 1 }, { timestamp: base + 20 });
        expect(await items.findOneBy({ id: 1 })).toBeNull();
    });

    it('orders a batch by statement timestamps', async () => {
        const t = base + 1000;
        await ds.executeBatch([
            items.deleteStatement({ id: 2 }, { timestamp: t }),
            items.saveStatement(item(2), { timestamp: t + 1 }),
        ]);
        expect(await items.findOneBy({ id: 2 })).not.toBeNull();

        await ds.executeBatch([
            items.deleteStatement({ id: 3 }, { timestamp: t + 1 }),
            items.saveStatement(item(3), { timestamp: t }),
        ]);
        expect(await items.findOneBy({ id: 3 })).toBeNull();
    });

    it('rejects a timestamp on a conditional write locally', async () => {
        await expect(items.insertIfNotExists(item(4), { timestamp: base })).rejects.toBeInstanceOf(InvalidQueryError);
        expect(await items.findOneBy({ id: 4 })).toBeNull();
    });

    it('perPartitionLimit caps rows per partition', async () => {
        for (const pid of [1, 2, 3]) {
            for (let seq = 1; seq <= 5; seq++) {
                await events.save(events.create({ pid, seq }));
            }
        }

        const rows = await events.find({ perPartitionLimit: 2 });
        expect(rows).toHaveLength(6);
        for (const pid of [1, 2, 3]) {
            expect(
                rows
                    .filter((r) => r.pid === pid)
                    .map((r) => r.seq)
                    .sort()
            ).toEqual([4, 5]);
        }

        expect(await events.find({ perPartitionLimit: 2, limit: 3 })).toHaveLength(3);
    });

    it('applies counter batches and refuses to mix them', async () => {
        await ds.executeBatch([
            counters.incrementStatement({ id: 'a' }, 'hits', 2),
            counters.decrementStatement({ id: 'b' }, 'hits'),
        ]);
        expect(String((await counters.findOneBy({ id: 'a' }))!.hits)).toBe('2');
        expect(String((await counters.findOneBy({ id: 'b' }))!.hits)).toBe('-1');

        await expect(
            ds.executeBatch([counters.incrementStatement({ id: 'a' }, 'hits'), items.saveStatement(item(5))])
        ).rejects.toBeInstanceOf(InvalidQueryError);
        expect(await items.findOneBy({ id: 5 })).toBeNull();
    });

    it('runs an unlogged batch within one partition', async () => {
        await ds.executeBatch(
            [1, 2, 3].map((seq) => events.saveStatement(events.create({ pid: 9, seq }))),
            { logged: false }
        );
        expect(await events.count({ pid: 9 })).toBe(3);
    });

    it('executeConcurrent and saveMany handle bulk work in order', async () => {
        const entities = Array.from({ length: 200 }, (_, i) => item(1000 + i, `b${i}`));
        await ds.executeConcurrent(
            entities.map((e) => items.saveStatement(e)),
            { concurrency: 20, isIdempotent: true }
        );

        const selects = entities.map((e) => ({
            query: `SELECT body FROM ${KS}.items WHERE id = ?`,
            params: [e.id],
        }));
        const results = await ds.executeConcurrent<{ body: string }>(selects, { concurrency: 20 });
        expect(results.map((rows) => rows[0].body)).toEqual(entities.map((e) => e.body));

        await items.saveMany(
            Array.from({ length: 300 }, (_, i) => item(5000 + i)),
            { concurrency: 25 }
        );
        expect(await items.count({ id: 5000 })).toBe(1);
        const total = await items.runRawQuery(
            `SELECT COUNT(*) AS n FROM ${KS}.items WHERE id >= 5000 ALLOW FILTERING`,
            {},
            { raw: true }
        );
        expect(Number(String(total[0].n))).toBe(300);
    });
});
