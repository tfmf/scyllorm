import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';
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

@Entity('page_views')
class PageView extends BaseModel {
    @PrimaryKeyColumn('TEXT')
    id: string;

    @Column('COUNTER')
    views: number;

    @Column('TEXT')
    name: string;
}

describe('increment() / decrement()', () => {
    let ds: DataSource;
    let repo: Repository<PageView>;
    let executed: Array<{ query: string; params: unknown[] }>;

    beforeEach(() => {
        ds = new DataSource({ contactPoints: ['x'], localDataCenter: 'dc1' } as never);
        executed = [];
        vi.spyOn(ds, 'executeQuery').mockImplementation(async (query: string, params: unknown[]) => {
            executed.push({ query, params });
            return [] as never;
        });
        repo = ds.getRepository(PageView);
    });

    it('increment() defaults by to 1 and produces byte-exact CQL', async () => {
        await repo.increment({ id: 'a' }, 'views');

        expect(executed[0].query).toBe('UPDATE page_views SET views = views + ? WHERE id = ?');
        expect(executed[0].params).toEqual([1, 'a']);
    });

    it('decrement() defaults by to 1 and produces byte-exact CQL', async () => {
        await repo.decrement({ id: 'a' }, 'views');

        expect(executed[0].query).toBe('UPDATE page_views SET views = views - ? WHERE id = ?');
        expect(executed[0].params).toEqual([1, 'a']);
    });

    it('increment() accepts an explicit positive by', async () => {
        await repo.increment({ id: 'a' }, 'views', 5);

        expect(executed[0].query).toBe('UPDATE page_views SET views = views + ? WHERE id = ?');
        expect(executed[0].params).toEqual([5, 'a']);
    });

    it('decrement() accepts an explicit positive by', async () => {
        await repo.decrement({ id: 'a' }, 'views', 5);

        expect(executed[0].query).toBe('UPDATE page_views SET views = views - ? WHERE id = ?');
        expect(executed[0].params).toEqual([5, 'a']);
    });

    it('increment() accepts a negative by (equivalent to moving the other way)', async () => {
        await repo.increment({ id: 'a' }, 'views', -3);

        expect(executed[0].query).toBe('UPDATE page_views SET views = views + ? WHERE id = ?');
        expect(executed[0].params).toEqual([-3, 'a']);
    });

    it('decrement() accepts a negative by', async () => {
        await repo.decrement({ id: 'a' }, 'views', -3);

        expect(executed[0].query).toBe('UPDATE page_views SET views = views - ? WHERE id = ?');
        expect(executed[0].params).toEqual([-3, 'a']);
    });

    it('increment() accepts by = 0', async () => {
        await repo.increment({ id: 'a' }, 'views', 0);

        expect(executed[0].query).toBe('UPDATE page_views SET views = views + ? WHERE id = ?');
        expect(executed[0].params).toEqual([0, 'a']);
    });

    it('params are ordered [by, ...conditionValues] with multiple conditions', async () => {
        await repo.increment({ id: 'a', name: 'home' }, 'views', 2);

        expect(executed[0].query).toBe('UPDATE page_views SET views = views + ? WHERE id = ? AND name = ?');
        expect(executed[0].params).toEqual([2, 'a', 'home']);
    });

    it('throws InvalidQueryError when the column is not a COUNTER', async () => {
        await expect(repo.increment({ id: 'a' }, 'name' as never)).rejects.toThrow(InvalidQueryError);

        try {
            await repo.increment({ id: 'a' }, 'name' as never);
            expect.unreachable();
        } catch (err) {
            expect((err as InvalidQueryError).code).toBe('SCYLLORM_INVALID_QUERY');
        }

        expect(executed.length).toBe(0);
    });

    it('throws UnknownColumnError for an undeclared column', async () => {
        await expect(repo.increment({ id: 'a' }, 'bogus' as never)).rejects.toThrow(UnknownColumnError);

        try {
            await repo.decrement({ id: 'a' }, 'bogus' as never);
            expect.unreachable();
        } catch (err) {
            expect((err as UnknownColumnError).code).toBe('SCYLLORM_UNKNOWN_COLUMN');
        }

        expect(executed.length).toBe(0);
    });

    it.each([1.5, NaN, Infinity, -Infinity, 2 ** 53])(
        'rejects a non-safe-integer delta: %s',
        async (by) => {
            await expect(repo.increment({ id: 'a' }, 'views', by)).rejects.toThrow(InvalidQueryError);
            await expect(repo.decrement({ id: 'a' }, 'views', by)).rejects.toThrow(InvalidQueryError);

            expect(executed.length).toBe(0);
        }
    );

    it('rejects a string delta', async () => {
        await expect(repo.increment({ id: 'a' }, 'views', '5' as never)).rejects.toThrow(InvalidQueryError);

        expect(executed.length).toBe(0);
    });

    it('rejects a null delta', async () => {
        await expect(repo.increment({ id: 'a' }, 'views', null as never)).rejects.toThrow(InvalidQueryError);

        expect(executed.length).toBe(0);
    });

    it('throws InvalidQueryError with code SCYLLORM_INVALID_QUERY for a bad delta', async () => {
        try {
            await repo.increment({ id: 'a' }, 'views', NaN);
            expect.unreachable();
        } catch (err) {
            expect((err as InvalidQueryError).code).toBe('SCYLLORM_INVALID_QUERY');
        }

        expect(executed.length).toBe(0);
    });

    it('increment() with empty conditions throws InvalidQueryError naming increment() conditions', async () => {
        await expect(repo.increment({}, 'views', 1)).rejects.toMatchObject({
            code: 'SCYLLORM_INVALID_QUERY',
            message: expect.stringContaining('increment() conditions'),
        });

        expect(executed.length).toBe(0);
    });

    it('decrement() with empty conditions throws InvalidQueryError naming decrement() conditions', async () => {
        await expect(repo.decrement({}, 'views', 1)).rejects.toMatchObject({
            code: 'SCYLLORM_INVALID_QUERY',
            message: expect.stringContaining('decrement() conditions'),
        });

        expect(executed.length).toBe(0);
    });

    it('rejects an injection attempt disguised as a column name', async () => {
        await expect(
            repo.increment({ id: 'a' }, 'views = views + 1; DROP TABLE x' as never)
        ).rejects.toMatchObject({
            code: 'SCYLLORM_INVALID_QUERY',
        });

        expect(executed.length).toBe(0);
    });
});
