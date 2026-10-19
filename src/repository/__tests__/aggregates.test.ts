import { describe, it, expect, vi } from 'vitest';
import { types } from 'cassandra-driver';
import { DataSource } from '../../data-source/DataSource';
import { BaseModel } from '../../model/BaseModel';
import { Entity } from '../../decorators/Entity';
import { Column } from '../../decorators/Column';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';
import { InvalidQueryError, UnknownColumnError } from '../../errors';
import { Between, GreaterThan, In } from '../query-utils';

// Mock cassandra-driver
vi.mock('cassandra-driver', async (importOriginal) => {
    class MockClient {
        connect = vi.fn().mockResolvedValue(undefined);
        shutdown = vi.fn().mockResolvedValue(undefined);
        execute = vi.fn().mockResolvedValue({ rows: [] });
    }
    // Partial mock: the real value types (`types.Long`, `types.Uuid`, …) stay available
    return {
        ...(await importOriginal<typeof import('cassandra-driver')>()),
        Client: MockClient,
        errors: {
            NoHostAvailableError: class extends Error {},
            DriverInternalError: class extends Error {},
        },
    };
});

@Entity('readings')
class Reading extends BaseModel {
    @PrimaryKeyColumn('INT', { partitionKey: true })
    sensor: number;

    @PrimaryKeyColumn('INT', { clusteringKey: true })
    seq: number;

    @Column('INT')
    amount: number;

    @Column('BIGINT', { name: 'big_total' })
    bigTotal: types.Long;

    @Column('DECIMAL')
    price: types.BigDecimal;

    @Column('TEXT')
    label: string;

    @Column('TIMESTAMP')
    taken_at: Date;

    @Column('UUID')
    ref: string;

    @Column('LIST', { of: 'INT' })
    tags: number[];

    @Column('INT', { transformer: { to: (v: number) => v * 10, from: (v: number) => `L${v}` } })
    level: number | string;
}

function setup() {
    const ds = new DataSource({ contactPoints: ['x'], localDataCenter: 'dc1' } as never);
    const executed: Array<{ query: string; params: unknown[] }> = [];
    let response: unknown[] = [];

    vi.spyOn(ds, 'executeQuery').mockImplementation(async (query: string, params: unknown[]) => {
        executed.push({ query, params });
        return response as never;
    });

    return {
        repo: ds.getRepository(Reading),
        executed,
        setValue: (value: unknown) => {
            response = [{ value }];
        },
        setResponse: (rows: unknown[]) => {
            response = rows;
        },
    };
}

