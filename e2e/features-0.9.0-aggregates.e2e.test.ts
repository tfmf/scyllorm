import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { types } from 'cassandra-driver';
import { BaseModel, Column, DataSource, Entity, GreaterThan, PrimaryKeyColumn, Repository } from '../src';

// Partition aggregates (sum / avg / min / max) against a real server: the classes the driver
// returns per column type, empty partitions, clustering ranges and the INT overflow.

const KS = 'scyllorm_v090_agg';
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

@Entity(`${KS}.metrics`)
class Metric extends BaseModel {
    @PrimaryKeyColumn('INT', { partitionKey: true })
    pid: number;

    @PrimaryKeyColumn('INT', { clusteringKey: true })
    seq: number;

    @Column('INT')
    small: number;

    @Column('BIGINT')
    big: types.Long;

    @Column('DECIMAL')
    price: types.BigDecimal;

    @Column('VARINT')
    huge: types.Integer;

    @Column('DOUBLE')
    ratio: number;

    @Column('TIMESTAMP')
    at: Date;

    @Column('TEXT')
    label: string;

    @Column('INT', { transformer: { to: (v: unknown) => v as number, from: (v: unknown) => `L${v as number}` } })
    level: number | string;
}

describe('0.9.0 aggregates against a live ScyllaDB', () => {
    let ds: DataSource;
    let metrics: Repository<Metric>;

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
        await ds.synchronize([Metric]);
        metrics = ds.getRepository(Metric);

        for (const seq of [1, 2, 3]) {
            await metrics.save(
                metrics.create({
                    pid: 1,
                    seq,
                    small: seq * 10,
                    big: types.Long.fromNumber(seq * 1000),
                    price: types.BigDecimal.fromString(`${seq}.50`),
                    huge: types.Integer.fromNumber(seq * 100),
                    ratio: seq * 0.5,
                    at: new Date(Date.UTC(2024, 0, seq)),
                    label: ['b', 'a', 'c'][seq - 1],
                    level: seq,
                })
            );
        }
        // Two INTs that overflow when added, in their own partition
        await metrics.save(metrics.create({ pid: 2, seq: 1, small: 2147483647 }));
        await metrics.save(metrics.create({ pid: 2, seq: 2, small: 1 }));
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

    it('sums each numeric type with the class the driver returns', async () => {
        expect(await metrics.sum('small', { pid: 1 })).toBe(60);
        expect((await metrics.sum('big', { pid: 1 })) as types.Long).toBeInstanceOf(types.Long);
        expect(((await metrics.sum('big', { pid: 1 })) as types.Long).toNumber()).toBe(6000);
        const price = (await metrics.sum('price', { pid: 1 })) as types.BigDecimal;
        expect(price).toBeInstanceOf(types.BigDecimal);
        expect(price.toString()).toBe('7.50');
        const huge = (await metrics.sum('huge', { pid: 1 })) as types.Integer;
        expect(huge).toBeInstanceOf(types.Integer);
        expect(huge.toString()).toBe('600');
        expect(await metrics.sum('ratio', { pid: 1 })).toBe(3);
    });

    it('averages, truncating integer columns', async () => {
        expect(await metrics.avg('small', { pid: 1 })).toBe(20);
        expect(await metrics.avg('ratio', { pid: 1 })).toBe(1);
        expect(await metrics.avg('small', { pid: 1, seq: GreaterThan(1) })).toBe(25);
    });

    it('finds min and max converted like a read', async () => {
        expect(await metrics.min('small', { pid: 1 })).toBe(10);
        expect(await metrics.max('small', { pid: 1 })).toBe(30);
        const first = await metrics.min('at', { pid: 1 });
        expect(first).toBeInstanceOf(Date);
        expect((first as Date).toISOString()).toBe('2024-01-01T00:00:00.000Z');
        expect(await metrics.max('label', { pid: 1 })).toBe('c');
        expect(await metrics.max('level', { pid: 1 })).toBe('L3');
        expect(await metrics.min('level', { pid: 1 })).toBe('L1');
    });

    it('honours a clustering-range condition', async () => {
        expect(await metrics.sum('small', { pid: 1, seq: GreaterThan(1) })).toBe(50);
        expect(await metrics.max('small', { pid: 1, seq: GreaterThan(1) })).toBe(30);
        expect(await metrics.min('small', { pid: 1, seq: GreaterThan(1) })).toBe(20);
    });

    it('returns 0 / 0 / null / null for an empty partition', async () => {
        expect(await metrics.sum('small', { pid: 99 })).toBe(0);
        expect(await metrics.avg('small', { pid: 99 })).toBe(0);
        expect(await metrics.min('small', { pid: 99 })).toBeNull();
        expect(await metrics.max('level', { pid: 99 })).toBeNull();
    });

    it('rejects an INT sum that overflows', async () => {
        await expect(metrics.sum('small', { pid: 2 })).rejects.toThrow();
    });
});
