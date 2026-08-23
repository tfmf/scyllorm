import { describe, it, expect } from 'vitest';
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
        batch = vi.fn().mockResolvedValue({ rows: [] });
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

    @Column('INT')
    age: number;
}

@Entity('page_views')
class PageView extends BaseModel {
    @PrimaryKeyColumn('TEXT')
    id: string;

    @Column('COUNTER')
    views: number;
}

function setup<T extends typeof BaseModel & (new () => InstanceType<T>)>(entityClass: T) {
    const ds = new DataSource({ contactPoints: ['x'], localDataCenter: 'dc1' } as never);
    const executed: Array<{ query: string; params: unknown[] }> = [];

    vi.spyOn(ds, 'executeQuery').mockImplementation(async (query: string, params: unknown[]) => {
        executed.push({ query, params });
        return [] as never;
    });

    const repo = ds.getRepository(entityClass) as Repository<InstanceType<T>>;

    return { repo, executed };
}

describe('Repository statement builders', () => {
    it('saveStatement() produces the identical CQL and params save() executes', async () => {
        const { repo, executed } = setup(Account);
        const entity = repo.create({ id: 'abc-123', name: 'Alice', age: 42 } as never);

        const statement = repo.saveStatement(entity);
        await repo.save(entity);

        expect(statement.query).toBe(executed[0].query);
        expect(statement.params).toEqual(executed[0].params);
        expect(statement.query).toBe('INSERT INTO accounts (id, name, age) VALUES (?, ?, ?)');
        expect(statement.params).toEqual(['abc-123', 'Alice', 42]);
    });

    it('updateStatement() produces the identical CQL and params update() executes', async () => {
        const { repo, executed } = setup(Account);

        const statement = repo.updateStatement({ id: 'abc-123' } as never, { name: 'Bob', age: 7 } as never);
        await repo.update({ id: 'abc-123' } as never, { name: 'Bob', age: 7 } as never);

        expect(statement.query).toBe(executed[0].query);
        expect(statement.params).toEqual(executed[0].params);
        expect(statement.query).toBe('UPDATE accounts SET name = ?, age = ? WHERE id = ?');
        expect(statement.params).toEqual(['Bob', 7, 'abc-123']);
    });

    it('deleteStatement() produces the identical CQL and params delete() executes', async () => {
        const { repo, executed } = setup(Account);

        const statement = repo.deleteStatement({ id: 'abc-123', name: 'Alice' } as never);
        await repo.delete({ id: 'abc-123', name: 'Alice' } as never);

        expect(statement.query).toBe(executed[0].query);
        expect(statement.params).toEqual(executed[0].params);
        expect(statement.query).toBe('DELETE FROM accounts WHERE id = ? AND name = ?');
        expect(statement.params).toEqual(['abc-123', 'Alice']);
    });

    it('statement builders never call executeQuery', () => {
        const { repo, executed } = setup(Account);

        repo.saveStatement(repo.create({ id: 'a' } as never));
        repo.updateStatement({ id: 'a' } as never, { name: 'b' } as never);
        repo.deleteStatement({ id: 'a' } as never);

        expect(executed).toHaveLength(0);
    });

    it('updateStatement() rejects empty values', () => {
        const { repo } = setup(Account);

        expect(() => repo.updateStatement({ id: 'a' } as never, {} as never)).toThrow(InvalidQueryError);
    });

    it('updateStatement() rejects a primary key assignment', () => {
        const { repo } = setup(Account);

        expect(() => repo.updateStatement({ id: 'a' } as never, { id: 'b' } as never)).toThrow(InvalidQueryError);
    });

    it('updateStatement() rejects a counter assignment', () => {
        const { repo } = setup(PageView);

        expect(() => repo.updateStatement({ id: 'a' } as never, { views: 5 } as never)).toThrow(InvalidQueryError);
    });

    it('updateStatement() rejects an undefined value', () => {
        const { repo } = setup(Account);

        expect(() => repo.updateStatement({ id: 'a' } as never, { name: undefined } as never)).toThrow(
            InvalidQueryError
        );
    });

    it('updateStatement() rejects an unknown column', () => {
        const { repo } = setup(Account);

        expect(() => repo.updateStatement({ id: 'a' } as never, { nope: 1 } as never)).toThrow(UnknownColumnError);
    });

    it('deleteStatement() rejects empty conditions', () => {
        const { repo } = setup(Account);

        expect(() => repo.deleteStatement({} as never)).toThrow(InvalidQueryError);
    });

    it('deleteStatement() rejects an unknown column', () => {
        const { repo } = setup(Account);

        expect(() => repo.deleteStatement({ nope: 'x' } as never)).toThrow(UnknownColumnError);
    });

    it('deleteStatement() rejects a null condition', () => {
        const { repo } = setup(Account);

        expect(() => repo.deleteStatement({ id: null } as never)).toThrow(InvalidQueryError);
    });
});
