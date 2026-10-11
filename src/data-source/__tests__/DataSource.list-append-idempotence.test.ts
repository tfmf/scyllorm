import { describe, it, expect, vi, beforeEach } from 'vitest';
import { errors } from 'cassandra-driver';
import { DataSource } from '../DataSource';
import { Repository } from '../../repository/Repository';
import { BaseModel } from '../../model/BaseModel';
import { Entity } from '../../decorators/Entity';
import { Column } from '../../decorators/Column';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';
import { Append, Prepend, Remove, PutKeys, BatchStatement } from '../../repository/query-utils';

vi.mock('cassandra-driver', async (importOriginal) => {
    class MockClient {
        connect = vi.fn().mockResolvedValue(undefined);
        shutdown = vi.fn().mockResolvedValue(undefined);
        execute = vi.fn().mockResolvedValue({ rows: [] });
        batch = vi.fn().mockResolvedValue({ rows: [] });
    }
    // Partial mock: the real value types (`types.Long`, `types.Uuid`, ...) stay available
    return {
        ...(await importOriginal<typeof import('cassandra-driver')>()),
        Client: MockClient,
        errors: {
            NoHostAvailableError: class NoHostAvailableError extends Error {},
            DriverInternalError: class DriverInternalError extends Error {},
        },
    };
});

@Entity('list_append_items')
class ListAppendItem extends BaseModel {
    @PrimaryKeyColumn('TEXT')
    id: string;

    @Column('LIST', { of: 'TEXT' })
    tags: string[];

    @Column('SET', { of: 'TEXT' })
    labels: Set<string>;

    @Column('MAP', { of: ['TEXT', 'INT'] })
    attrs: Record<string, number>;

    @Column('TEXT')
    name: string;
}

