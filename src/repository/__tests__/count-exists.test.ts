import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';
import { DataSource } from '../../data-source/DataSource';
import { Repository } from '../Repository';
import { BaseModel } from '../../model/BaseModel';
import { Entity } from '../../decorators/Entity';
import { Column } from '../../decorators/Column';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';
import { InvalidQueryError, UnknownColumnError } from '../../errors';
import { GreaterThan, In } from '../query-utils';

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

@Entity('customers')
class Customer extends BaseModel {
    @PrimaryKeyColumn('UUID')
    id: string;

    @Column('TEXT')
    name: string;

    @Column('INT')
    age: number;
}

function setup() {
    const ds = new DataSource({ contactPoints: ['x'], localDataCenter: 'dc1' } as never);
    const executed: Array<{ query: string; params: unknown[] }> = [];
    let response: unknown[] = [];

    vi.spyOn(ds, 'executeQuery').mockImplementation(async (query: string, params: unknown[]) => {
        executed.push({ query, params });
        return response as never;
    });

    const repo = ds.getRepository(Customer);

    return {
        repo,
        executed,
        setResponse: (rows: unknown[]) => {
            response = rows;
        },
    };
}

describe('Repository.count / countBy', () => {
    it('count() with no conditions produces byte-exact CQL', async () => {
        const { repo, executed } = setup();
        await repo.count();
        expect(executed[0].query).toBe('SELECT COUNT(*) FROM customers');
        expect(executed[0].params).toEqual([]);
    });

    it('countBy() produces byte-exact CQL with params', async () => {
        const { repo, executed } = setup();
        await repo.countBy({ name: 'Alice' });
        expect(executed[0].query).toBe('SELECT COUNT(*) FROM customers WHERE name = ?');
        expect(executed[0].params).toEqual(['Alice']);
    });

    it('countBy() appends ALLOW FILTERING when requested', async () => {
        const { repo, executed } = setup();
        await repo.countBy({ name: 'Alice' }, true);
        expect(executed[0].query).toBe('SELECT COUNT(*) FROM customers WHERE name = ? ALLOW FILTERING');
        expect(executed[0].params).toEqual(['Alice']);
    });

    it('count() with conditions delegates to countBy, producing identical CQL', async () => {
        const { repo, executed } = setup();
        await repo.count({ name: 'Alice' });
        expect(executed[0].query).toBe('SELECT COUNT(*) FROM customers WHERE name = ?');
        expect(executed[0].params).toEqual(['Alice']);
    });

    it('count() with conditions and allowFiltering forwards the flag to countBy', async () => {
        const { repo, executed } = setup();
        await repo.count({ name: 'Alice' }, true);
        expect(executed[0].query).toBe('SELECT COUNT(*) FROM customers WHERE name = ? ALLOW FILTERING');
    });

    it('countBy() with GreaterThan operator builds correct WHERE and params', async () => {
        const { repo, executed } = setup();
        await repo.countBy({ age: GreaterThan(21) });
        expect(executed[0].query).toBe('SELECT COUNT(*) FROM customers WHERE age > ?');
        expect(executed[0].params).toEqual([21]);
    });

    it('countBy() with In operator builds correct WHERE and params', async () => {
        const { repo, executed } = setup();
        await repo.countBy({ name: In(['Alice', 'Bob']) });
        expect(executed[0].query).toBe('SELECT COUNT(*) FROM customers WHERE name IN (?, ?)');
        expect(executed[0].params).toEqual(['Alice', 'Bob']);
    });

    it('count() extracts a plain number passthrough', async () => {
        const { repo, setResponse } = setup();
        setResponse([{ count: 7 }]);
        await expect(repo.count()).resolves.toBe(7);
    });

    it('count() converts a Long-like object via String()', async () => {
        const { repo, setResponse } = setup();
        setResponse([{ count: { toString: () => '42' } }]);
        await expect(repo.count()).resolves.toBe(42);
    });

    it('count() returns 0 when there are no rows', async () => {
        const { repo, setResponse } = setup();
        setResponse([]);
        await expect(repo.count()).resolves.toBe(0);
    });

    it('count() returns 0 when count is null', async () => {
        const { repo, setResponse } = setup();
        setResponse([{ count: null }]);
        await expect(repo.count()).resolves.toBe(0);
    });

    it('countBy() throws InvalidQueryError on empty conditions and never calls executeQuery', async () => {
        const { repo, executed } = setup();
        await expect(repo.countBy({})).rejects.toThrow(InvalidQueryError);
        expect(executed.length).toBe(0);
    });

    it('countBy() throws UnknownColumnError for an undeclared column', async () => {
        const { repo, executed } = setup();
        await expect(repo.countBy({ nonexistent: 'x' } as never)).rejects.toThrow(UnknownColumnError);
        expect(executed.length).toBe(0);
    });
});

describe('Repository.exists / existsBy', () => {
    it('exists() produces byte-exact CQL', async () => {
        const { repo, executed } = setup();
        await repo.exists();
        expect(executed[0].query).toBe('SELECT * FROM customers LIMIT 1');
        expect(executed[0].params).toEqual([]);
    });

    it('exists() resolves true when a row comes back', async () => {
        const { repo, setResponse } = setup();
        setResponse([{ id: '1' }]);
        await expect(repo.exists()).resolves.toBe(true);
    });

    it('exists() resolves false when no rows come back', async () => {
        const { repo, setResponse } = setup();
        setResponse([]);
        await expect(repo.exists()).resolves.toBe(false);
    });

    it('existsBy() produces byte-exact CQL with params', async () => {
        const { repo, executed } = setup();
        await repo.existsBy({ name: 'Alice' });
        expect(executed[0].query).toBe('SELECT * FROM customers WHERE name = ? LIMIT 1');
        expect(executed[0].params).toEqual(['Alice']);
    });

    it('existsBy() appends ALLOW FILTERING when requested', async () => {
        const { repo, executed } = setup();
        await repo.existsBy({ name: 'Alice' }, true);
        expect(executed[0].query).toBe('SELECT * FROM customers WHERE name = ? LIMIT 1 ALLOW FILTERING');
    });

    it('existsBy() resolves true when a row comes back', async () => {
        const { repo, setResponse } = setup();
        setResponse([{ id: '1' }]);
        await expect(repo.existsBy({ name: 'Alice' })).resolves.toBe(true);
    });

    it('existsBy() resolves false when no rows come back', async () => {
        const { repo, setResponse } = setup();
        setResponse([]);
        await expect(repo.existsBy({ name: 'Alice' })).resolves.toBe(false);
    });

    it('existsBy() throws InvalidQueryError on empty conditions and never calls executeQuery', async () => {
        const { repo, executed } = setup();
        await expect(repo.existsBy({})).rejects.toThrow(InvalidQueryError);
        expect(executed.length).toBe(0);
    });

    it('existsBy() throws UnknownColumnError for an undeclared column', async () => {
        const { repo, executed } = setup();
        await expect(repo.existsBy({ nonexistent: 'x' } as never)).rejects.toThrow(UnknownColumnError);
        expect(executed.length).toBe(0);
    });
});