describe('Repository aggregates', () => {
    describe('query building', () => {
        it('emits exact CQL for each function', async () => {
            const { repo, executed, setValue } = setup();
            setValue(1);
            await repo.sum('amount', { sensor: 1 });
            await repo.avg('amount', { sensor: 1 });
            await repo.min('amount', { sensor: 1 });
            await repo.max('amount', { sensor: 1 });
            expect(executed.map((e) => e.query)).toEqual([
                'SELECT sum(amount) AS value FROM readings WHERE sensor = ?',
                'SELECT avg(amount) AS value FROM readings WHERE sensor = ?',
                'SELECT min(amount) AS value FROM readings WHERE sensor = ?',
                'SELECT max(amount) AS value FROM readings WHERE sensor = ?',
            ]);
            expect(executed[0].params).toEqual([1]);
        });

        it('appends ALLOW FILTERING when asked', async () => {
            const { repo, executed, setValue } = setup();
            setValue(1);
            await repo.sum('amount', { label: 'a' }, true);
            await repo.max('amount', { label: 'a' }, true);
            expect(executed[0].query).toBe('SELECT sum(amount) AS value FROM readings WHERE label = ? ALLOW FILTERING');
            expect(executed[1].query).toBe('SELECT max(amount) AS value FROM readings WHERE label = ? ALLOW FILTERING');
        });

        it('builds operator conditions', async () => {
            const { repo, executed, setValue } = setup();
            setValue(1);
            await repo.sum('amount', { sensor: In([1, 2]), seq: Between(1, 5) });
            await repo.min('amount', { sensor: 1, seq: GreaterThan(3) });
            expect(executed[0].query).toBe(
                'SELECT sum(amount) AS value FROM readings WHERE sensor IN (?, ?) AND seq >= ? AND seq <= ?'
            );
            expect(executed[0].params).toEqual([1, 2, 1, 5]);
            expect(executed[1].query).toBe('SELECT min(amount) AS value FROM readings WHERE sensor = ? AND seq > ?');
        });

        it('applies transformer.to to condition values', async () => {
            const { repo, executed, setValue } = setup();
            setValue(1);
            await repo.sum('amount', { level: 2 });
            expect(executed[0].params).toEqual([20]);
        });

        it('emits the column name option, not the property name', async () => {
            const { repo, executed, setValue } = setup();
            setValue(1);
            await repo.sum('bigTotal', { sensor: 1 });
            await repo.max('bigTotal', { sensor: 1 });
            expect(executed[0].query).toBe('SELECT sum(big_total) AS value FROM readings WHERE sensor = ?');
            expect(executed[1].query).toBe('SELECT max(big_total) AS value FROM readings WHERE sensor = ?');
        });
    });

    describe('validation', () => {
        it('rejects an unknown column before any query', async () => {
            const { repo, executed } = setup();
            for (const call of [
                () => repo.sum('nope' as never, { sensor: 1 }),
                () => repo.avg('nope' as never, { sensor: 1 }),
                () => repo.min('nope' as never, { sensor: 1 }),
                () => repo.max('nope' as never, { sensor: 1 }),
            ]) {
                await expect(call()).rejects.toBeInstanceOf(UnknownColumnError);
            }
            expect(executed).toHaveLength(0);
        });

        it('rejects a malformed column identifier', async () => {
            const { repo, executed } = setup();
            await expect(repo.sum('amount) FROM x --' as never, { sensor: 1 })).rejects.toThrow(
                /Invalid column identifier/
            );
            await expect(repo.max('a b' as never, { sensor: 1 })).rejects.toBeInstanceOf(InvalidQueryError);
            expect(executed).toHaveLength(0);
        });

        it('rejects sum and avg on non-numeric columns without querying', async () => {
            const { repo, executed } = setup();
            for (const column of ['label', 'tags', 'taken_at'] as const) {
                await expect(repo.sum(column, { sensor: 1 })).rejects.toThrow(
                    new RegExp(`sum\\(\\) cannot aggregate column .*${column}`)
                );
                await expect(repo.avg(column, { sensor: 1 })).rejects.toThrow(/avg\(\) cannot aggregate column/);
            }
            await expect(repo.sum('label', { sensor: 1 })).rejects.toBeInstanceOf(InvalidQueryError);
            expect(executed).toHaveLength(0);
        });

        it('names the entity and declared type in the error', async () => {
            const { repo } = setup();
            await expect(repo.sum('label', { sensor: 1 })).rejects.toThrow(/entity Reading.*declared TEXT/);
        });

        it('accepts min and max on non-numeric columns', async () => {
            const { repo, executed, setValue } = setup();
            setValue('x');
            await repo.min('label', { sensor: 1 });
            await repo.max('taken_at', { sensor: 1 });
            expect(executed).toHaveLength(2);
        });

        it('rejects empty conditions', async () => {
            const { repo, executed } = setup();
            await expect(repo.sum('amount', {})).rejects.toBeInstanceOf(InvalidQueryError);
            await expect(repo.min('amount', {})).rejects.toBeInstanceOf(InvalidQueryError);
            expect(executed).toHaveLength(0);
        });
    });

    describe('result handling', () => {
        it('returns numbers as given', async () => {
            const { repo, setValue } = setup();
            setValue(42);
            expect(await repo.sum('amount', { sensor: 1 })).toBe(42);
            expect(await repo.avg('amount', { sensor: 1 })).toBe(42);
        });

        it('passes Long and BigDecimal through untouched', async () => {
            const { repo, setValue } = setup();
            const long = types.Long.fromString('9007199254740993');
            setValue(long);
            expect(await repo.sum('bigTotal', { sensor: 1 })).toBe(long);
            const dec = types.BigDecimal.fromString('12.50');
            setValue(dec);
            expect(await repo.sum('price', { sensor: 1 })).toBe(dec);
            expect(await repo.max('price', { sensor: 1 })).toBe(dec);
        });

        it('turns a missing or null sum/avg into 0', async () => {
            const { repo, setResponse, setValue } = setup();
            setResponse([]);
            expect(await repo.sum('amount', { sensor: 1 })).toBe(0);
            setValue(null);
            expect(await repo.avg('amount', { sensor: 1 })).toBe(0);
            setResponse([{}]);
            expect(await repo.sum('amount', { sensor: 1 })).toBe(0);
        });

        it('does not run transformer.from on sum/avg', async () => {
            const { repo, setValue } = setup();
            setValue(7);
            expect(await repo.sum('level', { sensor: 1 })).toBe(7);
        });

        it('converts min/max like a read: TIMESTAMP to Date, UUID to string', async () => {
            const { repo, setValue } = setup();
            setValue(new Date(1000));
            const min = await repo.min('taken_at', { sensor: 1 });
            expect(min).toBeInstanceOf(Date);
            expect((min as Date).getTime()).toBe(1000);
            const uuid = types.Uuid.random();
            setValue(uuid);
            expect(await repo.max('ref', { sensor: 1 })).toBe(uuid.toString());
        });

        it('applies transformer.from to min/max', async () => {
            const { repo, setValue } = setup();
            setValue(3);
            expect(await repo.max('level', { sensor: 1 })).toBe('L3');
        });

        it('returns null for a null or missing min/max, without calling transformer.from', async () => {
            const { repo, setResponse, setValue } = setup();
            setValue(null);
            expect(await repo.min('level', { sensor: 1 })).toBeNull();
            setResponse([]);
            expect(await repo.max('level', { sensor: 1 })).toBeNull();
        });
    });
});
