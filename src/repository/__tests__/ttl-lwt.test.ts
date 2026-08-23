import { describe, it, expect, vi } from 'vitest';
import { DataSource } from '../../data-source/DataSource';
import { Repository } from '../Repository';
import { BaseModel } from '../../model/BaseModel';
import { Entity } from '../../decorators/Entity';
import { Column } from '../../decorators/Column';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';
import { InvalidQueryError } from '../../errors';

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

@Entity('accounts')
class Account extends BaseModel {
    @PrimaryKeyColumn('TEXT')
    id: string;

    @Column('TEXT')
    name: string;
}

function setup() {
    const ds = new DataSource({ contactPoints: ['x'], localDataCenter: 'dc1' } as never);
    const executed: Array<{ query: string; params: unknown[] }> = [];
    let rows: unknown[] = [];

    vi.spyOn(ds, 'executeQuery').mockImplementation(async (query: string, params: unknown[]) => {
        executed.push({ query, params });
        return rows as never;
    });

    const repo = ds.getRepository(Account) as Repository<Account>;

    return {
        repo,
        executed,
        setRows: (next: unknown[]) => {
            rows = next;
        },
    };
}

describe('TTL on writes', () => {
    it('save() appends USING TTL at the end of the INSERT and binds the ttl last', async () => {
        const { repo, executed } = setup();
        const entity = repo.create({ id: 'abc-123', name: 'Alice' });

        await repo.save(entity, { ttl: 60 });

        expect(executed[0].query).toBe('INSERT INTO accounts (id, name) VALUES (?, ?) USING TTL ?');
        expect(executed[0].params).toEqual(['abc-123', 'Alice', 60]);
    });

    it('save() without options emits the same INSERT as before', async () => {
        const { repo, executed } = setup();

        await repo.save(repo.create({ id: 'abc-123', name: 'Alice' }));

        expect(executed[0].query).toBe('INSERT INTO accounts (id, name) VALUES (?, ?)');
        expect(executed[0].params).toEqual(['abc-123', 'Alice']);
    });

    it('saveStatement() carries the same TTL clause and binding as save()', async () => {
        const { repo, executed } = setup();
        const entity = repo.create({ id: 'abc-123', name: 'Alice' });

        const statement = repo.saveStatement(entity, { ttl: 90 });
        await repo.save(entity, { ttl: 90 });

        expect(statement.query).toBe(executed[0].query);
        expect(statement.params).toEqual(executed[0].params);
    });

    it('update() puts USING TTL after the table name and binds the ttl first', async () => {
        const { repo, executed } = setup();

        await repo.update({ id: 'abc-123' }, { name: 'Bob' }, { ttl: 120 });

        expect(executed[0].query).toBe('UPDATE accounts USING TTL ? SET name = ? WHERE id = ?');
        expect(executed[0].params).toEqual([120, 'Bob', 'abc-123']);
    });

    it('update() without options emits the same UPDATE as before', async () => {
        const { repo, executed } = setup();

        await repo.update({ id: 'abc-123' }, { name: 'Bob' });

        expect(executed[0].query).toBe('UPDATE accounts SET name = ? WHERE id = ?');
        expect(executed[0].params).toEqual(['Bob', 'abc-123']);
    });

    it('updateStatement() carries the same TTL clause and binding as update()', async () => {
        const { repo, executed } = setup();

        const statement = repo.updateStatement({ id: 'abc-123' }, { name: 'Bob' }, { ttl: 30 });
        await repo.update({ id: 'abc-123' }, { name: 'Bob' }, { ttl: 30 });

        expect(statement.query).toBe(executed[0].query);
        expect(statement.params).toEqual(executed[0].params);
    });

    it.each([0, -1, 1.5, NaN, Infinity, 2147483648, '60' as never])(
        'rejects ttl %p on every write path without executing',
        async (ttl: number) => {
            const { repo, executed } = setup();
            const entity = repo.create({ id: 'a', name: 'b' });

            await expect(repo.save(entity, { ttl })).rejects.toThrow(InvalidQueryError);
            expect(() => repo.saveStatement(entity, { ttl })).toThrow(InvalidQueryError);
            await expect(repo.update({ id: 'a' }, { name: 'b' }, { ttl })).rejects.toThrow(InvalidQueryError);
            expect(() => repo.updateStatement({ id: 'a' }, { name: 'b' }, { ttl })).toThrow(InvalidQueryError);
            await expect(repo.insertIfNotExists(entity, { ttl })).rejects.toThrow(InvalidQueryError);
            await expect(repo.updateIfExists({ id: 'a' }, { name: 'b' }, { ttl })).rejects.toThrow(InvalidQueryError);
            expect(executed).toHaveLength(0);
        }
    );
});

