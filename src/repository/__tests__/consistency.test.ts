import { describe, it, expect, vi, beforeEach } from 'vitest';
import { types } from 'cassandra-driver';
import { DataSource } from '../../data-source/DataSource';
import { Repository } from '../Repository';
import { BaseModel } from '../../model/BaseModel';
import { Entity } from '../../decorators/Entity';
import { Column } from '../../decorators/Column';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';
import { InvalidQueryError } from '../../errors';
import { consistencies } from '../../index';

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
}

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('per-query consistency', () => {
    let repo: Repository<Account>;
    let execute: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        const ds = new DataSource({ contactPoints: ['x'], localDataCenter: 'dc1', logger: silent() });
        await ds.initialize();
        execute = (ds as any).client.execute;
        repo = ds.getRepository(Account);
    });

    function sentOptions(): Record<string, unknown> {
        return execute.mock.calls[0][2];
    }

    const consistency = consistencies.localQuorum;
    const entity = () => repo.create({ id: 'a', name: 'b' });

    it.each([
        ['find', () => repo.find({ consistency })],
        ['findPaged', () => repo.findPaged({ consistency })],
        ['stream', () => repo.stream({ consistency }).next()],
        ['save', () => repo.save(entity(), { consistency })],
        ['insertIfNotExists', () => repo.insertIfNotExists(entity(), { consistency })],
        ['update', () => repo.update({ id: 'a' }, { name: 'c' }, { consistency })],
        ['updateIfExists', () => repo.updateIfExists({ id: 'a' }, { name: 'c' }, { consistency })],
        ['delete', () => repo.delete({ id: 'a' }, { consistency })],
        ['deleteIfExists', () => repo.deleteIfExists({ id: 'a' }, { consistency })],
        ['runRawQuery', () => repo.runRawQuery('SELECT * FROM accounts', {}, { consistency })],
        ['runRawQueryPaged', () => repo.runRawQueryPaged('SELECT * FROM accounts', {}, { consistency })],
    ])('%s() passes consistency to the driver', async (_name, call) => {
        await call();

        expect(sentOptions()).toMatchObject({ prepare: true, consistency: types.consistencies.localQuorum });
    });

    it('find() still drops fetchSize and pageState, which only paged reads honor', async () => {
        await repo.find({ consistency, fetchSize: 10, pageState: 'abc' });

        expect(sentOptions()).toEqual({ prepare: true, consistency, pageState: undefined });
    });

    it('findPaged() carries consistency alongside the paging settings', async () => {
        await repo.findPaged({ consistency, fetchSize: 10 });

        expect(sentOptions()).toEqual({ prepare: true, consistency, fetchSize: 10 });
    });

    it('sends the same options as before when no consistency is given', async () => {
        await repo.save(entity());
        await repo.find();

        expect(execute.mock.calls[0][2]).toEqual({ prepare: true });
        expect(execute.mock.calls[1][2]).toEqual({ prepare: true, pageState: undefined });
    });

    it.each([99, -1, 'localQuorum', null])('rejects the unknown consistency level %j locally', async (bad) => {
        await expect(repo.find({ consistency: bad as any })).rejects.toThrow(InvalidQueryError);
        await expect(repo.save(entity(), { consistency: bad as any })).rejects.toThrow(/Invalid consistency level/);

        expect(execute).not.toHaveBeenCalled();
    });

    it('re-exports the driver consistency levels', () => {
        expect(consistencies).toBe(types.consistencies);
    });
});
/* eslint-enable @typescript-eslint/no-explicit-any */

function silent() {
    return { info: () => undefined, warn: () => undefined, error: () => undefined };
}
