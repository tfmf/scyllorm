import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataSource } from '../DataSource';

// Mock the cassandra-driver module
vi.mock('cassandra-driver', () => {
    class MockClient {
        connect = vi.fn().mockResolvedValue(undefined);
        shutdown = vi.fn().mockResolvedValue(undefined);
        execute = vi.fn().mockResolvedValue({ rows: [] });
    }

    return {
        Client: MockClient,
        errors: {
            NoHostAvailableError: class NoHostAvailableError extends Error {},
            DriverInternalError: class DriverInternalError extends Error {},
        },
    };
});

// Reach the mocked driver client so tests can script connect/shutdown/execute behavior
/* eslint-disable @typescript-eslint/no-explicit-any */
function clientOf(ds: DataSource): {
    connect: ReturnType<typeof vi.fn>;
    shutdown: ReturnType<typeof vi.fn>;
    execute: ReturnType<typeof vi.fn>;
} {
    return (ds as any).client;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('DataSource retry/reconnect paths', () => {
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

    it('retries on NoHostAvailableError and eventually succeeds', async () => {
        const { errors } = await import('cassandra-driver');
        await ds.initialize();
        const client = clientOf(ds);

        client.execute
            .mockRejectedValueOnce(new errors.NoHostAvailableError({}))
            .mockRejectedValueOnce(new errors.NoHostAvailableError({}))
            .mockResolvedValueOnce({ rows: [{ id: 1 }], pageState: undefined });

        const result = await ds.executeQuery('SELECT * FROM test', []);

        expect(result).toEqual([{ id: 1 }]);
        expect(client.execute).toHaveBeenCalledTimes(3);
    });

    it('gives up after MAX_RETRIES (3) attempts and rejects with the error', async () => {
        const { errors } = await import('cassandra-driver');
        await ds.initialize();
        const client = clientOf(ds);

        client.execute.mockRejectedValue(new errors.NoHostAvailableError({}));

        await expect(ds.executeQuery('SELECT * FROM test', [])).rejects.toThrow(errors.NoHostAvailableError);
        // 1 initial attempt + 3 retries = 4 calls
        expect(client.execute).toHaveBeenCalledTimes(4);
    });

    it('rejects immediately on a plain Error without retrying', async () => {
        await ds.initialize();
        const client = clientOf(ds);

        client.execute.mockRejectedValue(new Error('boom'));

        await expect(ds.executeQuery('SELECT * FROM test', [])).rejects.toThrow('boom');
        expect(client.execute).toHaveBeenCalledTimes(1);
    });

    it('also retries on DriverInternalError', async () => {
        const { errors } = await import('cassandra-driver');
        await ds.initialize();
        const client = clientOf(ds);

        client.execute
            .mockRejectedValueOnce(new errors.DriverInternalError('internal'))
            .mockResolvedValueOnce({ rows: [{ id: 2 }], pageState: undefined });

        const result = await ds.executeQuery('SELECT * FROM test', []);

        expect(result).toEqual([{ id: 2 }]);
        expect(client.execute).toHaveBeenCalledTimes(2);
    });

    it('reconnects (shutdown + connect) when running a query while not connected', async () => {
        const client = clientOf(ds);
        expect(ds.isConnected()).toBe(false);

        const result = await ds.executeQuery('SELECT * FROM test', []);

        expect(client.shutdown).toHaveBeenCalledTimes(1);
        expect(client.connect).toHaveBeenCalledTimes(1);
        expect(ds.isConnected()).toBe(true);
        expect(result).toEqual([]);
    });

    it('shutdown() sets isConnected() to false', async () => {
        await ds.initialize();
        expect(ds.isConnected()).toBe(true);

        await ds.shutdown();

        expect(ds.isConnected()).toBe(false);
    });

    it('initialize() called twice only connects once', async () => {
        const client = clientOf(ds);

        await ds.initialize();
        await ds.initialize();

        expect(client.connect).toHaveBeenCalledTimes(1);
        expect(ds.isConnected()).toBe(true);
    });
});
