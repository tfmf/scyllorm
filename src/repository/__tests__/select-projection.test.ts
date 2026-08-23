import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataSource } from '../../data-source/DataSource';
import { Repository } from '../Repository';
import { BaseModel } from '../../model/BaseModel';
import { Entity } from '../../decorators/Entity';
import { Column } from '../../decorators/Column';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';
import { InvalidQueryError, UnknownColumnError } from '../../errors';

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

    @Column('INT', { default: 0 })
    quantity: number;
}

describe('select projection', () => {
    let ds: DataSource;
    let repo: Repository<Item>;
    let executeSpy: ReturnType<typeof vi.fn>;
    let pageSpy: ReturnType<typeof vi.fn>;
    let streamSpy: ReturnType<typeof vi.fn>;

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
        pageSpy = vi.fn().mockResolvedValue({ rows: [], pageState: undefined });
        streamSpy = vi.fn(async function* () {});
        (ds as any).executeQuery = executeSpy;
        (ds as any).executeQueryPage = pageSpy;
        (ds as any).streamQuery = streamSpy;
    });

    describe('query string', () => {
        it('should emit the selected columns instead of *', async () => {
            await repo.find({ select: ['id', 'name'] });

            expect(executeSpy.mock.calls[0][0]).toBe('SELECT id, name FROM items');
            expect(executeSpy.mock.calls[0][1]).toEqual([]);
        });

        it('should still emit * when select is undefined', async () => {
            await repo.find();

            expect(executeSpy.mock.calls[0][0]).toBe('SELECT * FROM items');
        });

        it('should compose with WHERE, ORDER BY and LIMIT', async () => {
            await repo.find({ select: ['name'], where: { id: 'abc' }, orderBy: { name: 'ASC' }, limit: 5 });

            expect(executeSpy.mock.calls[0][0]).toBe('SELECT name FROM items WHERE id = ? ORDER BY name ASC LIMIT ?');
            expect(executeSpy.mock.calls[0][1]).toEqual(['abc', 5]);
        });
    });

    describe('validation', () => {
        it('should reject an unknown column with UnknownColumnError and a suggestion', async () => {
            const error = await repo.find({ select: ['Name'] }).catch((caught) => caught);

            expect(error).toBeInstanceOf(UnknownColumnError);
            expect(error.code).toBe('SCYLLORM_UNKNOWN_COLUMN');
            expect(error.column).toBe('Name');
            expect(error.message).toContain('Did you mean "name"?');
            expect(executeSpy).not.toHaveBeenCalled();
        });

        it('should reject a name that is not a legal identifier', async () => {
            await expect(repo.find({ select: ['name; DROP TABLE items'] })).rejects.toThrow(InvalidQueryError);

            expect(executeSpy).not.toHaveBeenCalled();
        });

        it('should reject an empty select array', async () => {
            const error = await repo.find({ select: [] }).catch((caught) => caught);

            expect(error).toBeInstanceOf(InvalidQueryError);
            expect(error.code).toBe('SCYLLORM_INVALID_QUERY');
            expect(error.message).toContain('select clause');
            expect(executeSpy).not.toHaveBeenCalled();
        });
    });

    describe('every read entry point honors select', () => {
        it('should project in findPaged()', async () => {
            await repo.findPaged({ select: ['id'] });

            expect(pageSpy.mock.calls[0][0]).toBe('SELECT id FROM items');
        });

        it('should project in stream(), driving the generator since the body does not run until next()', async () => {
            await repo.stream({ select: ['id'] }).next();

            expect(streamSpy.mock.calls[0][0]).toBe('SELECT id FROM items');
        });

        it('should reject an empty select in findPaged() and stream()', async () => {
            await expect(repo.findPaged({ select: [] })).rejects.toThrow(InvalidQueryError);
            await expect(repo.stream({ select: [] }).next()).rejects.toThrow(InvalidQueryError);

            expect(pageSpy).not.toHaveBeenCalled();
            expect(streamSpy).not.toHaveBeenCalled();
        });
    });

    describe('partial-row mapping', () => {
        it('should leave unselected properties at their constructor defaults', async () => {
            executeSpy.mockResolvedValue([{ id: 'abc', name: 'Widget' }]);

            const [item] = await repo.find({ select: ['id', 'name'] });

            expect(item.id).toBe('abc');
            expect(item.name).toBe('Widget');
            // quantity was not selected: the column default from the constructor survives
            expect(item.quantity).toBe(0);
        });

        it('should leave an unselected property without a default undefined', async () => {
            executeSpy.mockResolvedValue([{ id: 'abc' }]);

            const [item] = await repo.find({ select: ['id'] });

            expect(item.id).toBe('abc');
            expect(item.name).toBeUndefined();
        });

        it('should still map a selected column whose value is null', async () => {
            executeSpy.mockResolvedValue([{ id: 'abc', quantity: null }]);

            const [item] = await repo.find({ select: ['id', 'quantity'] });

            // null is present in the row, so it overrides the constructor default
            expect(item.quantity).toBeNull();
        });
    });
});
