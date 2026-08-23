import { describe, it, expect, vi } from 'vitest';
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

// Reach the mocked driver client so tests can script execute behavior
/* eslint-disable @typescript-eslint/no-explicit-any */
function clientOf(ds: DataSource): { execute: ReturnType<typeof vi.fn> } {
    return (ds as any).client;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function connectedDataSource(): Promise<DataSource> {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const ds = new DataSource({ contactPoints: ['127.0.0.1'], localDataCenter: 'dc1' });
    await ds.initialize();
    return ds;
}

// Regressions for two live-server shapes the happy-path mock never produces:
// a VOID result set (`rows` undefined — INSERT, UPDATE, DELETE, DDL) and an
// exhausted result set (`pageState` null, not undefined).
describe('DataSource with VOID result sets', () => {
    it('executeQuery should return [] when the driver returns no rows array', async () => {
        const ds = await connectedDataSource();
        clientOf(ds).execute.mockResolvedValue({ rows: undefined, pageState: undefined });

        await expect(ds.executeQuery('INSERT INTO t (id) VALUES (?)', [1])).resolves.toEqual([]);
    });

    it('executeQueryPage should return an empty page when the driver returns no rows array', async () => {
        const ds = await connectedDataSource();
        clientOf(ds).execute.mockResolvedValue({ rows: undefined, pageState: null });

        await expect(ds.executeQueryPage('TRUNCATE t', [])).resolves.toEqual({ rows: [], pageState: undefined });
    });

    it('streamQuery should complete without yielding when the driver returns no rows array', async () => {
        const ds = await connectedDataSource();
        clientOf(ds).execute.mockResolvedValue({ rows: undefined, pageState: null });

        const seen: unknown[] = [];
        for await (const row of ds.streamQuery('UPDATE t SET a = ? WHERE id = ?', [1, 2])) {
            seen.push(row);
        }

        expect(seen).toEqual([]);
    });

    it('executeQueryPage should normalize a null pageState to undefined on the final page', async () => {
        const ds = await connectedDataSource();
        clientOf(ds).execute.mockResolvedValue({ rows: [{ id: 1 }], pageState: null });

        const page = await ds.executeQueryPage<{ id: number }>('SELECT * FROM t', []);

        expect(page.rows).toEqual([{ id: 1 }]);
        expect(page.pageState).toBeUndefined();
        expect('pageState' in page && page.pageState === null).toBe(false);
    });

    it('executeQueryPage should still hand a real pageState through untouched', async () => {
        const ds = await connectedDataSource();
        clientOf(ds).execute.mockResolvedValue({ rows: [{ id: 1 }], pageState: 'cursor-1' });

        const page = await ds.executeQueryPage<{ id: number }>('SELECT * FROM t', []);

        expect(page.pageState).toBe('cursor-1');
    });

    it('executeQuery should still walk real pages to exhaustion', async () => {
        const ds = await connectedDataSource();
        clientOf(ds)
            .execute.mockResolvedValueOnce({ rows: [{ id: 1 }], pageState: 'cursor-1' })
            .mockResolvedValueOnce({ rows: [{ id: 2 }], pageState: null });

        await expect(ds.executeQuery('SELECT * FROM t', [])).resolves.toEqual([{ id: 1 }, { id: 2 }]);
        expect(clientOf(ds).execute).toHaveBeenCalledTimes(2);
    });
});
