import { describe, it, expect, vi, beforeEach } from 'vitest';
import { errors } from 'cassandra-driver';
import { DataSource } from '../../data-source/DataSource';
import { Repository } from '../Repository';
import { BaseModel } from '../../model/BaseModel';
import { Entity } from '../../decorators/Entity';
import { Column } from '../../decorators/Column';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';

// Partial mock: only the client is replaced, so options reach `execute` exactly as the driver would see them
vi.mock('cassandra-driver', async (importOriginal) => {
    class MockClient {
        connect = vi.fn().mockResolvedValue(undefined);
        shutdown = vi.fn().mockResolvedValue(undefined);
        execute = vi.fn().mockResolvedValue({ rows: [{ '[applied]': true }] });
    }
    return {
        ...(await importOriginal<typeof import('cassandra-driver')>()),
        Client: MockClient,
    };
});

@Entity('accounts')
class Account extends BaseModel {
    @PrimaryKeyColumn('TEXT')
    id: string;

    @Column('TEXT')
    name: string;

    @Column('COUNTER')
    hits: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('isIdempotent sent to the driver', () => {
    let ds: DataSource;
    let repo: Repository<Account>;
    let execute: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        ds = new DataSource({ contactPoints: ['x'], localDataCenter: 'dc1', logger: silent() });
        await ds.initialize();
        (ds as any).RETRY_BASE_DELAY_MS = 0;
        execute = (ds as any).client.execute;
        repo = ds.getRepository(Account);
    });

    const sent = (): unknown => execute.mock.calls[0][2].isIdempotent;
    const entity = () => repo.create({ id: 'a', name: 'b' });

    it.each([
        ['save', true, () => repo.save(entity())],
        ['update', true, () => repo.update({ id: 'a' }, { name: 'c' })],
        ['delete', true, () => repo.delete({ id: 'a' })],
        ['clear', true, () => repo.clear()],
        ['insertIfNotExists', false, () => repo.insertIfNotExists(entity())],
        ['updateIfExists', false, () => repo.updateIfExists({ id: 'a' }, { name: 'c' })],
        ['deleteIfExists', false, () => repo.deleteIfExists({ id: 'a' })],
        ['increment', false, () => repo.increment({ id: 'a' }, 'hits')],
        ['decrement', false, () => repo.decrement({ id: 'a' }, 'hits')],
        ['find', true, () => repo.find()],
        ['findBy', true, () => repo.findBy({ id: 'a' })],
        ['findOneBy', true, () => repo.findOneBy({ id: 'a' })],
        ['findOne', true, () => repo.findOne()],
        ['count', true, () => repo.count()],
        ['exists', true, () => repo.exists()],
        ['runRawQuery SELECT', true, () => repo.runRawQuery('SELECT * FROM accounts', {})],
        ['runRawQuery INSERT', false, () => repo.runRawQuery("INSERT INTO accounts (id) VALUES ('a')", {})],
        [
            'runRawQuery INSERT with isIdempotent',
            true,
            () => repo.runRawQuery("INSERT INTO accounts (id) VALUES ('a')", {}, { isIdempotent: true }),
        ],
        [
            'runRawQuery SELECT with isIdempotent false',
            false,
            () => repo.runRawQuery('SELECT * FROM accounts', {}, { isIdempotent: false }),
        ],
        [
            'runRawQueryPaged INSERT with isIdempotent',
            true,
            () => repo.runRawQueryPaged("INSERT INTO accounts (id) VALUES ('a')", {}, { isIdempotent: true }),
        ],
        ['runRawQueryPaged SELECT', true, () => repo.runRawQueryPaged('SELECT * FROM accounts', {})],
    ])('%s() sends isIdempotent=%s', async (_name, expected, call) => {
        await call();

        expect(sent()).toBe(expected);
    });

    it('streamRawQuery() passes isIdempotent through to the driver', async () => {
        const rows = repo.streamRawQuery('DELETE FROM accounts WHERE id = :id', { id: 'a' }, { isIdempotent: true });
        await rows.next();

        expect(sent()).toBe(true);
    });

    it('streamRawQuery() infers false for a non-SELECT without the option', async () => {
        await repo.streamRawQuery('DELETE FROM accounts WHERE id = :id', { id: 'a' }).next();

        expect(sent()).toBe(false);
    });

    describe('retries', () => {
        const noHost = () => new errors.NoHostAvailableError({});

        it('does not retry increment() on NoHostAvailableError', async () => {
            execute.mockRejectedValue(noHost());

            await expect(repo.increment({ id: 'a' }, 'hits')).rejects.toBeDefined();

            expect(execute).toHaveBeenCalledTimes(1);
        });

        it('does not retry insertIfNotExists() on NoHostAvailableError', async () => {
            execute.mockRejectedValue(noHost());

            await expect(repo.insertIfNotExists(entity())).rejects.toBeDefined();

            expect(execute).toHaveBeenCalledTimes(1);
        });

        it('retries save() on NoHostAvailableError and succeeds', async () => {
            execute.mockRejectedValueOnce(noHost()).mockResolvedValue({ rows: [] });

            await repo.save(entity());

            expect(execute.mock.calls.length).toBeGreaterThan(1);
        });

        it('gives up on save() after 3 retries', async () => {
            execute.mockRejectedValue(noHost());

            await expect(repo.save(entity())).rejects.toBeDefined();

            expect(execute).toHaveBeenCalledTimes(4);
        });

        // Reads defer to the client default: an explicit client-wide false is honored
        it.each([
            ['find', () => repo.find()],
            ['findOneBy', () => repo.findOneBy({ id: 'a' })],
            ['count', () => repo.count()],
            ['findPaged', () => repo.findPaged()],
        ])('does not retry %s with queryOptions.isIdempotent: false', async (_name, run) => {
            ds = new DataSource({
                contactPoints: ['x'],
                localDataCenter: 'dc1',
                logger: silent(),
                queryOptions: { isIdempotent: false },
            });
            await ds.initialize();
            (ds as any).RETRY_BASE_DELAY_MS = 0;
            execute = (ds as any).client.execute;
            repo = ds.getRepository(Account);
            execute.mockRejectedValue(noHost());

            await expect(run()).rejects.toBeInstanceOf(errors.NoHostAvailableError);

            expect(execute).toHaveBeenCalledTimes(1);
            expect(sent()).toBe(false);
        });

        // Counters and LWT say false for themselves, so a client-wide true cannot make them double-apply
        it.each([
            ['increment', () => repo.increment({ id: 'a' }, 'hits')],
            ['decrement', () => repo.decrement({ id: 'a' }, 'hits')],
            ['insertIfNotExists', () => repo.insertIfNotExists(entity())],
            ['updateIfExists', () => repo.updateIfExists({ id: 'a' }, { name: 'c' })],
            ['deleteIfExists', () => repo.deleteIfExists({ id: 'a' })],
        ])('never retries %s, even with queryOptions.isIdempotent: true', async (_name, run) => {
            ds = new DataSource({
                contactPoints: ['x'],
                localDataCenter: 'dc1',
                logger: silent(),
                queryOptions: { isIdempotent: true },
            });
            await ds.initialize();
            (ds as any).RETRY_BASE_DELAY_MS = 0;
            execute = (ds as any).client.execute;
            repo = ds.getRepository(Account);
            execute.mockRejectedValue(noHost());

            await expect(run()).rejects.toBeInstanceOf(errors.NoHostAvailableError);

            expect(execute).toHaveBeenCalledTimes(1);
            expect(sent()).toBe(false);
        });
    });
});

function silent() {
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}
