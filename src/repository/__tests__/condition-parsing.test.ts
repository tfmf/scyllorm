import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DataSource } from '../../data-source/DataSource';
import { Repository } from '../Repository';
import { BaseModel } from '../../model/BaseModel';
import { Entity } from '../../decorators/Entity';
import { Column } from '../../decorators/Column';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';
import { In, GreaterThan } from '../query-utils';
import { InvalidQueryError, ScyllormError } from '../../errors';

/* eslint-disable @typescript-eslint/no-explicit-any */

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

@Entity('items')
class Item extends BaseModel {
    @PrimaryKeyColumn('UUID')
    id: string;

    @Column('TEXT')
    name: string;

    @Column('INT')
    quantity: number;
}

describe('condition parsing', () => {
    let ds: DataSource;
    let repo: Repository<Item>;
    let executeSpy: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        vi.clearAllMocks();
        ds = new DataSource({
            contactPoints: ['localhost'],
            localDataCenter: 'datacenter1',
            keyspace: 'test',
        });
        await ds.initialize();
        repo = ds.getRepository<Item>(Item);
        executeSpy = vi.fn().mockResolvedValue([]);
        (ds as any).executeQuery = executeSpy;
    });

    describe('null and undefined values', () => {
        it('should reject null in findBy() rather than crashing on the operator check', async () => {
            await expect(repo.findBy({ name: null as any })).rejects.toThrow(InvalidQueryError);
        });

        it('should reject undefined in findBy()', async () => {
            await expect(repo.findBy({ name: undefined as any })).rejects.toThrow(InvalidQueryError);
        });

        it('should reject null in find({ where })', async () => {
            await expect(repo.find({ where: { quantity: null as any } })).rejects.toThrow(InvalidQueryError);
        });

        it('should reject null in findOneBy()', async () => {
            await expect(repo.findOneBy({ id: null as any })).rejects.toThrow(InvalidQueryError);
        });

        it('should reject null in delete()', async () => {
            await expect(repo.delete({ id: null as any })).rejects.toThrow(InvalidQueryError);
        });

        it('should name the column and explain that CQL has no null comparison', async () => {
            await expect(repo.findBy({ name: null as any })).rejects.toThrow(
                /Condition on column "name" of entity Item is null or undefined/
            );
        });

        it('should be catchable as a ScyllormError, not a TypeError', async () => {
            const error = await repo.findBy({ name: null as any }).catch((caught) => caught);

            expect(error).toBeInstanceOf(ScyllormError);
            expect(error).not.toBeInstanceOf(TypeError);
            expect(error.code).toBe('SCYLLORM_INVALID_QUERY');
        });

        it('should not execute a query', async () => {
            await expect(repo.findBy({ name: null as any })).rejects.toThrow();
            await expect(repo.delete({ id: undefined as any })).rejects.toThrow();

            expect(executeSpy).not.toHaveBeenCalled();
        });
    });

    describe('prototype pollution', () => {
        /**
         * Run one query with `Object.prototype` polluted, and settle it before
         * returning: `expect()` builds property descriptors, so it cannot itself
         * run while `Object.prototype.value` is set.
         */
        async function polluted<R>(
            properties: Record<string, unknown>,
            run: () => Promise<R>
        ): Promise<{ result?: R; error?: any }> {
            Object.assign(Object.prototype, properties);

            try {
                return { result: await run() };
            } catch (error) {
                return { error };
            } finally {
                for (const key of Object.keys(properties)) {
                    delete (Object.prototype as any)[key];
                }
            }
        }

        afterEach(() => {
            delete (Object.prototype as any).operator;
            delete (Object.prototype as any).value;
        });

        it('should not reroute an ordinary object value into the IN branch', async () => {
            const { error } = await polluted({ operator: 'IN', value: ['stolen', 'params'] }, () =>
                repo.findBy({ name: {} as any })
            );

            expect(error).toBeInstanceOf(InvalidQueryError);
            expect(executeSpy).not.toHaveBeenCalled();
        });

        it('should not let a polluted operator change how a plain value is emitted', async () => {
            const { error } = await polluted({ operator: 'IN', value: ['stolen'] }, () =>
                repo.findBy({ name: 'Widget' })
            );

            expect(error).toBeUndefined();
            expect(executeSpy.mock.calls[0][0]).toBe('SELECT * FROM items WHERE name = ?');
            expect(executeSpy.mock.calls[0][1]).toEqual(['Widget']);
        });

        it('should not let a polluted value supply the operand of a real condition', async () => {
            // An operator object of the caller's own making, but missing its operand
            const { error } = await polluted({ value: ['stolen'] }, () =>
                repo.findBy({ quantity: { operator: '>' } as any })
            );

            expect(error).toBeInstanceOf(InvalidQueryError);
            expect(executeSpy).not.toHaveBeenCalled();
        });

        it('should still accept a condition built by the query helpers', async () => {
            const { error } = await polluted({ operator: 'IN' }, () =>
                repo.find({ where: { quantity: GreaterThan(5) } })
            );

            expect(error).toBeUndefined();
            expect(executeSpy.mock.calls[0][0]).toBe('SELECT * FROM items WHERE quantity > ?');
            expect(executeSpy.mock.calls[0][1]).toEqual([5]);
        });
    });

    describe('IN conditions', () => {
        it('should reject an empty list', async () => {
            await expect(repo.find({ where: { name: In([]) } })).rejects.toThrow(InvalidQueryError);
            await expect(repo.find({ where: { name: In([]) } })).rejects.toThrow(/has no values/);
            expect(executeSpy).not.toHaveBeenCalled();
        });

        it('should reject a non-array operand', async () => {
            await expect(repo.findBy({ name: { operator: 'IN', value: 'Widget' } as any })).rejects.toThrow(
                /expects an array of values/
            );
        });

        it('should bind one parameter per placeholder when the value overrides map()', async () => {
            class DishonestArray extends Array {
                map(): any[] {
                    return ['?', '?', '?', '?', '?'];
                }
            }

            const values = new DishonestArray();
            values.push('a', 'b');

            await repo.find({ where: { name: { operator: 'IN', value: values } as any } });

            const query = executeSpy.mock.calls[0][0] as string;
            const params = executeSpy.mock.calls[0][1] as unknown[];

            expect(query).toBe('SELECT * FROM items WHERE name IN (?, ?)');
            expect(query.split('?').length - 1).toBe(params.length);
        });

        it('should hold the placeholder-to-parameter invariant for an ordinary list', async () => {
            await repo.find({ where: { name: In(['a', 'b', 'c']), quantity: GreaterThan(1) } });

            const query = executeSpy.mock.calls[0][0] as string;
            const params = executeSpy.mock.calls[0][1] as unknown[];

            expect(query.split('?').length - 1).toBe(params.length);
            expect(params).toEqual(['a', 'b', 'c', 1]);
        });

        it('should reject a non-bindable element in the list', async () => {
            await expect(repo.find({ where: { name: In([{ evil: true }, 'a']) } })).rejects.toThrow(
                /Invalid value of type object for operator IN on column "name"/
            );
            expect(executeSpy).not.toHaveBeenCalled();
        });
    });

    describe('operators and values', () => {
        it('should reject an operator the builder does not emit', async () => {
            await expect(repo.findBy({ name: { operator: 'LIKE', value: 'W%' } as any })).rejects.toThrow(
                /Unsupported operator "LIKE"/
            );
        });

        it('should reject a value the driver cannot bind', async () => {
            await expect(repo.findBy({ quantity: { operator: '>', value: {} } as any })).rejects.toThrow(
                /Invalid value of type object for operator > on column "quantity"/
            );
        });

        it('should reject a plain object as an equality value', async () => {
            await expect(repo.findBy({ name: { nested: true } as any })).rejects.toThrow(
                /Invalid value of type object for operator = on column "name"/
            );
        });
    });

    describe('empty clauses', () => {
        it('should reject findBy({})', async () => {
            await expect(repo.findBy({})).rejects.toThrow(/Empty where clause on entity Item/);
        });

        it('should reject find({ where: {} })', async () => {
            await expect(repo.find({ where: {} })).rejects.toThrow(InvalidQueryError);
        });

        it('should reject find({ orderBy: {} })', async () => {
            await expect(repo.find({ orderBy: {} })).rejects.toThrow(/Empty orderBy clause on entity Item/);
        });

        it('should reject findOneBy({})', async () => {
            await expect(repo.findOneBy({})).rejects.toThrow(/Empty findOneBy\(\) conditions on entity Item/);
        });

        it('should reject delete({})', async () => {
            await expect(repo.delete({})).rejects.toThrow(/Empty delete\(\) conditions on entity Item/);
        });

        it('should not execute a query for any of them', async () => {
            await expect(repo.findBy({})).rejects.toThrow();
            await expect(repo.find({ where: {} })).rejects.toThrow();
            await expect(repo.find({ orderBy: {} })).rejects.toThrow();
            await expect(repo.findOneBy({})).rejects.toThrow();
            await expect(repo.delete({})).rejects.toThrow();

            expect(executeSpy).not.toHaveBeenCalled();
        });

        it('should still select every row when where is omitted entirely', async () => {
            await repo.find();

            expect(executeSpy.mock.calls[0][0]).toBe('SELECT * FROM items');
        });
    });

    describe('single-pass enumeration', () => {
        /**
         * Reading the keys and then the values enumerates twice; a getter that
         * removes a sibling in between makes the two disagree.
         */
        function selfMutating(): Partial<Item> {
            const conditions: any = {};

            Object.defineProperty(conditions, 'id', {
                enumerable: true,
                get() {
                    delete conditions.name;
                    return 'abc-123';
                },
            });
            conditions.name = 'Widget';

            return conditions as Partial<Item>;
        }

        it('should bind one parameter per placeholder in findOneBy()', async () => {
            await repo.findOneBy(selfMutating());

            const query = executeSpy.mock.calls[0][0] as string;
            const params = executeSpy.mock.calls[0][1] as unknown[];

            expect(query.split('?').length - 1).toBe(params.length);
            expect(params).toEqual(['abc-123']);
        });

        it('should bind one parameter per placeholder in delete()', async () => {
            await repo.delete(selfMutating());

            const query = executeSpy.mock.calls[0][0] as string;
            const params = executeSpy.mock.calls[0][1] as unknown[];

            expect(query.split('?').length - 1).toBe(params.length);
            expect(query).toBe('DELETE FROM items WHERE id = ?');
        });
    });

    describe('values the ORM does not model', () => {
        it('should still bind a Date through findOneBy()', async () => {
            const when = new Date();

            await repo.findOneBy({ name: when as any });

            expect(executeSpy.mock.calls[0][1]).toEqual([when]);
        });

        it('should bind a Buffer through findBy()', async () => {
            const blob = Buffer.from('abc');

            await repo.findBy({ name: blob as any });

            expect(executeSpy.mock.calls[0][0]).toBe('SELECT * FROM items WHERE name = ?');
            expect(executeSpy.mock.calls[0][1]).toEqual([blob]);
        });
    });
});