describe('lightweight transactions', () => {
    it('insertIfNotExists() appends IF NOT EXISTS and maps [applied] true', async () => {
        const { repo, executed, setRows } = setup();
        setRows([{ '[applied]': true }]);

        const applied = await repo.insertIfNotExists(repo.create({ id: 'abc-123', name: 'Alice' }));

        expect(executed[0].query).toBe('INSERT INTO accounts (id, name) VALUES (?, ?) IF NOT EXISTS');
        expect(executed[0].params).toEqual(['abc-123', 'Alice']);
        expect(applied).toBe(true);
    });

    it('insertIfNotExists() maps [applied] false when the row already exists', async () => {
        const { repo, setRows } = setup();
        setRows([{ '[applied]': false, id: 'abc-123', name: 'Old' }]);

        await expect(repo.insertIfNotExists(repo.create({ id: 'abc-123', name: 'Alice' }))).resolves.toBe(false);
    });

    it('insertIfNotExists() puts USING TTL after IF NOT EXISTS and binds the ttl last', async () => {
        const { repo, executed, setRows } = setup();
        setRows([{ '[applied]': true }]);

        await repo.insertIfNotExists(repo.create({ id: 'abc-123', name: 'Alice' }), { ttl: 45 });

        expect(executed[0].query).toBe('INSERT INTO accounts (id, name) VALUES (?, ?) IF NOT EXISTS USING TTL ?');
        expect(executed[0].params).toEqual(['abc-123', 'Alice', 45]);
    });

    it('updateIfExists() appends IF EXISTS and maps [applied] true', async () => {
        const { repo, executed, setRows } = setup();
        setRows([{ '[applied]': true }]);

        const applied = await repo.updateIfExists({ id: 'abc-123' }, { name: 'Bob' });

        expect(executed[0].query).toBe('UPDATE accounts SET name = ? WHERE id = ? IF EXISTS');
        expect(executed[0].params).toEqual(['Bob', 'abc-123']);
        expect(applied).toBe(true);
    });

    it('updateIfExists() maps [applied] false when no row matched', async () => {
        const { repo, setRows } = setup();
        setRows([{ '[applied]': false }]);

        await expect(repo.updateIfExists({ id: 'abc-123' }, { name: 'Bob' })).resolves.toBe(false);
    });

    it('updateIfExists() combines USING TTL before SET with IF EXISTS at the end', async () => {
        const { repo, executed, setRows } = setup();
        setRows([{ '[applied]': true }]);

        await repo.updateIfExists({ id: 'abc-123' }, { name: 'Bob' }, { ttl: 15 });

        expect(executed[0].query).toBe('UPDATE accounts USING TTL ? SET name = ? WHERE id = ? IF EXISTS');
        expect(executed[0].params).toEqual([15, 'Bob', 'abc-123']);
    });

    it('deleteIfExists() appends IF EXISTS and maps [applied] true', async () => {
        const { repo, executed, setRows } = setup();
        setRows([{ '[applied]': true }]);

        const applied = await repo.deleteIfExists({ id: 'abc-123' });

        expect(executed[0].query).toBe('DELETE FROM accounts WHERE id = ? IF EXISTS');
        expect(executed[0].params).toEqual(['abc-123']);
        expect(applied).toBe(true);
    });

    it('deleteIfExists() maps [applied] false when no row matched', async () => {
        const { repo, setRows } = setup();
        setRows([{ '[applied]': false }]);

        await expect(repo.deleteIfExists({ id: 'abc-123' })).resolves.toBe(false);
    });

    it('an empty result set reads as not applied', async () => {
        const { repo, setRows } = setup();
        setRows([]);

        await expect(repo.deleteIfExists({ id: 'abc-123' })).resolves.toBe(false);
    });

    it('LWT methods run the same lifecycle hooks as their plain counterparts', async () => {
        const { repo, setRows } = setup();
        setRows([{ '[applied]': true }]);
        const calls: string[] = [];

        const entity = repo.create({ id: 'abc-123', name: 'Alice' });
        entity.beforeSave = () => {
            calls.push('beforeSave');
        };
        entity.afterSave = () => {
            calls.push('afterSave');
        };
        Account.beforeUpdate = () => {
            calls.push('beforeUpdate');
        };
        Account.afterUpdate = () => {
            calls.push('afterUpdate');
        };
        Account.beforeDelete = () => {
            calls.push('beforeDelete');
        };
        Account.afterDelete = () => {
            calls.push('afterDelete');
        };

        try {
            await repo.insertIfNotExists(entity);
            await repo.updateIfExists({ id: 'abc-123' }, { name: 'Bob' });
            await repo.deleteIfExists({ id: 'abc-123' });
        } finally {
            delete Account.beforeUpdate;
            delete Account.afterUpdate;
            delete Account.beforeDelete;
            delete Account.afterDelete;
        }

        expect(calls).toEqual([
            'beforeSave',
            'afterSave',
            'beforeUpdate',
            'afterUpdate',
            'beforeDelete',
            'afterDelete',
        ]);
    });
});
