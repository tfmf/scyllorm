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

// Reach the mocked driver client so tests can script page-by-page responses
/* eslint-disable @typescript-eslint/no-explicit-any */
function executeMock(ds: DataSource): ReturnType<typeof vi.fn> {
    return (ds as any).client.execute;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('DataSource', () => {
    let ds: DataSource;

    beforeEach(() => {
        vi.clearAllMocks();
        ds = new DataSource({
            contactPoints: ['localhost'],
            localDataCenter: 'datacenter1',
            keyspace: 'test',
        });
    });

    describe('initialize()', () => {
        it('should set connected to true after successful connection', async () => {
            expect(ds.isConnected()).toBe(false);
            await ds.initialize();
            expect(ds.isConnected()).toBe(true);
        });

        it('should not reconnect if already connected', async () => {
            await ds.initialize();
            await ds.initialize();
            expect(ds.isConnected()).toBe(true);
        });
    });

    describe('shutdown()', () => {
        it('should reset connected flag to false', async () => {
            await ds.initialize();
            expect(ds.isConnected()).toBe(true);

            await ds.shutdown();
            expect(ds.isConnected()).toBe(false);
        });
    });

    describe('executeQuery()', () => {
        it('should return an array (never null)', async () => {
            await ds.initialize();
            const result = await ds.executeQuery('SELECT * FROM test', []);
            expect(result).toBeInstanceOf(Array);
            expect(result).not.toBeNull();
        });

        it('should read every page of the result set', async () => {
            await ds.initialize();
            const execute = executeMock(ds)
                .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }], pageState: 'page-2' })
                .mockResolvedValueOnce({ rows: [{ id: 3 }], pageState: 'page-3' })
                .mockResolvedValueOnce({ rows: [{ id: 4 }], pageState: undefined });

            const result = await ds.executeQuery('SELECT * FROM test', []);

            expect(result).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
            expect(execute).toHaveBeenCalledTimes(3);
        });

        it('should pass the previous pageState when fetching the next page', async () => {
            await ds.initialize();
            const execute = executeMock(ds)
                .mockResolvedValueOnce({ rows: [{ id: 1 }], pageState: 'page-2' })
                .mockResolvedValueOnce({ rows: [{ id: 2 }], pageState: undefined });

            await ds.executeQuery('SELECT * FROM test', []);

            expect(execute.mock.calls[0][2]).toMatchObject({ pageState: undefined });
            expect(execute.mock.calls[1][2]).toMatchObject({ pageState: 'page-2' });
        });

        it('should stop after one page when the result set is exhausted', async () => {
            await ds.initialize();
            const execute = executeMock(ds).mockResolvedValue({ rows: [{ id: 1 }], pageState: undefined });

            const result = await ds.executeQuery('SELECT * FROM test', []);

            expect(result).toEqual([{ id: 1 }]);
            expect(execute).toHaveBeenCalledTimes(1);
        });
    });

    describe('executeQueryPage()', () => {
        it('should return a single page and its cursor', async () => {
            await ds.initialize();
            const execute = executeMock(ds).mockResolvedValue({ rows: [{ id: 1 }], pageState: 'page-2' });

            const result = await ds.executeQueryPage('SELECT * FROM test', []);

            expect(result).toEqual({ rows: [{ id: 1 }], pageState: 'page-2' });
            expect(execute).toHaveBeenCalledTimes(1);
        });

        it('should report no cursor on the last page', async () => {
            await ds.initialize();
            executeMock(ds).mockResolvedValue({ rows: [{ id: 1 }], pageState: undefined });

            const result = await ds.executeQueryPage('SELECT * FROM test', []);

            expect(result.pageState).toBeUndefined();
        });
    });

    describe('streamQuery()', () => {
        it('should yield rows across page boundaries', async () => {
            await ds.initialize();
            const execute = executeMock(ds)
                .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }], pageState: 'page-2' })
                .mockResolvedValueOnce({ rows: [{ id: 3 }], pageState: undefined });

            const rows = [];
            for await (const row of ds.streamQuery('SELECT * FROM test', [])) {
                rows.push(row);
            }

            expect(rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
            expect(execute).toHaveBeenCalledTimes(2);
        });

        it('should fetch pages lazily, not upfront', async () => {
            await ds.initialize();
            const execute = executeMock(ds)
                .mockResolvedValueOnce({ rows: [{ id: 1 }], pageState: 'page-2' })
                .mockResolvedValueOnce({ rows: [{ id: 2 }], pageState: undefined });

            const iterator = ds.streamQuery('SELECT * FROM test', []);
            await iterator.next();

            // Only the first page should have been read so far
            expect(execute).toHaveBeenCalledTimes(1);
        });
    });
});
