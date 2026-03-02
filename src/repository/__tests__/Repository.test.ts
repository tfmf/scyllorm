import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataSource } from '../../data-source/DataSource';
import { Repository } from '../Repository';
import { BaseModel } from '../../model/BaseModel';
import { Entity } from '../../decorators/Entity';
import { Column } from '../../decorators/Column';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';

// Mock cassandra-driver
vi.mock('cassandra-driver', () => {
    class MockClient {
        connect = vi.fn().mockResolvedValue(undefined);
        shutdown = vi.fn().mockResolvedValue(undefined);
        execute = vi.fn().mockResolvedValue({ rows: [] });
    }
    return {
        Client: MockClient,
        errors: {
            NoHostAvailableError: class extends Error {},
            DriverInternalError: class extends Error {},
        },
    };
});

@Entity('items')
class Item extends BaseModel {
    @PrimaryKeyColumn('UUID')
    id: string;

    @Column('TEXT')
    name: string;

    @Column('INT')
    quantity: number;
}

describe('Repository', () => {
    let ds: DataSource;
    let repo: Repository<Item>;
    let executeSpy: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        vi.clearAllMocks();
        ds = new DataSource({
            contactPoints: ['localhost'],
            localDataCenter: 'datacenter1',
            keyspace: 'test',
        });
        await ds.initialize();
        repo = ds.getRepository<Item>(Item);
        executeSpy = vi.fn().mockResolvedValue([]);
        (ds as any).executeQuery = executeSpy;
    });

    describe('save()', () => {
        it('should execute only 1 query (INSERT, no SELECT)', async () => {
            const item = new Item();
            item.id = 'abc-123';
            item.name = 'Widget';
            item.quantity = 5;

            executeSpy.mockResolvedValue([]);

            await repo.save(item);

            // Should have been called exactly once (the INSERT)
            expect(executeSpy).toHaveBeenCalledTimes(1);
            const query = executeSpy.mock.calls[0][0] as string;
            expect(query).toMatch(/^INSERT INTO items/);
        });

        it('should return the entity directly', async () => {
            const item = new Item();
            item.id = 'abc-123';
            item.name = 'Widget';
            item.quantity = 5;

            const result = await repo.save(item);

            expect(result).toBe(item);
            expect(result.name).toBe('Widget');
        });
    });

    describe('delete()', () => {
        it('should execute only 1 query (DELETE, no SELECT)', async () => {
            await repo.delete({ id: 'abc-123' } as Partial<Item>);

            expect(executeSpy).toHaveBeenCalledTimes(1);
            const query = executeSpy.mock.calls[0][0] as string;
            expect(query).toMatch(/^DELETE FROM items WHERE id = \?$/);
        });

        it('should return void (no boolean)', async () => {
            const result = await repo.delete({ id: 'abc-123' } as Partial<Item>);
            expect(result).toBeUndefined();
        });
    });

    describe('find() with limit', () => {
        it('should add LIMIT clause when limit option is provided', async () => {
            await repo.find({ limit: 10 });

            expect(executeSpy).toHaveBeenCalledTimes(1);
            const query = executeSpy.mock.calls[0][0] as string;
            expect(query).toBe('SELECT * FROM items LIMIT 10');
        });

        it('should place LIMIT after ORDER BY', async () => {
            await repo.find({
                where: { name: 'Widget' },
                orderBy: { name: 'ASC' },
                limit: 5,
            });

            expect(executeSpy).toHaveBeenCalledTimes(1);
            const query = executeSpy.mock.calls[0][0] as string;
            expect(query).toBe('SELECT * FROM items WHERE name = ? ORDER BY name ASC LIMIT 5');
        });

        it('should place LIMIT before ALLOW FILTERING', async () => {
            await repo.find({ limit: 20 }, true);

            expect(executeSpy).toHaveBeenCalledTimes(1);
            const query = executeSpy.mock.calls[0][0] as string;
            expect(query).toBe('SELECT * FROM items LIMIT 20 ALLOW FILTERING');
        });

        it('should work without where clause (just limit)', async () => {
            await repo.find({ limit: 3 });

            expect(executeSpy).toHaveBeenCalledTimes(1);
            const query = executeSpy.mock.calls[0][0] as string;
            expect(query).toBe('SELECT * FROM items LIMIT 3');
        });

        it('should work without limit (backward compatible)', async () => {
            await repo.find();

            expect(executeSpy).toHaveBeenCalledTimes(1);
            const query = executeSpy.mock.calls[0][0] as string;
            expect(query).toBe('SELECT * FROM items');
        });
    });
});
