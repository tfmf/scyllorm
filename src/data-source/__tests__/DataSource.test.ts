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
    });
});
