import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataSource } from '../DataSource';
import { InvalidQueryError } from '../../errors';
import { BatchStatement } from '../../repository/query-utils';

// Mock the cassandra-driver module
vi.mock('cassandra-driver', () => {
    class MockClient {
        connect = vi.fn().mockResolvedValue(undefined);
        shutdown = vi.fn().mockResolvedValue(undefined);
        execute = vi.fn().mockResolvedValue({ rows: [] });
        batch = vi.fn().mockResolvedValue({ rows: [] });
    }

    return {
        Client: MockClient,
        errors: {
            NoHostAvailableError: class NoHostAvailableError extends Error {},
            DriverInternalError: class DriverInternalError extends Error {},
        },
    };
});

// Reach the mocked driver client so tests can script connect/shutdown/batch behavior
/* eslint-disable @typescript-eslint/no-explicit-any */
function clientOf(ds: DataSource): {
    connect: ReturnType<typeof vi.fn>;
    shutdown: ReturnType<typeof vi.fn>;
    batch: ReturnType<typeof vi.fn>;
} {
    return (ds as any).client;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const statements: BatchStatement[] = [
    { query: 'INSERT INTO t (id) VALUES (?)', params: ['a'] },
    { query: 'DELETE FROM t WHERE id = ?', params: ['b'] },
];

describe('DataSource.executeBatch()', () => {
    let ds: DataSource;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(console, 'info').mockImplementation(() => undefined);
        vi.spyOn(console, 'log').mockImplementation(() => undefined);

        ds = new DataSource({
            contactPoints: ['localhost'],
            localDataCenter: 'datacenter1',
            keyspace: 'test',
        });
    });

    it('passes the statements and options through to client.batch', async () => {
        await ds.initialize();
        const client = clientOf(ds);

        await ds.executeBatch(statements);

        expect(client.batch).toHaveBeenCalledTimes(1);
        expect(client.batch).toHaveBeenCalledWith(statements, { prepare: true });
    });

    it('forwards caller-supplied query options', async () => {
        await ds.initialize();
        const client = clientOf(ds);

        await ds.executeBatch(statements, { prepare: true, consistency: 6 });

        expect(client.batch).toHaveBeenCalledWith(statements, { prepare: true, consistency: 6 });
    });

    it('throws InvalidQueryError on an empty batch without touching the driver', async () => {
        await ds.initialize();
        const client = clientOf(ds);

        await expect(ds.executeBatch([])).rejects.toThrow(InvalidQueryError);
        expect(client.batch).not.toHaveBeenCalled();
    });

    it('retries on NoHostAvailableError and eventually succeeds', async () => {
        const { errors } = await import('cassandra-driver');
        await ds.initialize();
        const client = clientOf(ds);

        client.batch
            .mockRejectedValueOnce(new errors.NoHostAvailableError({}))
            .mockRejectedValueOnce(new errors.NoHostAvailableError({}))
            .mockResolvedValueOnce({ rows: [] });

        await ds.executeBatch(statements);

        expect(client.batch).toHaveBeenCalledTimes(3);
    });

    it('gives up after MAX_RETRIES (3) attempts and rejects with the error', async () => {
        const { errors } = await import('cassandra-driver');
        await ds.initialize();
        const client = clientOf(ds);

        client.batch.mockRejectedValue(new errors.NoHostAvailableError({}));

        await expect(ds.executeBatch(statements)).rejects.toThrow(errors.NoHostAvailableError);
        // 1 initial attempt + 3 retries = 4 calls
        expect(client.batch).toHaveBeenCalledTimes(4);
    });

    it('also retries on DriverInternalError', async () => {
        const { errors } = await import('cassandra-driver');
        await ds.initialize();
        const client = clientOf(ds);

        client.batch
            .mockRejectedValueOnce(new errors.DriverInternalError('internal'))
            .mockResolvedValueOnce({ rows: [] });

        await ds.executeBatch(statements);

        expect(client.batch).toHaveBeenCalledTimes(2);
    });

    it('rejects immediately on a plain Error without retrying', async () => {
        await ds.initialize();
        const client = clientOf(ds);

        client.batch.mockRejectedValue(new Error('boom'));

        await expect(ds.executeBatch(statements)).rejects.toThrow('boom');
        expect(client.batch).toHaveBeenCalledTimes(1);
    });

    it('reconnects (shutdown + connect) when running a batch while not connected', async () => {
        const client = clientOf(ds);
        expect(ds.isConnected()).toBe(false);

        await ds.executeBatch(statements);

        expect(client.shutdown).toHaveBeenCalledTimes(1);
        expect(client.connect).toHaveBeenCalledTimes(1);
        expect(ds.isConnected()).toBe(true);
    });
});
