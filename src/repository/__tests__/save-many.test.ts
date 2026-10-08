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
    return {
        ...(await importOriginal<typeof import('cassandra-driver')>()),
        Client: MockClient,
    };
});

const events: string[] = [];

@Entity('people')
class Person extends BaseModel {
    @PrimaryKeyColumn('TEXT')
    id: string;

    @Column('TEXT')
    name: string;

    beforeSave(): void {
        events.push(`before:${this.id}`);
    }

    afterSave(): void {
        events.push(`after:${this.id}`);
    }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('Repository.saveMany()', () => {
    let repo: Repository<Person>;
    let execute: ReturnType<typeof vi.fn>;

    const people = (n: number) => Array.from({ length: n }, (_, i) => repo.create({ id: `p${i}`, name: `n${i}` }));

    beforeEach(async () => {
        events.length = 0;
        const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
        const ds = new DataSource({ contactPoints: ['x'], localDataCenter: 'dc1', logger });
        await ds.initialize();
        execute = (ds as any).client.execute;
        execute.mockResolvedValue({ rows: [] });
        repo = ds.getRepository(Person);
    });

    it('saves every entity, runs the hooks, and returns the same instances in order', async () => {
        const list = people(3);

        const saved = await repo.saveMany(list);

        expect(saved).toHaveLength(3);
        saved.forEach((entity, i) => expect(entity).toBe(list[i]));
        expect(execute).toHaveBeenCalledTimes(3);
        expect(execute.mock.calls.map((c) => c[1][0]).sort()).toEqual(['p0', 'p1', 'p2']);
        for (const id of ['p0', 'p1', 'p2']) {
            expect(events.indexOf(`before:${id}`)).toBeLessThan(events.indexOf(`after:${id}`));
            expect(events).toContain(`before:${id}`);
        }
    });

    it('returns [] for an empty list', async () => {
        expect(await repo.saveMany([])).toEqual([]);
        expect(execute).not.toHaveBeenCalled();
    });

    it('forwards ttl, consistency and timestamp to each INSERT but not concurrency', async () => {
        await repo.saveMany(people(2), { ttl: 60, consistency: 4, timestamp: 1700000000000000, concurrency: 1 });

        expect(execute).toHaveBeenCalledTimes(2);
        for (const [query, params, opts] of execute.mock.calls) {
            expect(query).toContain('USING TTL ? AND TIMESTAMP ?');
            expect(params).toContain(60);
            expect(params).toContainEqual(types.Long.fromNumber(1700000000000000));
            expect(opts).toMatchObject({ consistency: 4, isIdempotent: true });
            expect(opts).not.toHaveProperty('concurrency');
        }
    });

    it('accepts a Long timestamp', async () => {
        await repo.saveMany(people(1), { timestamp: types.Long.fromNumber(5) });

        expect(execute.mock.calls[0][0]).toContain('USING TIMESTAMP ?');
    });

    it('respects concurrency', async () => {
        let inFlight = 0;
        let max = 0;
        execute.mockImplementation(async () => {
            inFlight++;
            max = Math.max(max, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 5));
            inFlight--;
            return { rows: [] };
        });

        await repo.saveMany(people(8), { concurrency: 2 });

        expect(max).toBe(2);
        expect(execute).toHaveBeenCalledTimes(8);
    });

    it('rejects when one entity fails validation', async () => {
        const list = people(3);
        (list[1] as any).name = 123;

        await expect(repo.saveMany(list, { concurrency: 1 })).rejects.toThrow();
        // concurrency 1 and a failure at index 1: the third is never started
        expect(execute).toHaveBeenCalledTimes(1);
    });

    it.each([0, -1, 1.5, NaN])('rejects invalid concurrency %s', async (concurrency) => {
        await expect(repo.saveMany(people(2), { concurrency })).rejects.toThrow(InvalidQueryError);
        expect(execute).not.toHaveBeenCalled();
    });
});