interface MockClient {
    execute: ReturnType<typeof vi.fn>;
    batch: ReturnType<typeof vi.fn>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const clientOf = (ds: DataSource): MockClient => (ds as any).client;
/* eslint-enable @typescript-eslint/no-explicit-any */

async function connect(clientQueryOptions?: { isIdempotent: boolean }) {
    const ds = new DataSource({
        contactPoints: ['x'],
        localDataCenter: 'dc1',
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        ...(clientQueryOptions && { queryOptions: clientQueryOptions }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ds as any).RETRY_BASE_DELAY_MS = 0;
    await ds.initialize();

    return { ds, client: clientOf(ds), repo: ds.getRepository(ListAppendItem) as Repository<ListAppendItem> };
}

const where = { id: 'k' };
const listAppendSql = 'UPDATE list_append_items SET tags = tags + ? WHERE id = ?';
const setAppendSql = 'UPDATE list_append_items SET labels = labels + ? WHERE id = ?';

describe('list append idempotence: executeBatch()', () => {
    let ds: DataSource;
    let client: MockClient;
    let repo: Repository<ListAppendItem>;

    beforeEach(async () => {
        vi.clearAllMocks();
        ({ ds, client, repo } = await connect());
    });

    const listAppend = (): BatchStatement => repo.updateStatement(where, { tags: Append(['a']) });
    const listPrepend = (): BatchStatement => repo.updateStatement(where, { tags: Prepend(['a']) });
    const setAppend = (): BatchStatement => repo.updateStatement(where, { labels: Append(new Set(['a'])) });
    const plain = (): BatchStatement => repo.updateStatement(where, { name: 'x' });

    it('marks the statements it is given (precondition for the cases below)', () => {
        expect(listAppend().isIdempotent).toBe(false);
        expect(listPrepend().isIdempotent).toBe(false);
        expect('isIdempotent' in setAppend()).toBe(false);
        expect('isIdempotent' in plain()).toBe(false);
    });

    it('defaults to isIdempotent: false for a batch holding a LIST append', async () => {
        await ds.executeBatch([listAppend()]);

        expect(client.batch.mock.calls[0][1]).toMatchObject({ isIdempotent: false, counter: false, prepare: true });
    });

    it('defaults to isIdempotent: false when one statement among many is a LIST prepend', async () => {
        await ds.executeBatch([plain(), setAppend(), listPrepend()]);

        expect(client.batch.mock.calls[0][1].isIdempotent).toBe(false);
    });

    it('keeps the default isIdempotent: true for batches without such a statement', async () => {
        await ds.executeBatch([plain(), setAppend(), repo.updateStatement(where, { tags: Remove(['a']) })]);
        await ds.executeBatch([repo.updateStatement(where, { attrs: PutKeys({ a: 1 }) })]);

        expect(client.batch.mock.calls[0][1].isIdempotent).toBe(true);
        expect(client.batch.mock.calls[1][1].isIdempotent).toBe(true);
    });

    it('strips the marker: the driver gets exactly { query, params } per statement', async () => {
        await ds.executeBatch([listAppend(), plain()]);

        expect(client.batch.mock.calls[0][0]).toStrictEqual([
            { query: listAppendSql, params: [['a'], 'k'] },
            { query: 'UPDATE list_append_items SET name = ? WHERE id = ?', params: ['x', 'k'] },
        ]);
        for (const query of client.batch.mock.calls[0][0]) {
            expect('isIdempotent' in query).toBe(false);
            expect('counter' in query).toBe(false);
        }
    });

    it('does not mutate the caller statements while stripping', async () => {
        const statement = listAppend();
        await ds.executeBatch([statement]);

        expect(statement.isIdempotent).toBe(false);
    });

    it('lets options.isIdempotent: true win over the marker', async () => {
        await ds.executeBatch([listAppend()], { isIdempotent: true });

        expect(client.batch.mock.calls[0][1].isIdempotent).toBe(true);
    });

    it('ignores a hand-built statement marked isIdempotent: true, and strips it', async () => {
        await ds.executeBatch([{ ...plain(), isIdempotent: true }]);

        expect(client.batch.mock.calls[0][1].isIdempotent).toBe(true);
        expect(client.batch.mock.calls[0][0][0]).not.toHaveProperty('isIdempotent');
    });

    it('lets options.isIdempotent: false win over an unmarked batch', async () => {
        await ds.executeBatch([plain()], { isIdempotent: false });

        expect(client.batch.mock.calls[0][1].isIdempotent).toBe(false);
    });

    it('does not retry a LIST-append batch on NoHostAvailableError by default', async () => {
        client.batch.mockRejectedValue(new errors.NoHostAvailableError({}));

        await expect(ds.executeBatch([listAppend()])).rejects.toBeInstanceOf(errors.NoHostAvailableError);

        expect(client.batch).toHaveBeenCalledTimes(1);
    });

    it('does not retry such a batch even when the client default says isIdempotent: true', async () => {
        const eager = await connect({ isIdempotent: true });
        eager.client.batch.mockRejectedValue(new errors.NoHostAvailableError({}));

        await expect(eager.ds.executeBatch([listAppend()])).rejects.toBeInstanceOf(errors.NoHostAvailableError);

        expect(eager.client.batch).toHaveBeenCalledTimes(1);
    });

    it('retries a SET-append batch (1 attempt + 3 retries)', async () => {
        client.batch.mockRejectedValue(new errors.NoHostAvailableError({}));

        await expect(ds.executeBatch([setAppend()])).rejects.toBeInstanceOf(errors.NoHostAvailableError);

        expect(client.batch).toHaveBeenCalledTimes(4);
    });

    it('retries the LIST-append batch once options.isIdempotent: true opts in', async () => {
        client.batch.mockRejectedValue(new errors.NoHostAvailableError({}));

        await expect(ds.executeBatch([listAppend()], { isIdempotent: true })).rejects.toBeInstanceOf(
            errors.NoHostAvailableError
        );

        expect(client.batch).toHaveBeenCalledTimes(4);
    });
});

describe('list append idempotence: executeConcurrent()', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('forces isIdempotent: false for a marked statement and leaves the others alone', async () => {
        const { ds, client, repo } = await connect();
        const marked = repo.updateStatement(where, { tags: Append(['a']) });
        const unmarked = repo.updateStatement(where, { labels: Append(new Set(['a'])) });

        await ds.executeConcurrent([marked, unmarked], { isIdempotent: true });

        const byQuery = new Map(client.execute.mock.calls.map(([query, , options]) => [query, options]));
        expect(byQuery.get(listAppendSql)).toMatchObject({ isIdempotent: false, prepare: true });
        expect(byQuery.get(setAppendSql)).toMatchObject({ isIdempotent: true, prepare: true });
    });

    it('forces false even when the client default and the call options both say true', async () => {
        const eager = await connect({ isIdempotent: true });
        eager.client.execute.mockRejectedValue(new errors.NoHostAvailableError({}));
        const marked = eager.repo.updateStatement(where, { tags: Prepend(['a']) });

        await expect(eager.ds.executeConcurrent([marked], { isIdempotent: true })).rejects.toBeInstanceOf(
            errors.NoHostAvailableError
        );

        expect(eager.client.execute).toHaveBeenCalledTimes(1);
        expect(eager.client.execute.mock.calls[0][2]).toMatchObject({ isIdempotent: false });
    });

    it('retries an unmarked write when the caller opts in, but never the marked one next to it', async () => {
        const { ds, client, repo } = await connect();
        client.execute.mockRejectedValue(new errors.NoHostAvailableError({}));

        await expect(
            ds.executeConcurrent([repo.updateStatement(where, { labels: Append(new Set(['a'])) })], {
                isIdempotent: true,
            })
        ).rejects.toBeInstanceOf(errors.NoHostAvailableError);
        expect(client.execute).toHaveBeenCalledTimes(4);

        client.execute.mockClear();
        await expect(
            ds.executeConcurrent([repo.updateStatement(where, { tags: Append(['a']) })], { isIdempotent: true })
        ).rejects.toBeInstanceOf(errors.NoHostAvailableError);
        expect(client.execute).toHaveBeenCalledTimes(1);
    });

    it('leaves an unmarked statement to the usual resolution (options, then client default, then SELECT)', async () => {
        const plainCase = await connect();
        const unmarked = plainCase.repo.updateStatement(where, { name: 'x' });

        await plainCase.ds.executeConcurrent([unmarked]);
        await plainCase.ds.executeConcurrent([unmarked], { isIdempotent: true });
        await plainCase.ds.executeConcurrent([{ query: 'SELECT 1', params: [] }]);

        expect(plainCase.client.execute.mock.calls.map(([, , o]) => o.isIdempotent)).toEqual([false, true, true]);

        const eager = await connect({ isIdempotent: true });
        await eager.ds.executeConcurrent([eager.repo.updateStatement(where, { name: 'x' })]);
        expect(eager.client.execute.mock.calls[0][2].isIdempotent).toBe(true);
    });

    it('passes query and params to the driver as built', async () => {
        const { ds, client, repo } = await connect();
        await ds.executeConcurrent([repo.updateStatement(where, { tags: Append(['a']) }, { ttl: 5 })]);

        expect(client.execute.mock.calls[0][0]).toBe(
            'UPDATE list_append_items USING TTL ? SET tags = tags + ? WHERE id = ?'
        );
        expect(client.execute.mock.calls[0][1]).toEqual([5, ['a'], 'k']);
    });
});

describe('list append idempotence: Repository.update() through the real DataSource', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it.each([
        ['LIST Append', { tags: Append(['a']) }, 1],
        ['LIST Prepend', { tags: Prepend(['a']) }, 1],
        ['LIST Remove', { tags: Remove(['a']) }, 4],
        ['SET Append', { labels: Append(new Set(['a'])) }, 4],
        ['SET Remove', { labels: Remove(['a']) }, 4],
        ['MAP PutKeys', { attrs: PutKeys({ a: 1 }) }, 4],
        ['a plain assignment', { name: 'x' }, 4],
    ])('on NoHostAvailableError, %s is attempted %i time(s)', async (_name, values, attempts) => {
        const { client, repo } = await connect();
        client.execute.mockRejectedValue(new errors.NoHostAvailableError({}));

        await expect(repo.update(where, values as never)).rejects.toBeInstanceOf(errors.NoHostAvailableError);

        expect(client.execute).toHaveBeenCalledTimes(attempts);
    });

    it('sends isIdempotent to the driver per operation', async () => {
        const { client, repo } = await connect();

        await repo.update(where, { tags: Append(['a']) });
        await repo.update(where, { labels: Append(new Set(['a'])) });

        expect(client.execute.mock.calls[0][0]).toBe(listAppendSql);
        expect(client.execute.mock.calls[0][2].isIdempotent).toBe(false);
        expect(client.execute.mock.calls[1][0]).toBe(setAppendSql);
        expect(client.execute.mock.calls[1][2].isIdempotent).toBe(true);
    });

    it('does not retry a LIST append even when the client default is isIdempotent: true', async () => {
        const eager = await connect({ isIdempotent: true });
        eager.client.execute.mockRejectedValue(new errors.NoHostAvailableError({}));

        await expect(eager.repo.update(where, { tags: Append(['a']) })).rejects.toBeInstanceOf(
            errors.NoHostAvailableError
        );

        expect(eager.client.execute).toHaveBeenCalledTimes(1);
    });

    it('retries a LIST append that succeeds on the first attempt exactly once (no double send)', async () => {
        const { client, repo } = await connect();
        await repo.update(where, { tags: Append(['a']) });

        expect(client.execute).toHaveBeenCalledTimes(1);
    });

    it('does not retry updateIfExists, list or set', async () => {
        const { client, repo } = await connect();
        client.execute.mockRejectedValue(new errors.NoHostAvailableError({}));

        await expect(repo.updateIfExists(where, { tags: Append(['a']) })).rejects.toBeInstanceOf(
            errors.NoHostAvailableError
        );
        await expect(repo.updateIfExists(where, { labels: Append(new Set(['a'])) })).rejects.toBeInstanceOf(
            errors.NoHostAvailableError
        );

        expect(client.execute).toHaveBeenCalledTimes(2);
        expect(client.execute.mock.calls.map(([, , o]) => o.isIdempotent)).toEqual([false, false]);
    });
});
