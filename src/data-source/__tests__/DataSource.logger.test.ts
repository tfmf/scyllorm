import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataSource } from '../DataSource';

const constructed: unknown[] = [];

vi.mock('cassandra-driver', async (importOriginal) => {
    const original = await importOriginal<typeof import('cassandra-driver')>();

    class MockClient {
        connect = vi.fn().mockResolvedValue(undefined);
        shutdown = vi.fn().mockResolvedValue(undefined);
        execute = vi.fn().mockResolvedValue({ rows: [] });

        constructor(options: unknown) {
            constructed.push(options);
        }
    }

    return { ...original, Client: MockClient };
});

/* eslint-disable @typescript-eslint/no-explicit-any */
function clientOf(ds: DataSource): { connect: ReturnType<typeof vi.fn>; execute: ReturnType<typeof vi.fn> } {
    return (ds as any).client;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function recordingLogger() {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('DataSource logger', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        constructed.length = 0;
    });

    it('sends connection and query events to the given logger instead of console', async () => {
        const consoleSpies = (['log', 'info', 'warn', 'error'] as const).map((method) =>
            vi.spyOn(console, method).mockImplementation(() => undefined)
        );
        const logger = recordingLogger();
        const ds = new DataSource({ contactPoints: ['x'], localDataCenter: 'dc1', logger });

        // Not connected, so the first query reconnects on a fresh client (warn + info)
        await ds.executeQuery('SELECT 1', []);
        clientOf(ds).execute.mockRejectedValueOnce(new Error('boom'));
        await expect(ds.executeQuery('SELECT 1', [])).rejects.toThrow('boom');

        expect(logger.warn).toHaveBeenCalledWith('ScyllaDB is not connected. Attempting to reconnect...');
        expect(logger.info).toHaveBeenCalledWith('Reconnecting to ScyllaDB...');
        expect(logger.info).toHaveBeenCalledWith('Connected to ScyllaDB successfully.');
        expect(logger.error).toHaveBeenCalledWith('Query failed: Error: boom');
        consoleSpies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
    });

    it('logs a failed connect to the logger before rethrowing', async () => {
        const logger = recordingLogger();
        const ds = new DataSource({ contactPoints: ['x'], localDataCenter: 'dc1', logger });
        const failure = new Error('refused');
        clientOf(ds).connect.mockRejectedValueOnce(failure);

        await expect(ds.initialize()).rejects.toBe(failure);

        expect(logger.error).toHaveBeenCalledWith('Failed to connect to ScyllaDB.', failure);
    });

    it('defaults to console', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        const ds = new DataSource({ contactPoints: ['x'], localDataCenter: 'dc1' });

        await ds.initialize();

        expect(info).toHaveBeenCalledWith('Connected to ScyllaDB successfully.');
    });

    it('does not pass the logger on to the driver, including on the client rebuilt after shutdown', async () => {
        const ds = new DataSource({ contactPoints: ['x'], localDataCenter: 'dc1', logger: recordingLogger() });

        await ds.initialize();
        await ds.shutdown();
        await ds.initialize();

        expect(constructed).toEqual([
            { contactPoints: ['x'], localDataCenter: 'dc1' },
            { contactPoints: ['x'], localDataCenter: 'dc1' },
        ]);
    });
});
