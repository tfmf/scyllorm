import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { errors } from 'cassandra-driver';
import { DataSource } from '../DataSource';
import { BaseModel } from '../../model';
import { Entity, PrimaryKeyColumn } from '../../decorators';

vi.mock('cassandra-driver', async (importOriginal) => {
    class MockClient {
        connect = vi.fn().mockResolvedValue(undefined);
        shutdown = vi.fn().mockResolvedValue(undefined);
        execute = vi.fn().mockResolvedValue({ rows: [] });
        batch = vi.fn().mockResolvedValue({ rows: [] });
    }

    // Partial mock: the real value types stay available
    return {
        ...(await importOriginal<typeof import('cassandra-driver')>()),
        Client: MockClient,
        errors: {
            NoHostAvailableError: class NoHostAvailableError extends Error {},
            DriverInternalError: class DriverInternalError extends Error {},
        },
    };
});

/* eslint-disable @typescript-eslint/no-explicit-any */
function executeOf(ds: DataSource): ReturnType<typeof vi.fn> {
    return (ds as any).client.execute;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const noHost = (): Error => new errors.NoHostAvailableError({});
const internal = (): Error => new errors.DriverInternalError('internal');

const WRITES = ['INSERT INTO t (id) VALUES (?)', 'UPDATE t SET a = ? WHERE id = ?', 'DELETE FROM t WHERE id = ?'];

function make(queryOptions?: { isIdempotent?: boolean }): DataSource {
    return new DataSource({
        contactPoints: ['localhost'],
        localDataCenter: 'datacenter1',
        keyspace: 'test',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        ...(queryOptions ? { queryOptions } : {}),
    } as ConstructorParameters<typeof DataSource>[0]);
}

@Entity('things')
class Thing extends BaseModel {
    @PrimaryKeyColumn('UUID', { partitionKey: true })
    id: string;
}

describe('DataSource idempotence-aware retries', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(Math, 'random').mockReturnValue(0);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    describe('inference from the query text', () => {
        it.each(['SELECT * FROM t', '   \n SELECT * FROM t', 'select * from t'])('retries %j', async (query) => {
            const ds = make();
            await ds.initialize();
            const execute = executeOf(ds);
            execute.mockRejectedValueOnce(noHost()).mockResolvedValueOnce({ rows: [{ id: 1 }] });

            await expect(ds.executeQuery(query, [])).resolves.toEqual([{ id: 1 }]);
            expect(execute).toHaveBeenCalledTimes(2);
        });

        it.each(WRITES)('does not retry %s on NoHostAvailableError', async (query) => {
            const ds = make();
            await ds.initialize();
            const execute = executeOf(ds);
            execute.mockRejectedValue(noHost());

            await expect(ds.executeQuery(query, [])).rejects.toBeInstanceOf(errors.NoHostAvailableError);
            expect(execute).toHaveBeenCalledTimes(1);
        });

        it.each(WRITES)('does not retry %s on DriverInternalError', async (query) => {
            const ds = make();
            await ds.initialize();
            const execute = executeOf(ds);
            execute.mockRejectedValue(internal());

            await expect(ds.executeQuery(query, [])).rejects.toBeInstanceOf(errors.DriverInternalError);
            expect(execute).toHaveBeenCalledTimes(1);
        });

        it('does not treat a query merely containing SELECT as a read', async () => {
            const ds = make();
            await ds.initialize();
            const execute = executeOf(ds);
            execute.mockRejectedValue(noHost());

            await expect(ds.executeQuery('INSERT INTO t (a) VALUES (?) -- SELECT', [])).rejects.toThrow();
            expect(execute).toHaveBeenCalledTimes(1);
        });
    });

    describe('explicit isIdempotent', () => {
        it('true makes a write retried', async () => {
            const ds = make();
            await ds.initialize();
            const execute = executeOf(ds);
            execute.mockRejectedValueOnce(noHost()).mockResolvedValueOnce({ rows: [] });

            await ds.executeQuery(WRITES[0], [], { prepare: true, isIdempotent: true });
            expect(execute).toHaveBeenCalledTimes(2);
        });

        it('false makes a SELECT not retried', async () => {
            const ds = make();
            await ds.initialize();
            const execute = executeOf(ds);
            execute.mockRejectedValue(noHost());

            await expect(ds.executeQuery('SELECT * FROM t', [], { isIdempotent: false })).rejects.toThrow();
            expect(execute).toHaveBeenCalledTimes(1);
        });

        it('client queryOptions.isIdempotent retries a write', async () => {
            const ds = make({ isIdempotent: true });
            await ds.initialize();
            const execute = executeOf(ds);
            execute.mockRejectedValueOnce(noHost()).mockResolvedValueOnce({ rows: [] });

            await ds.executeQuery(WRITES[0], []);
            expect(execute).toHaveBeenCalledTimes(2);
            expect(execute.mock.calls[0][2].isIdempotent).toBe(true);
        });

        it('client queryOptions.isIdempotent=false stops a SELECT being retried', async () => {
            const ds = make({ isIdempotent: false });
            await ds.initialize();
            const execute = executeOf(ds);
            execute.mockRejectedValue(noHost());

            await expect(ds.executeQuery('SELECT * FROM t', [])).rejects.toThrow();
            expect(execute).toHaveBeenCalledTimes(1);
        });

        it('the per-call option beats the client default', async () => {
            const ds = make({ isIdempotent: true });
            await ds.initialize();
            const execute = executeOf(ds);
            execute.mockRejectedValue(noHost());

            await expect(ds.executeQuery(WRITES[0], [], { isIdempotent: false })).rejects.toThrow();
            expect(execute).toHaveBeenCalledTimes(1);
            expect(execute.mock.calls[0][2].isIdempotent).toBe(false);
        });
    });

    describe('forwarding to client.execute', () => {
        it('executeQuery', async () => {
            const ds = make();
            await ds.initialize();
            const execute = executeOf(ds);

            await ds.executeQuery('SELECT * FROM t', []);
            await ds.executeQuery(WRITES[0], []);

            expect(execute.mock.calls[0][2].isIdempotent).toBe(true);
            expect(execute.mock.calls[1][2].isIdempotent).toBe(false);
        });

        it('executeQueryPage', async () => {
            const ds = make();
            await ds.initialize();
            const execute = executeOf(ds);

            await ds.executeQueryPage('SELECT * FROM t', []);
            await ds.executeQueryPage(WRITES[0], []);
            await ds.executeQueryPage(WRITES[0], [], { isIdempotent: true });

            expect(execute.mock.calls.map((c) => c[2].isIdempotent)).toEqual([true, false, true]);
        });

        it('streamQuery', async () => {
            const ds = make();
            await ds.initialize();
            const execute = executeOf(ds);
            execute.mockResolvedValue({ rows: [{ id: 1 }] });

            const rows: unknown[] = [];
            for await (const row of ds.streamQuery('SELECT * FROM t', [])) rows.push(row);
            for await (const row of ds.streamQuery('SELECT * FROM t', [], { isIdempotent: false })) rows.push(row);

            expect(rows).toHaveLength(2);
            expect(execute.mock.calls.map((c) => c[2].isIdempotent)).toEqual([true, false]);
        });
    });

    describe('backoff', () => {
        async function run(random: number, expected: number[]): Promise<void> {
            vi.useFakeTimers();
            vi.spyOn(Math, 'random').mockReturnValue(random);
            const ds = make();
            await ds.initialize();
            const execute = executeOf(ds);
            execute.mockRejectedValue(noHost());

            const result = ds.executeQuery('SELECT * FROM t', []);
            const settled = result.catch((e) => e);
            await vi.advanceTimersByTimeAsync(0);
            expect(execute).toHaveBeenCalledTimes(1);

            for (let i = 0; i < expected.length; i++) {
                await vi.advanceTimersByTimeAsync(expected[i] - 5);
                expect(execute).toHaveBeenCalledTimes(i + 1);
                await vi.advanceTimersByTimeAsync(5);
                expect(execute).toHaveBeenCalledTimes(i + 2);
            }

            expect(await settled).toBeInstanceOf(errors.NoHostAvailableError);
            expect(execute).toHaveBeenCalledTimes(4);
        }

        it('waits 25/50/100ms at the low end of the jitter', () => run(0, [25, 50, 100]));

        it('waits about 50/100/200ms at the high end of the jitter', () => {
            // 0.5 + 0.999 / 2 = 0.9995 of 50/100/200 -> 49.975 / 99.95 / 199.9; whole ms ceil to 50/100/200
            return run(0.999, [50, 100, 200]);
        });
    });

    it('gives up after 3 retries (4 calls)', async () => {
        const ds = make();
        await ds.initialize();
        const execute = executeOf(ds);
        execute.mockRejectedValue(internal());

        await expect(ds.executeQuery('SELECT * FROM t', [])).rejects.toBeInstanceOf(errors.DriverInternalError);
        expect(execute).toHaveBeenCalledTimes(4);
    });

    it('never retries a non-connection error, even when idempotent', async () => {
        const ds = make();
        await ds.initialize();
        const execute = executeOf(ds);
        execute.mockRejectedValue(new Error('boom'));

        await expect(ds.executeQuery('SELECT * FROM t', [], { isIdempotent: true })).rejects.toThrow('boom');
        expect(execute).toHaveBeenCalledTimes(1);
    });

    it('synchronize() passes prepare:false and isIdempotent:true', async () => {
        const ds = make();
        await ds.initialize();
        const execute = executeOf(ds);

        await ds.synchronize([Thing]);

        expect(execute).toHaveBeenCalled();
        for (const call of execute.mock.calls) {
            expect(call[2]).toMatchObject({ prepare: false, isIdempotent: true });
        }
    });
});
