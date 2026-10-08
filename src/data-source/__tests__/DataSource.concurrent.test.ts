import { describe, it, expect, vi, beforeEach } from 'vitest';
import { errors } from 'cassandra-driver';
import { DataSource, mapConcurrent } from '../DataSource';
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
        errors: {
            NoHostAvailableError: class NoHostAvailableError extends Error {},
            DriverInternalError: class DriverInternalError extends Error {},
        },
    };
});

interface Deferred<T = void> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('mapConcurrent()', () => {
    it('preserves result order when fn resolves out of order', async () => {
        const gates = [deferred(), deferred(), deferred()];
        const result = mapConcurrent([0, 1, 2], 3, async (i) => {
            await gates[i].promise;
            return `r${i}`;
        });

        gates[2].resolve();
        await tick();
        gates[0].resolve();
        await tick();
        gates[1].resolve();

        expect(await result).toEqual(['r0', 'r1', 'r2']);
    });

    it('never exceeds the concurrency limit', async () => {
        let inFlight = 0;
        let max = 0;
        const gates = Array.from({ length: 10 }, () => deferred());

        const result = mapConcurrent(gates, 3, async (gate) => {
            inFlight++;
            max = Math.max(max, inFlight);
            await gate.promise;
            inFlight--;
        });

        await tick();
        expect(inFlight).toBe(3);
        for (const gate of gates) {
            gate.resolve();
            await tick();
        }
        await result;

        expect(max).toBe(3);
    });

    it('works when concurrency is larger than the item count', async () => {
        expect(await mapConcurrent([1, 2], 50, async (n) => n * 2)).toEqual([2, 4]);
    });

    it('returns [] without calling fn for no items', async () => {
        const fn = vi.fn();
        expect(await mapConcurrent([], 5, fn)).toEqual([]);
        expect(fn).not.toHaveBeenCalled();
    });

    it.each([0, -1, 1.5, NaN, Infinity, 2 ** 53, '2', null])('rejects invalid concurrency %s', async (bad) => {
        const fn = vi.fn().mockResolvedValue(1);

        await expect(mapConcurrent([1, 2], bad as never, fn)).rejects.toThrow(InvalidQueryError);
        expect(fn).not.toHaveBeenCalled();
    });

    it('defaults to 100 in flight', async () => {
        let inFlight = 0;
        let max = 0;
        const gate = deferred();

        const result = mapConcurrent(
            Array.from({ length: 150 }, (_, i) => i),
            undefined,
            async () => {
                inFlight++;
                max = Math.max(max, inFlight);
                await gate.promise;
                inFlight--;
            }
        );

        await tick();
        expect(inFlight).toBe(100);
        gate.resolve();
        await result;

        expect(max).toBe(100);
    });

    it('starts nothing new after a failure, awaits in-flight work, and rejects with the first error', async () => {
        const started: number[] = [];
        const gates = [deferred(), deferred()];
        let slowDone = false;

        const result = mapConcurrent([0, 1, 2, 3], 2, async (i) => {
            started.push(i);
            await gates[i].promise;
            if (i === 1) {
                await tick();
                slowDone = true;
                throw new Error('second');
            }
        });
        const settled = result.then(
            () => 'resolved',
            (error: Error) => error.message
        );

        await tick();
        gates[0].reject(new Error('first'));
        await tick();
        // item 1 is still in flight, so the promise must not have settled yet
        let early = true;
        void settled.then(() => (early = false));
        await tick();
        expect(early).toBe(true);

        gates[1].resolve();

        expect(await settled).toBe('first');
        expect(slowDone).toBe(true);
        expect(started).toEqual([0, 1]);
    });
});

describe('DataSource.executeConcurrent()', () => {
    let ds: DataSource;
    let execute: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
        ds = new DataSource({ contactPoints: ['x'], localDataCenter: 'dc1', logger });
        await ds.initialize();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        execute = (ds as any).client.execute;
    });

    it('never retries a counter statement, whatever the caller or client default says', async () => {
        const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
        const eager = new DataSource({
            contactPoints: ['x'],
            localDataCenter: 'dc1',
            logger,
            queryOptions: { isIdempotent: true },
        });
        await eager.initialize();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const run = (eager as any).client.execute as ReturnType<typeof vi.fn>;
        run.mockRejectedValue(new errors.NoHostAvailableError({}));
        const counter = { query: 'UPDATE t SET hits = hits + ? WHERE id = ?', params: [1, 1], counter: true };

        await expect(eager.executeConcurrent([counter], { isIdempotent: true })).rejects.toBeInstanceOf(
            errors.NoHostAvailableError
        );

        expect(run).toHaveBeenCalledTimes(1);
        expect(run.mock.calls[0][2]).toMatchObject({ isIdempotent: false });
    });

    it('executes each statement prepared and returns rows per statement in order', async () => {
        execute.mockImplementation(async (query: string) => ({ rows: [{ q: query }] }));

        const rows = await ds.executeConcurrent([
            { query: 'SELECT a FROM t WHERE id = ?', params: [1] },
            { query: 'SELECT b FROM t WHERE id = ?', params: [2] },
        ]);

        expect(rows).toEqual([[{ q: 'SELECT a FROM t WHERE id = ?' }], [{ q: 'SELECT b FROM t WHERE id = ?' }]]);
        expect(execute).toHaveBeenCalledTimes(2);
        expect(execute.mock.calls[0][1]).toEqual([1]);
        expect(execute.mock.calls[0][2]).toMatchObject({ prepare: true });
        expect(execute.mock.calls[1][2]).toMatchObject({ prepare: true });
    });

    it('forwards caller options but not concurrency', async () => {
        await ds.executeConcurrent([{ query: 'UPDATE t SET a = ? WHERE id = ?', params: [1, 2] }], {
            concurrency: 2,
            consistency: 4,
            isIdempotent: true,
        });

        const sent = execute.mock.calls[0][2];
        expect(sent).toMatchObject({ prepare: true, consistency: 4, isIdempotent: true });
        expect(sent).not.toHaveProperty('concurrency');
    });

    it('honors prepare: false', async () => {
        await ds.executeConcurrent([{ query: 'SELECT 1', params: [] }], { prepare: false });

        expect(execute.mock.calls[0][2]).toMatchObject({ prepare: false });
    });

    it('rejects invalid concurrency without executing', async () => {
        await expect(ds.executeConcurrent([{ query: 'SELECT 1', params: [] }], { concurrency: 0 })).rejects.toThrow(
            InvalidQueryError
        );
        expect(execute).not.toHaveBeenCalled();
    });

    it('does not retry a non-SELECT statement by default', async () => {
        execute.mockRejectedValue(new errors.NoHostAvailableError({}));

        await expect(
            ds.executeConcurrent([{ query: 'INSERT INTO t (id) VALUES (?)', params: [1] }])
        ).rejects.toBeInstanceOf(errors.NoHostAvailableError);
        expect(execute).toHaveBeenCalledTimes(1);
    });

    it('retries a non-SELECT statement when isIdempotent: true', async () => {
        execute.mockRejectedValueOnce(new errors.NoHostAvailableError({})).mockResolvedValue({ rows: [] });

        await ds.executeConcurrent([{ query: 'INSERT INTO t (id) VALUES (?)', params: [1] }], { isIdempotent: true });

        expect(execute).toHaveBeenCalledTimes(2);
    });
});
