import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DataSource } from '../../data-source/DataSource';
import { Repository } from '../Repository';
import { BaseModel } from '../../model/BaseModel';
import { Entity } from '../../decorators/Entity';
import { Column } from '../../decorators/Column';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';
import { In, GreaterThan, LessThanOrEqual, Between, Contains, ContainsKey } from '../query-utils';
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

@Entity('products')
class Product extends BaseModel {
    @PrimaryKeyColumn('UUID')
    id: string;

    @Column('TEXT')
    name: string;

    @Column('INT')
    age: number;

    @Column('SET<TEXT>')
    tags: string[];

    @Column('MAP<TEXT, TEXT>')
    attributes: Record<string, string>;
}

describe('new operators: Between, Contains, ContainsKey', () => {
    let ds: DataSource;
    let executed: Array<{ query: string; params: unknown[] }>;
    let repo: Repository<Product>;

    beforeEach(() => {
        ds = new DataSource({ contactPoints: ['x'], localDataCenter: 'dc1' } as never);
        executed = [];
        vi.spyOn(ds, 'executeQuery').mockImplementation(async (query: string, params: unknown[]) => {
            executed.push({ query, params });
            return [] as never;
        });
        repo = ds.getRepository(Product);
    });

    describe('operator factory shapes', () => {
        it('Between(from, to) builds a BETWEEN condition', () => {
            expect(Between(1, 9)).toEqual({ operator: 'BETWEEN', value: [1, 9] });
        });

        it('Contains(value) builds a CONTAINS condition', () => {
            expect(Contains('red')).toEqual({ operator: 'CONTAINS', value: 'red' });
        });

        it('ContainsKey(key) builds a CONTAINS KEY condition', () => {
            expect(ContainsKey('color')).toEqual({ operator: 'CONTAINS KEY', value: 'color' });
        });
    });

    describe('via find({ where })', () => {
        it('emits byte-exact CQL for Between', async () => {
            await repo.find({ where: { age: Between(1, 9) } });
            expect(executed[0].query).toBe('SELECT * FROM products WHERE age >= ? AND age <= ?');
            expect(executed[0].params).toEqual([1, 9]);
        });

        it('emits byte-exact CQL for Contains', async () => {
            await repo.find({ where: { tags: Contains('red') } });
            expect(executed[0].query).toBe('SELECT * FROM products WHERE tags CONTAINS ?');
            expect(executed[0].params).toEqual(['red']);
        });

        it('emits byte-exact CQL for ContainsKey', async () => {
            await repo.find({ where: { attributes: ContainsKey('color') } });
            expect(executed[0].query).toBe('SELECT * FROM products WHERE attributes CONTAINS KEY ?');
            expect(executed[0].params).toEqual(['color']);
        });

        it('combines Between/Contains with other operators, AND-joined, param order preserved', async () => {
            await repo.find({
                where: {
                    name: 'Widget',
                    age: Between(1, 9),
                    tags: Contains('red'),
                    id: In(['a', 'b']),
                },
            });
            expect(executed[0].query).toBe(
                'SELECT * FROM products WHERE name = ? AND age >= ? AND age <= ? AND tags CONTAINS ? AND id IN (?, ?)'
            );
            expect(executed[0].params).toEqual(['Widget', 1, 9, 'red', 'a', 'b']);
        });
    });

    describe('via findBy / countBy / existsBy', () => {
        it('findBy emits Between CQL', async () => {
            await repo.findBy({ age: Between(1, 9) });
            expect(executed[0].query).toBe('SELECT * FROM products WHERE age >= ? AND age <= ?');
            expect(executed[0].params).toEqual([1, 9]);
        });

        it('countBy emits Contains CQL', async () => {
            await repo.countBy({ tags: Contains('red') }, true);
            expect(executed[0].query).toBe('SELECT COUNT(*) FROM products WHERE tags CONTAINS ? ALLOW FILTERING');
            expect(executed[0].params).toEqual(['red']);
        });

        it('existsBy emits ContainsKey CQL', async () => {
            await repo.existsBy({ attributes: ContainsKey('color') });
            expect(executed[0].query).toBe('SELECT * FROM products WHERE attributes CONTAINS KEY ? LIMIT 1');
            expect(executed[0].params).toEqual(['color']);
        });
    });

    describe('malformed Between/Contains conditions throw', () => {
        it('Between with non-array value throws', async () => {
            await expect(
                repo.find({ where: { age: { operator: 'BETWEEN', value: 5 } as never } })
            ).rejects.toThrow(InvalidQueryError);
            expect(executed.length).toBe(0);
        });

        it('Between with single-element array throws', async () => {
            await expect(
                repo.find({ where: { age: { operator: 'BETWEEN', value: [1] } as never } })
            ).rejects.toThrow(InvalidQueryError);
            expect(executed.length).toBe(0);
        });

        it('Between with three-element array throws', async () => {
            await expect(
                repo.find({ where: { age: { operator: 'BETWEEN', value: [1, 2, 3] } as never } })
            ).rejects.toThrow(InvalidQueryError);
            expect(executed.length).toBe(0);
        });

        it('Between with a non-bindable start value throws', async () => {
            await expect(
                repo.find({ where: { age: { operator: 'BETWEEN', value: [{}, 2] } as never } })
            ).rejects.toThrow(InvalidQueryError);
            expect(executed.length).toBe(0);
        });

        it('Between with a non-bindable end value throws', async () => {
            await expect(
                repo.find({ where: { age: { operator: 'BETWEEN', value: [1, null] } as never } })
            ).rejects.toThrow(InvalidQueryError);
            expect(executed.length).toBe(0);
        });

        it('Contains with a non-bindable value throws', async () => {
            await expect(
                repo.find({ where: { tags: { operator: 'CONTAINS', value: {} } as never } })
            ).rejects.toThrow(InvalidQueryError);
            expect(executed.length).toBe(0);
        });

        it('an unsupported operator throws, listing BETWEEN/CONTAINS/CONTAINS KEY', async () => {
            let caught: unknown;
            try {
                await repo.find({ where: { name: { operator: 'LIKE', value: 'W%' } as never } });
            } catch (error) {
                caught = error;
            }
            expect(caught).toBeInstanceOf(InvalidQueryError);
            expect((caught as Error).message).toContain('BETWEEN');
            expect((caught as Error).message).toContain('CONTAINS');
            expect((caught as Error).message).toContain('CONTAINS KEY');
            expect(executed.length).toBe(0);
        });
    });

    describe('regression: existing operators still emit byte-identical CQL', () => {
        it('IN condition unchanged', async () => {
            await repo.find({ where: { name: In(['A', 'B', 'C']) } });
            expect(executed[0].query).toBe('SELECT * FROM products WHERE name IN (?, ?, ?)');
            expect(executed[0].params).toEqual(['A', 'B', 'C']);
        });

        it('GreaterThan condition unchanged', async () => {
            await repo.find({ where: { age: GreaterThan(50) } });
            expect(executed[0].query).toBe('SELECT * FROM products WHERE age > ?');
            expect(executed[0].params).toEqual([50]);
        });

        it('LessThanOrEqual condition unchanged', async () => {
            await repo.find({ where: { age: LessThanOrEqual(100) } });
            expect(executed[0].query).toBe('SELECT * FROM products WHERE age <= ?');
            expect(executed[0].params).toEqual([100]);
        });
    });
});
