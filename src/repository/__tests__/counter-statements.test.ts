import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataSource } from '../../data-source/DataSource';
import { Repository } from '../Repository';
import { BaseModel } from '../../model/BaseModel';
import { Entity } from '../../decorators/Entity';
import { Column } from '../../decorators/Column';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';
import { InvalidQueryError, UnknownColumnError } from '../../errors';

vi.mock('cassandra-driver', async (importOriginal) => {
    class MockClient {
        connect = vi.fn().mockResolvedValue(undefined);
        shutdown = vi.fn().mockResolvedValue(undefined);
        execute = vi.fn().mockResolvedValue({ rows: [] });
        batch = vi.fn().mockResolvedValue({ rows: [] });
    }
    return {
        ...(await importOriginal<typeof import('cassandra-driver')>()),
        Client: MockClient,
        errors: {
            NoHostAvailableError: class extends Error {},
            DriverInternalError: class extends Error {},
        },
    };
});

@Entity('stmt_views')
class StmtView extends BaseModel {
    @PrimaryKeyColumn('TEXT')
    id: string;

    @Column('COUNTER')
    views: number;

    @Column('TEXT')
    name: string;
}

describe('incrementStatement() / decrementStatement()', () => {
    let ds: DataSource;
    let repo: Repository<StmtView>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let client: any;

    beforeEach(() => {
        vi.clearAllMocks();
        for (const m of ['warn', 'error', 'info', 'log'] as const) {
            vi.spyOn(console, m).mockImplementation(() => undefined);
        }
        ds = new DataSource({ contactPoints: ['x'], localDataCenter: 'dc1' } as never);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client = (ds as any).client;
        repo = ds.getRepository(StmtView);
    });

    it('builds exact CQL for increment with default by=1', () => {
        expect(repo.incrementStatement({ id: 'a' }, 'views')).toEqual({
            query: 'UPDATE stmt_views SET views = views + ? WHERE id = ?',
            params: [1, 'a'],
            counter: true,
        });
    });

    it('builds exact CQL for decrement with explicit by', () => {
        expect(repo.decrementStatement({ id: 'a' }, 'views', 5)).toEqual({
            query: 'UPDATE stmt_views SET views = views - ? WHERE id = ?',
            params: [5, 'a'],
            counter: true,
        });
    });

    it('executes nothing', () => {
        repo.incrementStatement({ id: 'a' }, 'views');
        repo.decrementStatement({ id: 'a' }, 'views');

        expect(client.execute).not.toHaveBeenCalled();
        expect(client.batch).not.toHaveBeenCalled();
    });

    it.each([
        ['increment', (r: Repository<StmtView>) => r.incrementStatement({ id: 'a' }, 'name' as never)],
        ['decrement', (r: Repository<StmtView>) => r.decrementStatement({ id: 'a' }, 'name' as never)],
    ])('%s throws for a non-counter column', (_n, call) => {
        expect(() => call(repo)).toThrow(InvalidQueryError);
    });

    it('throws UnknownColumnError for an undeclared column', () => {
        expect(() => repo.incrementStatement({ id: 'a' }, 'bogus' as never)).toThrow(UnknownColumnError);
        expect(() => repo.decrementStatement({ id: 'a' }, 'bogus' as never)).toThrow(UnknownColumnError);
    });

    it.each([1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('throws for an invalid by (%s)', (by) => {
        expect(() => repo.incrementStatement({ id: 'a' }, 'views', by)).toThrow(InvalidQueryError);
        expect(() => repo.decrementStatement({ id: 'a' }, 'views', by)).toThrow(InvalidQueryError);
    });

    it('throws for empty conditions', () => {
        expect(() => repo.incrementStatement({}, 'views')).toThrow(InvalidQueryError);
        expect(() => repo.decrementStatement({}, 'views')).toThrow(InvalidQueryError);
    });

    it('produces the same query and params as increment()/decrement()', async () => {
        await ds.initialize();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client = (ds as any).client;
        const stmt = repo.incrementStatement({ id: 'a' }, 'views', 3);
        const dec = repo.decrementStatement({ id: 'a' }, 'views', 3);

        await repo.increment({ id: 'a' }, 'views', 3);
        await repo.decrement({ id: 'a' }, 'views', 3);

        expect(client.execute).toHaveBeenNthCalledWith(1, stmt.query, stmt.params, expect.anything());
        expect(client.execute).toHaveBeenNthCalledWith(2, dec.query, dec.params, expect.anything());
    });

    it('sends a batch of counter statements as a counter batch end to end', async () => {
        await ds.initialize();

        await ds.executeBatch([
            repo.incrementStatement({ id: 'a' }, 'views', 2),
            repo.decrementStatement({ id: 'b' }, 'views'),
        ]);

        expect(client.batch).toHaveBeenCalledTimes(1);
        const [queries, options] = client.batch.mock.calls[0];
        expect(queries).toEqual([
            { query: 'UPDATE stmt_views SET views = views + ? WHERE id = ?', params: [2, 'a'] },
            { query: 'UPDATE stmt_views SET views = views - ? WHERE id = ?', params: [1, 'b'] },
        ]);
        expect(options).toMatchObject({ prepare: true, counter: true, isIdempotent: false });
    });
});
