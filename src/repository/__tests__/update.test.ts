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
    @PrimaryKeyColumn('UUID')
    id: string;

    @Column('TEXT')
    name: string;

    @Column('INT')
    age: number;

    @Column('TEXT')
    bio: string;
}

@Entity('page_views')
class PageView extends BaseModel {
    @PrimaryKeyColumn('TEXT')
    id: string;

    @Column('COUNTER')
    views: number;

    @Column('TEXT')
    name: string;
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

describe('Repository.update()', () => {
    it('produces byte-exact CQL and param order for a multi-column SET and multi-column WHERE', async () => {
        const { repo, executed } = setup(Account);
        await repo.update(
            { id: 'abc-123', name: 'Alice' } as never,
            { name: 'Bob', age: 42 } as never
        );

        expect(executed[0].query).toBe('UPDATE accounts SET name = ?, age = ? WHERE id = ? AND name = ?');
        expect(executed[0].params).toEqual(['Bob', 42, 'abc-123', 'Alice']);
    });

    it('binds a null value as a tombstone rather than throwing', async () => {
        const { repo, executed } = setup(Account);
        await repo.update({ id: 'abc-123' } as never, { bio: null } as never);

        expect(executed[0].query).toBe('UPDATE accounts SET bio = ? WHERE id = ?');
        expect(executed[0].params).toEqual([null, 'abc-123']);
    });

    it('throws InvalidQueryError when a value is undefined, and never calls executeQuery', async () => {
        const { repo, executed } = setup(Account);

        await expect(repo.update({ id: 'abc-123' } as never, { name: undefined } as never)).rejects.toThrow(
            InvalidQueryError
        );
        expect(executed.length).toBe(0);
    });

    it('throws InvalidQueryError on an empty values object, and never calls executeQuery', async () => {
        const { repo, executed } = setup(Account);

        await expect(repo.update({ id: 'abc-123' } as never, {} as never)).rejects.toThrow(InvalidQueryError);
        expect(executed.length).toBe(0);
    });

    it('throws InvalidQueryError on empty conditions, naming update() conditions', async () => {
        const { repo, executed } = setup(Account);

        try {
            await repo.update({} as never, { name: 'Bob' } as never);
            expect.unreachable('expected update() to throw');
        } catch (error) {
            expect(error).toBeInstanceOf(InvalidQueryError);
            expect((error as InvalidQueryError).message).toContain('update() conditions');
        }
        expect(executed.length).toBe(0);
    });

    it('throws InvalidQueryError when assigning a primary key column, and never calls executeQuery', async () => {
        const { repo, executed } = setup(Account);

        await expect(
            repo.update({ id: 'abc-123' } as never, { id: 'new-id', name: 'Bob' } as never)
        ).rejects.toThrow(InvalidQueryError);
        expect(executed.length).toBe(0);
    });

    it('throws InvalidQueryError when assigning a COUNTER column, and never calls executeQuery', async () => {
        const { repo, executed } = setup(PageView);

        await expect(repo.update({ id: 'page-1' } as never, { views: 10 } as never)).rejects.toThrow(
            InvalidQueryError
        );
        expect(executed.length).toBe(0);
    });

    it('throws UnknownColumnError for an undeclared column in values, and never calls executeQuery', async () => {
        const { repo, executed } = setup(Account);

        await expect(
            repo.update({ id: 'abc-123' } as never, { nonexistent: 'x' } as never)
        ).rejects.toThrow(UnknownColumnError);
        expect(executed.length).toBe(0);
    });

    it('throws UnknownColumnError for an undeclared column in conditions, and never calls executeQuery', async () => {
        const { repo, executed } = setup(Account);

        await expect(
            repo.update({ nonexistent: 'x' } as never, { name: 'Bob' } as never)
        ).rejects.toThrow(UnknownColumnError);
        expect(executed.length).toBe(0);
    });

    it('rejects a values key shaped as an injection attempt, and never calls executeQuery', async () => {
        const { repo, executed } = setup(Account);

        await expect(
            repo.update({ id: 'abc-123' } as never, { "name = 'x' WHERE 1=1 --": 'v' } as never)
        ).rejects.toThrow(InvalidQueryError);
        expect(executed.length).toBe(0);
    });

    it('rejects a conditions key shaped as an injection attempt, and never calls executeQuery', async () => {
        const { repo, executed } = setup(Account);

        await expect(
            repo.update({ "id = 'x' OR '1'='1'": 'v' } as never, { name: 'Bob' } as never)
        ).rejects.toThrow(InvalidQueryError);
        expect(executed.length).toBe(0);
    });

    it('single-passes over values so a getter cannot desync placeholders from params', async () => {
        const { repo, executed } = setup(Account);
        const trap = { name: 'x', age: 1 };
        let mutated = false;

        const values: Record<string, unknown> = {
            get name() {
                if (!mutated) {
                    mutated = true;
                    delete (trap as Record<string, unknown>).age;
                    trap.name = 'mutated';
                }
                return 'Alice';
            },
            age: 2,
        };

        await repo.update({ id: 'abc-123' } as never, values as never);

        // One placeholder per entry read, and one param per placeholder, in the same order —
        // no matter what the getter mutated on some unrelated object mid-iteration.
        const placeholderCount = (executed[0].query.match(/\?/g) ?? []).length;
        expect(placeholderCount).toBe(executed[0].params.length);
        expect(executed[0].query).toBe('UPDATE accounts SET name = ?, age = ? WHERE id = ?');
        expect(executed[0].params).toEqual(['Alice', 2, 'abc-123']);
    });

    it('regression: a valid single-column update produces byte-identical CQL', async () => {
        const { repo, executed } = setup(Account);
        await repo.update({ id: 'abc-123' } as never, { name: 'Carol' } as never);

        expect(executed[0].query).toBe('UPDATE accounts SET name = ? WHERE id = ?');
        expect(executed[0].params).toEqual(['Carol', 'abc-123']);
    });

    it('allows a delta value of 0 on a non-counter numeric column (regression: 0 is not undefined)', async () => {
        const { repo, executed } = setup(Account);
        await repo.update({ id: 'abc-123' } as never, { age: 0 } as never);

        expect(executed[0].query).toBe('UPDATE accounts SET age = ? WHERE id = ?');
        expect(executed[0].params).toEqual([0, 'abc-123']);
    });

    it('throws InvalidQueryError for a value that is null on a condition (WHERE cannot bind null)', async () => {
        const { repo, executed } = setup(Account);

        await expect(repo.update({ id: null } as never, { name: 'Bob' } as never)).rejects.toThrow(
            InvalidQueryError
        );
        expect(executed.length).toBe(0);
    });

    it('does not throw for assigning a primary key on a different entity that does not declare it', async () => {
        const { repo, executed } = setup(PageView);
        await repo.update({ id: 'page-1' } as never, { name: 'Home' } as never);

        expect(executed[0].query).toBe('UPDATE page_views SET name = ? WHERE id = ?');
        expect(executed[0].params).toEqual(['Home', 'page-1']);
    });
});
