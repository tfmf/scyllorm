import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataSource } from '../DataSource';
import { InvalidQueryError } from '../../errors';
import { BatchStatement } from '../../repository/query-utils';

vi.mock('cassandra-driver', async (importOriginal) => {
    class MockClient {
        connect = vi.fn().mockResolvedValue(undefined);
        shutdown = vi.fn().mockResolvedValue(undefined);
        execute = vi.fn().mockResolvedValue({ rows: [] });
        batch = vi.fn().mockResolvedValue({ rows: [] });
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

/* eslint-disable @typescript-eslint/no-explicit-any */
const clientOf = (ds: DataSource): { batch: ReturnType<typeof vi.fn> } => (ds as any).client;
/* eslint-enable @typescript-eslint/no-explicit-any */

const plain: BatchStatement[] = [
    { query: 'INSERT INTO t (id) VALUES (?)', params: ['a'] },
    { query: 'DELETE FROM t WHERE id = ?', params: ['b'] },
];
const counters: BatchStatement[] = [
    { query: 'UPDATE c SET n = n + ? WHERE id = ?', params: [1, 'a'], counter: true },
    { query: 'UPDATE c SET n = n - ? WHERE id = ?', params: [2, 'b'], counter: true },
];

describe('DataSource.executeBatch() options and inference', () => {
    let ds: DataSource;
    let client: ReturnType<typeof clientOf>;

    const lastOptions = (): Record<string, unknown> => client.batch.mock.calls[0][1];

    beforeEach(async () => {
        vi.clearAllMocks();
        for (const m of ['warn', 'error', 'info', 'log'] as const) {
            vi.spyOn(console, m).mockImplementation(() => undefined);
        }
        ds = new DataSource({ contactPoints: ['localhost'], localDataCenter: 'datacenter1', keyspace: 'test' });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (ds as any).RETRY_BASE_DELAY_MS = 0;
        await ds.initialize();
        client = clientOf(ds);
    });

    it('never retries a counter batch, even with queryOptions.isIdempotent: true', async () => {
        const { errors } = await import('cassandra-driver');
        const eager = new DataSource({
            contactPoints: ['localhost'],
            localDataCenter: 'datacenter1',
            queryOptions: { isIdempotent: true },
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (eager as any).RETRY_BASE_DELAY_MS = 0;
        await eager.initialize();
        const batch = clientOf(eager).batch;
        batch.mockRejectedValue(new errors.NoHostAvailableError({}));

        await expect(eager.executeBatch(counters)).rejects.toBeInstanceOf(errors.NoHostAvailableError);

        expect(batch).toHaveBeenCalledTimes(1);
        expect(batch.mock.calls[0][1]).toMatchObject({ counter: true, isIdempotent: false });
    });

    it('sends logged:false together with prepare:true', async () => {
        await ds.executeBatch(plain, { logged: false });

        expect(lastOptions()).toMatchObject({ logged: false, prepare: true });
    });

    it('honors prepare:false', async () => {
        await ds.executeBatch(plain, { prepare: false });

        expect(lastOptions().prepare).toBe(false);
    });

    it('forwards consistency', async () => {
        await ds.executeBatch(plain, { consistency: 6 });

        expect(lastOptions().consistency).toBe(6);
    });

    it('treats an all-counter batch as a non-idempotent counter batch', async () => {
        await ds.executeBatch(counters);

        expect(lastOptions()).toMatchObject({ counter: true, isIdempotent: false });
    });

    it('treats a plain batch as an idempotent non-counter batch', async () => {
        await ds.executeBatch(plain);

        expect(lastOptions()).toMatchObject({ counter: false, isIdempotent: true });
    });

    it.each([
        'INSERT INTO t (id) VALUES (?) IF NOT EXISTS',
        'DELETE FROM t WHERE id = ? IF EXISTS',
        'UPDATE t SET a = ? WHERE id = ? IF a = ?',
    ])('marks a batch with a conditional statement non-idempotent: %s', async (query) => {
        await ds.executeBatch([plain[0], { query, params: [] }]);

        expect(lastOptions().isIdempotent).toBe(false);
    });

    it.each([
        "INSERT INTO t (id, body) VALUES (1, 'what if')",
        "INSERT INTO t (id, body) VALUES (1, 'it''s if')",
        'UPDATE t SET "if" = ? WHERE id = ?',
    ])('ignores an IF inside a literal or quoted identifier: %s', async (query) => {
        await ds.executeBatch([{ query, params: [] }]);

        expect(lastOptions().isIdempotent).toBe(true);
    });

    it("still sees a condition after a literal: UPDATE t SET a = 'x' WHERE id = 1 IF a = 'y'", async () => {
        await ds.executeBatch([{ query: "UPDATE t SET a = 'x' WHERE id = 1 IF a = 'y'", params: [] }]);

        expect(lastOptions().isIdempotent).toBe(false);
    });

    it('lets options.isIdempotent override inference', async () => {
        await ds.executeBatch(counters, { isIdempotent: true });
        expect(lastOptions().isIdempotent).toBe(true);

        client.batch.mockClear();
        await ds.executeBatch(plain, { isIdempotent: false });
        expect(lastOptions().isIdempotent).toBe(false);
    });

    it('lets options.counter override inference', async () => {
        await ds.executeBatch(plain, { counter: true });
        expect(lastOptions().counter).toBe(true);

        client.batch.mockClear();
        await ds.executeBatch(counters, { counter: false });
        expect(lastOptions().counter).toBe(false);
    });

    it('rejects a counter statement mixed with regular ones before touching the driver', async () => {
        const promise = ds.executeBatch([plain[0], counters[0]]);

        await expect(promise).rejects.toThrow(InvalidQueryError);
        await expect(promise).rejects.toThrow(/mix/i);
        expect(client.batch).not.toHaveBeenCalled();
    });

    it('strips the counter marker from the queries sent to the driver', async () => {
        await ds.executeBatch(counters);

        const sent = client.batch.mock.calls[0][0] as Array<Record<string, unknown>>;
        expect(sent).toHaveLength(2);
        for (const s of sent) {
            expect(s).not.toHaveProperty('counter');
            expect(Object.keys(s).sort()).toEqual(['params', 'query']);
        }
        expect(sent[0]).toEqual({ query: counters[0].query, params: counters[0].params });
    });

    it('retries an idempotent batch on NoHostAvailableError', async () => {
        const { errors } = await import('cassandra-driver');
        client.batch.mockRejectedValueOnce(new errors.NoHostAvailableError({})).mockResolvedValueOnce({ rows: [] });

        await ds.executeBatch(plain);

        expect(client.batch).toHaveBeenCalledTimes(2);
    });

    it('does not retry a counter batch', async () => {
        const { errors } = await import('cassandra-driver');
        client.batch.mockRejectedValue(new errors.NoHostAvailableError({}));

        await expect(ds.executeBatch(counters)).rejects.toThrow(errors.NoHostAvailableError);

        expect(client.batch).toHaveBeenCalledTimes(1);
    });

    it('does not retry a conditional batch', async () => {
        const { errors } = await import('cassandra-driver');
        client.batch.mockRejectedValue(new errors.NoHostAvailableError({}));

        await expect(
            ds.executeBatch([{ query: 'INSERT INTO t (id) VALUES (?) IF NOT EXISTS', params: ['a'] }])
        ).rejects.toThrow(errors.NoHostAvailableError);

        expect(client.batch).toHaveBeenCalledTimes(1);
    });
});
