import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { types } from 'cassandra-driver';
import { BaseModel, Between, Column, DataSource, Entity, GreaterThan, PrimaryKeyColumn, Repository } from '../src';

// Regressions fixed in 0.5.1. The unit suite mocks the driver, which is how
// every one of these shipped: each needs the real server to show up.

const OPTIONS = { contactPoints: ['127.0.0.1'], localDataCenter: 'datacenter1' };

// camelCase properties and a keyspace-qualified name, created by synchronize()
@Entity('scyllorm_fixes.readings')
class Reading extends BaseModel {
    @PrimaryKeyColumn('TEXT', { partitionKey: true })
    sensorId: string;

    @PrimaryKeyColumn('TIMESTAMP', { clusteringKey: true, order: 'DESC' })
    takenAt: Date;

    @Column('BIGINT')
    rawValue: unknown;

    @Column('TEXT')
    displayName: string;
}

function reading(sensorId: string, takenAt: number, rawValue: number, displayName: string): Reading {
    const entity = new Reading();
    entity.sensorId = sensorId;
    entity.takenAt = new Date(takenAt);
    entity.rawValue = types.Long.fromNumber(rawValue);
    entity.displayName = displayName;
    return entity;
}

describe('0.5.1 fixes against a live ScyllaDB', () => {
    let dataSource: DataSource;
    let readings: Repository<Reading>;

    beforeAll(async () => {
        dataSource = new DataSource(OPTIONS);
        await dataSource.initialize();

        await dataSource.executeQuery(
            'CREATE KEYSPACE IF NOT EXISTS scyllorm_fixes ' +
                "WITH replication = { 'class': 'SimpleStrategy', 'replication_factor': 1 } " +
                "AND tablets = { 'enabled': false }",
            [],
            { prepare: false }
        );

        readings = dataSource.getRepository(Reading);
    });

    afterAll(async () => {
        if (dataSource) {
            try {
                await dataSource.executeQuery('DROP KEYSPACE IF EXISTS scyllorm_fixes', [], { prepare: false });
            } finally {
                await dataSource.shutdown();
            }
        }
    });

    it('synchronize() creates a keyspace-qualified table', async () => {
        await dataSource.synchronize([Reading]);

        const tables = await readings.runRawQuery(
            'SELECT table_name FROM system_schema.tables WHERE keyspace_name = :ks',
            { ks: 'scyllorm_fixes' },
            { raw: true }
        );

        expect(tables.map((row) => row.table_name)).toContain('readings');
    });

    it('reads camelCase properties back from the lowercased columns', async () => {
        await readings.save(reading('s1', 1000, 42, 'Kitchen'));

        const found = await readings.findOneBy({ sensorId: 's1' });

        expect(found?.sensorId).toBe('s1');
        expect(found?.takenAt).toEqual(new Date(1000));
        expect(String(found?.rawValue)).toBe('42');
        expect(found?.displayName).toBe('Kitchen');
    });

    it('accepts a Date and a driver Long in range conditions', async () => {
        await readings.save(reading('s2', 1000, 1, 'a'));
        await readings.save(reading('s2', 2000, 2, 'b'));
        await readings.save(reading('s2', 3000, 3, 'c'));

        const recent = await readings.find({ where: { sensorId: 's2', takenAt: GreaterThan(new Date(1500)) } });
        const window = await readings.find({
            where: { sensorId: 's2', takenAt: Between(new Date(1500), new Date(2500)) },
        });
        const byValue = await readings.find(
            { where: { sensorId: 's2', rawValue: GreaterThan(types.Long.fromNumber(2)) } },
            true
        );

        expect(recent.map((row) => row.displayName)).toEqual(['c', 'b']);
        expect(window.map((row) => row.displayName)).toEqual(['b']);
        expect(byValue.map((row) => row.displayName)).toEqual(['c']);
    });

    it('skips afterSave() when insertIfNotExists() is not applied', async () => {
        const calls: string[] = [];
        const duplicate = reading('s1', 1000, 99, 'Duplicate');
        duplicate.afterSave = () => {
            calls.push('afterSave');
        };

        const applied = await readings.insertIfNotExists(duplicate);

        expect(applied).toBe(false);
        expect(calls).toEqual([]);
    });

    it('a DataSource is usable again after shutdown()', async () => {
        const reused = new DataSource(OPTIONS);
        await reused.initialize();
        await reused.shutdown();
        await reused.initialize();

        try {
            await expect(reused.getRepository(Reading).findOneBy({ sensorId: 's1' })).resolves.not.toBeNull();
        } finally {
            await reused.shutdown();
        }
    });

    it('connects on the first query when initialize() was never called', async () => {
        const lazy = new DataSource(OPTIONS);

        try {
            await expect(lazy.getRepository(Reading).findOneBy({ sensorId: 's1' })).resolves.not.toBeNull();
        } finally {
            await lazy.shutdown();
        }
    });
});
