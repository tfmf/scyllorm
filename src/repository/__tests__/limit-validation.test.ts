import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataSource } from '../../data-source/DataSource';
import { Repository } from '../Repository';
import { BaseModel } from '../../model/BaseModel';
import { Entity } from '../../decorators/Entity';
import { Column } from '../../decorators/Column';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';
import { ScyllormError, InvalidQueryError } from '../../errors';

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

describe('limit validation', () => {
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

    describe('accepted limits', () => {
        it.each([
            ['an integer', 10, 10],
            ['a numeric string', '10', 10],
            ['scientific notation', 1e6, 1000000],
            ['the minimum positive integer', 1, 1],
            ['the largest value a CQL int can carry', 2147483647, 2147483647],
            ['a numeric string in scientific notation', '1e3', 1000],
        ])('should accept %s and bind it as ?', async (_label, limit, bound) => {
            await repo.find({ limit: limit as unknown as number });

            expect(executeSpy).toHaveBeenCalledTimes(1);
            expect(executeSpy.mock.calls[0][0]).toBe('SELECT * FROM items LIMIT ?');
            expect(executeSpy.mock.calls[0][1]).toEqual([bound]);
        });

        it('should emit no LIMIT clause when limit is undefined, unchanged from before', async () => {
            await repo.find({ limit: undefined });

            expect(executeSpy.mock.calls[0][0]).toBe('SELECT * FROM items');
            expect(executeSpy.mock.calls[0][1]).toEqual([]);
        });
    });

    describe('rejected limits', () => {
        it.each([
            ['a fractional number', 10.5],
            ['zero', 0],
            ['a negative number', -5],
            ['an array', []],
            ['null', null],
            ['NaN', NaN],
            ['an injection payload string', '1; DROP TABLE x'],
            ['a value too large for a CQL integer literal', 1e21],
            ['one past the largest value a CQL int can carry', 2147483648],
            ['MAX_SAFE_INTEGER, which the driver would reject as an int', Number.MAX_SAFE_INTEGER],
            ['a value beyond MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER + 2],
            ['true', true],
            ['an object with a coercing valueOf', { valueOf: () => 7 }],
            ['the numeric string zero', '0'],
            ['the numeric string negative one', '-1'],
            ['an empty string', ''],
            ['a non-numeric string', 'abc'],
            ['Infinity', Infinity],
            ['-Infinity', -Infinity],
            ['an empty object', {}],
            ['false', false],
            ['a BigInt', BigInt(10)],
        ])('should reject %s', async (_label, limit) => {
            await expect(repo.find({ limit: limit as unknown as number })).rejects.toThrow(InvalidQueryError);

            expect(executeSpy).not.toHaveBeenCalled();
        });
    });

    describe('error shape', () => {
        it('should be an InvalidQueryError, a ScyllormError, carrying the stable code', async () => {
            const error = await repo.find({ limit: 0 }).catch((caught) => caught);

            expect(error).toBeInstanceOf(InvalidQueryError);
            expect(error).toBeInstanceOf(ScyllormError);
            expect(error.code).toBe('SCYLLORM_INVALID_QUERY');
        });

        it('should name the entity and echo the offending value in the message', async () => {
            const error = await repo.find({ limit: -5 }).catch((caught) => caught);

            expect(error).toBeInstanceOf(InvalidQueryError);
            expect(error.message).toContain('Item');
            expect(error.message).toContain('-5');
        });

        it('should echo the original limit, not a coerced one, for a rejected numeric string', async () => {
            const error = await repo.find({ limit: 'abc' as unknown as number }).catch((caught) => caught);

            expect(error).toBeInstanceOf(InvalidQueryError);
            expect(error.message).toContain('"abc"');
        });
    });

    describe('binding order', () => {
        it('should bind LIMIT after the WHERE params', async () => {
            await repo.find({ where: { name: 'Widget' }, limit: 10 });

            expect(executeSpy.mock.calls[0][0]).toBe('SELECT * FROM items WHERE name = ? LIMIT ?');
            expect(executeSpy.mock.calls[0][1]).toEqual(['Widget', 10]);
        });

        it('should bind LIMIT after WHERE and ORDER BY', async () => {
            await repo.find({ where: { name: 'Widget' }, orderBy: { name: 'ASC' }, limit: 10 });

            expect(executeSpy.mock.calls[0][0]).toBe('SELECT * FROM items WHERE name = ? ORDER BY name ASC LIMIT ?');
            expect(executeSpy.mock.calls[0][1]).toEqual(['Widget', 10]);
        });

        it('should bind LIMIT the same way in stream()', async () => {
            await repo.stream({ where: { name: 'Widget' }, limit: 10 }).next();

            expect(streamSpy.mock.calls[0][0]).toBe('SELECT * FROM items WHERE name = ? LIMIT ?');
            expect(streamSpy.mock.calls[0][1]).toEqual(['Widget', 10]);
        });
    });

    describe('every entry point rejects an invalid limit', () => {
        it('should reject in find()', async () => {
            await expect(repo.find({ limit: 0 })).rejects.toThrow(InvalidQueryError);

            expect(executeSpy).not.toHaveBeenCalled();
        });

        it('should reject in findPaged()', async () => {
            await expect(repo.findPaged({ limit: 0 })).rejects.toThrow(InvalidQueryError);

            expect(pageSpy).not.toHaveBeenCalled();
        });

        it('should reject in stream(), driving the generator since the body does not run until next()', async () => {
            // Asserting on the call alone would pass against any implementation:
            // an async generator runs nothing until the iterator is advanced
            await expect(repo.stream({ limit: 0 }).next()).rejects.toThrow(InvalidQueryError);

            expect(streamSpy).not.toHaveBeenCalled();
        });
    });
});
