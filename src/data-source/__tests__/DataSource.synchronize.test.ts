import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataSource } from '../DataSource';
import { BaseModel } from '../../model/BaseModel';
import { Entity } from '../../decorators/Entity';
import { Column } from '../../decorators/Column';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';
import { Index } from '../../decorators/IndexDecorator';

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

// Reach the mocked driver client so tests can inspect the executed statements
/* eslint-disable @typescript-eslint/no-explicit-any */
function executeMock(ds: DataSource): ReturnType<typeof vi.fn> {
    return (ds as any).client.execute;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

@Entity('users')
@Index('users_by_email', 'email')
class User extends BaseModel {
    @PrimaryKeyColumn('UUID', { partitionKey: true })
    id: string;

    @Column('TEXT')
    email: string;
}

@Entity('items')
class Item extends BaseModel {
    @PrimaryKeyColumn('UUID', { partitionKey: true })
    id: string;

    @Column('TEXT')
    name: string;
}

describe('DataSource.synchronize()', () => {
    let ds: DataSource;

    beforeEach(async () => {
        vi.clearAllMocks();
        ds = new DataSource({
            contactPoints: ['localhost'],
            localDataCenter: 'datacenter1',
            keyspace: 'test',
        });
        await ds.initialize();
    });

    it('executes every DDL statement in order, table before indexes', async () => {
        await ds.synchronize([User, Item]);

        const statements = executeMock(ds).mock.calls.map((call) => call[0]);
        expect(statements).toEqual([
            'CREATE TABLE IF NOT EXISTS users (id uuid, email text, PRIMARY KEY (id))',
            'CREATE INDEX IF NOT EXISTS users_by_email ON users (email)',
            'CREATE TABLE IF NOT EXISTS items (id uuid, name text, PRIMARY KEY (id))',
        ]);
    });

    it('executes DDL with prepare: false and no bind parameters', async () => {
        await ds.synchronize([User]);

        for (const call of executeMock(ds).mock.calls) {
            expect(call[1]).toEqual([]);
            expect(call[2]).toMatchObject({ prepare: false });
        }
    });
});
