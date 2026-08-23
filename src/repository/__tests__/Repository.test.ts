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
    @PrimaryKeyColumn('TEXT')
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
            expect(query).toBe('SELECT * FROM items LIMIT ?');
            expect(executeSpy.mock.calls[0][1]).toEqual([10]);
        });

        it('should place LIMIT after ORDER BY', async () => {
            await repo.find({
                where: { name: 'Widget' },
                orderBy: { name: 'ASC' },
                limit: 5,
            });

            expect(executeSpy).toHaveBeenCalledTimes(1);
            const query = executeSpy.mock.calls[0][0] as string;
            expect(query).toBe('SELECT * FROM items WHERE name = ? ORDER BY name ASC LIMIT ?');
            expect(executeSpy.mock.calls[0][1]).toEqual(['Widget', 5]);
        });

        it('should place LIMIT before ALLOW FILTERING', async () => {
            await repo.find({ limit: 20 }, true);

            expect(executeSpy).toHaveBeenCalledTimes(1);
            const query = executeSpy.mock.calls[0][0] as string;
            expect(query).toBe('SELECT * FROM items LIMIT ? ALLOW FILTERING');
            expect(executeSpy.mock.calls[0][1]).toEqual([20]);
        });

        it('should work without where clause (just limit)', async () => {
            await repo.find({ limit: 3 });

            expect(executeSpy).toHaveBeenCalledTimes(1);
            const query = executeSpy.mock.calls[0][0] as string;
            expect(query).toBe('SELECT * FROM items LIMIT ?');
            expect(executeSpy.mock.calls[0][1]).toEqual([3]);
        });

        it('should work without limit (backward compatible)', async () => {
            await repo.find();

            expect(executeSpy).toHaveBeenCalledTimes(1);
            const query = executeSpy.mock.calls[0][0] as string;
            expect(query).toBe('SELECT * FROM items');
        });
    });

    describe('find() across pages', () => {
        it('should return rows from every page, not just the first', async () => {
            // Exercise the real executeQuery path by scripting the driver client
            const paged = new DataSource({ contactPoints: ['localhost'], localDataCenter: 'dc1', keyspace: 'test' });
            await paged.initialize();
            const execute = (paged as any).client.execute as ReturnType<typeof vi.fn>;
            execute
                .mockResolvedValueOnce({ rows: [{ id: 'a', name: 'Widget', quantity: 1 }], pageState: 'page-2' })
                .mockResolvedValueOnce({ rows: [{ id: 'b', name: 'Gadget', quantity: 2 }], pageState: undefined });

            const items = await paged.getRepository<Item>(Item).find();

            expect(execute).toHaveBeenCalledTimes(2);
            expect(items.map((i) => i.name)).toEqual(['Widget', 'Gadget']);
        });
    });

    describe('findPaged()', () => {
        let pageSpy: ReturnType<typeof vi.fn>;

        beforeEach(() => {
            pageSpy = vi.fn().mockResolvedValue({ rows: [], pageState: undefined });
            (ds as any).executeQueryPage = pageSpy;
        });

        it('should build the same query as find()', async () => {
            await repo.findPaged({ where: { name: 'Widget' }, orderBy: { name: 'ASC' }, limit: 5 });

            expect(pageSpy.mock.calls[0][0]).toBe('SELECT * FROM items WHERE name = ? ORDER BY name ASC LIMIT ?');
            expect(pageSpy.mock.calls[0][1]).toEqual(['Widget', 5]);
        });

        it('should pass fetchSize and pageState through to the driver options', async () => {
            await repo.findPaged({ fetchSize: 100, pageState: 'cursor-1' });

            expect(pageSpy.mock.calls[0][2]).toEqual({ prepare: true, fetchSize: 100, pageState: 'cursor-1' });
        });

        it('should not send paging options that were not provided', async () => {
            await repo.findPaged();

            expect(pageSpy.mock.calls[0][2]).toEqual({ prepare: true });
        });

        it('should report hasMore when a cursor is returned', async () => {
            pageSpy.mockResolvedValue({ rows: [{ id: 'a', name: 'Widget', quantity: 1 }], pageState: 'cursor-2' });

            const page = await repo.findPaged();

            expect(page.hasMore).toBe(true);
            expect(page.pageState).toBe('cursor-2');
            expect(page.rows).toHaveLength(1);
            expect(page.rows[0]).toBeInstanceOf(Item);
        });

        it('should report hasMore false on the last page', async () => {
            pageSpy.mockResolvedValue({ rows: [], pageState: undefined });

            const page = await repo.findPaged();

            expect(page.hasMore).toBe(false);
            expect(page.pageState).toBeUndefined();
        });
    });

    describe('stream()', () => {
        it('should yield mapped entities', async () => {
            (ds as any).streamQuery = async function* () {
                yield { id: 'a', name: 'Widget', quantity: 1 };
                yield { id: 'b', name: 'Gadget', quantity: 2 };
            };

            const names: string[] = [];
            for await (const item of repo.stream()) {
                expect(item).toBeInstanceOf(Item);
                names.push(item.name);
            }

            expect(names).toEqual(['Widget', 'Gadget']);
        });

        it('should build the same query as find()', async () => {
            const streamSpy = vi.fn(async function* () {});
            (ds as any).streamQuery = streamSpy;

            const drained: Item[] = [];
            for await (const item of repo.stream({ where: { name: 'Widget' }, fetchSize: 50 }, true)) {
                drained.push(item);
            }

            expect(streamSpy.mock.calls[0][0]).toBe('SELECT * FROM items WHERE name = ? ALLOW FILTERING');
            expect(streamSpy.mock.calls[0][1]).toEqual(['Widget']);
            expect(streamSpy.mock.calls[0][2]).toEqual({ prepare: true, fetchSize: 50 });
        });
    });
});
