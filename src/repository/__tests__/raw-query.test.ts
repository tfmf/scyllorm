import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataSource } from '../../data-source/DataSource';
import { Repository } from '../Repository';
import { BaseModel } from '../../model/BaseModel';
import { Entity } from '../../decorators/Entity';
import { Column } from '../../decorators/Column';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';
import { InvalidQueryError, QueryFailedError, ScyllormError } from '../../errors';

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

describe('runRawQuery', () => {
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

    describe('named parameters', () => {
        it('should substitute every :name with a positional placeholder', async () => {
            await repo.runRawQuery('SELECT * FROM items WHERE id = :id AND quantity > :quantity', {
                id: 'abc',
                quantity: 3,
            });

            expect(executeSpy).toHaveBeenCalledWith('SELECT * FROM items WHERE id = ? AND quantity > ?', ['abc', 3], {
                prepare: true,
            });
        });

        it('should bind values in the order the placeholders appear, not the order of the params object', async () => {
            await repo.runRawQuery('SELECT * FROM items WHERE quantity > :quantity AND id = :id', {
                id: 'abc',
                quantity: 3,
            });

            const [, params] = executeSpy.mock.calls[0];
            expect(params).toEqual([3, 'abc']);
        });

        it('should bind a value once per occurrence when a parameter is repeated', async () => {
            const query = 'SELECT * FROM items WHERE quantity > :quantity AND quantity < :quantity';
            await repo.runRawQuery(query, { quantity: 3 });

            const [emitted, params] = executeSpy.mock.calls[0];
            expect(params).toEqual([3, 3]);
            expect(emitted.split('?').length - 1).toBe(params.length);
        });

        it('should ignore params the query never references', async () => {
            await repo.runRawQuery('SELECT * FROM items WHERE id = :id', { id: 'abc', unused: 'x' });

            expect(executeSpy).toHaveBeenCalledWith('SELECT * FROM items WHERE id = ?', ['abc'], { prepare: true });
        });

        it('should leave a query with no placeholders untouched', async () => {
            await repo.runRawQuery('SELECT * FROM items', {});

            expect(executeSpy).toHaveBeenCalledWith('SELECT * FROM items', [], { prepare: true });
        });
    });

    describe('missing parameters', () => {
        it('should throw an InvalidQueryError naming the parameter', async () => {
            await expect(repo.runRawQuery('SELECT * FROM items WHERE id = :id', {})).rejects.toThrow(InvalidQueryError);
        });

        it('should carry the ScyllormError code so callers can switch on it', async () => {
            const error = await repo.runRawQuery('SELECT * FROM items WHERE id = :id', {}).catch((caught) => caught);

            expect(error).toBeInstanceOf(ScyllormError);
            expect(error.code).toBe('SCYLLORM_INVALID_QUERY');
            expect(error.message).toContain('"id"');
        });

        it('should not execute anything when a parameter is missing', async () => {
            await expect(repo.runRawQuery('SELECT * FROM items WHERE id = :id', {})).rejects.toThrow(ScyllormError);

            expect(executeSpy).not.toHaveBeenCalled();
        });

        it('should reject a parameter inherited from the prototype rather than binding it', async () => {
            (Object.prototype as any).id = 'polluted';

            try {
                await expect(repo.runRawQuery('SELECT * FROM items WHERE id = :id', {} as any)).rejects.toThrow(
                    InvalidQueryError
                );
                expect(executeSpy).not.toHaveBeenCalled();
            } finally {
                delete (Object.prototype as any).id;
            }
        });
    });

    describe('ALLOW FILTERING', () => {
        it('should append the clause after substitution when asked', async () => {
            await repo.runRawQuery('SELECT * FROM items WHERE name = :name', { name: 'widget' }, true);

            expect(executeSpy).toHaveBeenCalledWith('SELECT * FROM items WHERE name = ? ALLOW FILTERING', ['widget'], {
                prepare: true,
            });
        });

        it('should not append the clause by default', async () => {
            await repo.runRawQuery('SELECT * FROM items WHERE name = :name', { name: 'widget' });

            const [emitted] = executeSpy.mock.calls[0];
            expect(emitted).not.toContain('ALLOW FILTERING');
        });
    });

    describe('escape hatch: no identifier validation', () => {
        it('should pass a token() range through, which find() rejects', async () => {
            const query = 'SELECT * FROM items WHERE token(id) > token(:id)';
            await repo.runRawQuery(query, { id: 'abc' });

            expect(executeSpy).toHaveBeenCalledWith('SELECT * FROM items WHERE token(id) > token(?)', ['abc'], {
                prepare: true,
            });
            await expect(repo.findBy({ 'token(id)': 'abc' } as any)).rejects.toThrow(InvalidQueryError);
        });

        it('should pass collection access through', async () => {
            await repo.runRawQuery("SELECT * FROM items WHERE metadata['k'] = :v", { v: 'x' });

            const [emitted] = executeSpy.mock.calls[0];
            expect(emitted).toBe("SELECT * FROM items WHERE metadata['k'] = ?");
        });

        it('should pass a quoted identifier through', async () => {
            await repo.runRawQuery('SELECT * FROM items WHERE "CaseSensitive" = :v', { v: 'x' });

            const [emitted] = executeSpy.mock.calls[0];
            expect(emitted).toBe('SELECT * FROM items WHERE "CaseSensitive" = ?');
        });

        it('should not check columns against the entity at all', async () => {
            await repo.runRawQuery('SELECT * FROM other_table WHERE nonexistent_column = :v', { v: 'x' });

            const [emitted] = executeSpy.mock.calls[0];
            expect(emitted).toBe('SELECT * FROM other_table WHERE nonexistent_column = ?');
        });
    });

    describe('driver failures', () => {
        class DriverError extends Error {}

        it('should wrap the failure in a QueryFailedError', async () => {
            executeSpy.mockRejectedValue(new DriverError('unconfigured table items'));

            await expect(repo.runRawQuery('SELECT * FROM items', {})).rejects.toThrow(QueryFailedError);
        });

        it('should keep the original error whole on cause', async () => {
            const driverError = new DriverError('unconfigured table items');
            executeSpy.mockRejectedValue(driverError);

            const error = await repo.runRawQuery('SELECT * FROM items', {}).catch((caught) => caught);

            expect(error.code).toBe('SCYLLORM_QUERY_FAILED');
            expect(error.cause).toBe(driverError);
            expect(error.cause).toBeInstanceOf(DriverError);
            expect(error.cause.stack).toBe(driverError.stack);
        });

        it('should report the driver message and carry the query that failed', async () => {
            executeSpy.mockRejectedValue(new DriverError('unconfigured table items'));

            const error = await repo
                .runRawQuery('SELECT * FROM items WHERE id = :id', { id: 'abc' })
                .catch((caught) => caught);

            expect(error.message).toBe('Query failed: unconfigured table items');
            expect(error.query).toBe('SELECT * FROM items WHERE id = ?');
        });

        it('should survive a non-Error rejection', async () => {
            executeSpy.mockRejectedValue('boom');

            const error = await repo.runRawQuery('SELECT * FROM items', {}).catch((caught) => caught);

            expect(error).toBeInstanceOf(QueryFailedError);
            expect(error.message).toBe('Query failed: boom');
            expect(error.cause).toBe('boom');
        });
    });

    describe('result mapping', () => {
        it('should map rows onto entity instances', async () => {
            executeSpy.mockResolvedValue([{ id: 'abc', name: 'widget', quantity: 3 }]);

            const rows = await repo.runRawQuery('SELECT * FROM items', {});

            expect(rows).toHaveLength(1);
            expect(rows[0]).toBeInstanceOf(Item);
            expect(rows[0].name).toBe('widget');
        });

        it('should hand back the driver rows untouched when raw is set', async () => {
            executeSpy.mockResolvedValue([{ count: 42 }]);

            const rows = await repo.runRawQuery<{ count: number }>(
                'SELECT COUNT(*) AS count FROM items',
                {},
                {
                    raw: true,
                }
            );

            expect(rows[0]).not.toBeInstanceOf(Item);
            expect(rows[0].count).toBe(42);
        });

        it('should not silently drop a column the entity does not declare', async () => {
            const row = { id: 'abc', unmodelled: 'kept' };
            executeSpy.mockResolvedValue([row]);

            const mapped = await repo.runRawQuery('SELECT * FROM items', {});
            const raw = await repo.runRawQuery('SELECT * FROM items', {}, { raw: true });

            expect((mapped[0] as any).unmodelled).toBeUndefined();
            expect(raw[0]).toBe(row);
        });
    });

    describe('options', () => {
        it('should still accept the positional allowFiltering boolean', async () => {
            await repo.runRawQuery('SELECT * FROM items', {}, true);

            const [emitted] = executeSpy.mock.calls[0];
            expect(emitted).toBe('SELECT * FROM items ALLOW FILTERING');
        });

        it('should accept allowFiltering in the options bag', async () => {
            await repo.runRawQuery('SELECT * FROM items', {}, { allowFiltering: true });

            const [emitted] = executeSpy.mock.calls[0];
            expect(emitted).toBe('SELECT * FROM items ALLOW FILTERING');
        });

        it('should pass fetchSize to the driver alongside prepare', async () => {
            await repo.runRawQuery('SELECT * FROM items', {}, { fetchSize: 100 });

            expect(executeSpy).toHaveBeenCalledWith('SELECT * FROM items', [], { prepare: true, fetchSize: 100 });
        });

        it('should bind a value the ORM does not model, such as a Date', async () => {
            const at = new Date('2020-01-01T00:00:00Z');

            await repo.runRawQuery('SELECT * FROM items WHERE at = :at', { at });

            const [, params] = executeSpy.mock.calls[0];
            expect(params[0]).toBe(at);
        });
    });
});

describe('runRawQueryPaged', () => {
    let ds: DataSource;
    let repo: Repository<Item>;
    let pageSpy: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        vi.clearAllMocks();
        ds = new DataSource({ contactPoints: ['localhost'], localDataCenter: 'datacenter1', keyspace: 'test' });
        await ds.initialize();
        repo = ds.getRepository<Item>(Item);
        pageSpy = vi.fn().mockResolvedValue({ rows: [] });
        (ds as any).executeQueryPage = pageSpy;
    });

    it('should substitute parameters exactly as runRawQuery does', async () => {
        await repo.runRawQueryPaged("SELECT * FROM items WHERE t = '12:30:00' AND id = :id", { id: 'abc' });

        expect(pageSpy).toHaveBeenCalledWith("SELECT * FROM items WHERE t = '12:30:00' AND id = ?", ['abc'], {
            prepare: true,
        });
    });

    it('should carry fetchSize and pageState to the driver', async () => {
        await repo.runRawQueryPaged('SELECT * FROM items', {}, { fetchSize: 10, pageState: 'cursor' });

        expect(pageSpy).toHaveBeenCalledWith('SELECT * FROM items', [], {
            prepare: true,
            fetchSize: 10,
            pageState: 'cursor',
        });
    });

    it('should report more pages when the driver returns a cursor', async () => {
        pageSpy.mockResolvedValue({ rows: [{ id: 'abc', name: 'widget' }], pageState: 'next' });

        const page = await repo.runRawQueryPaged('SELECT * FROM items', {});

        expect(page.rows[0]).toBeInstanceOf(Item);
        expect(page.pageState).toBe('next');
        expect(page.hasMore).toBe(true);
    });

    it('should report the end of the result set when there is no cursor', async () => {
        pageSpy.mockResolvedValue({ rows: [], pageState: undefined });

        const page = await repo.runRawQueryPaged('SELECT * FROM items', {});

        expect(page.hasMore).toBe(false);
        expect(page.pageState).toBeUndefined();
    });

    it('should leave rows unmapped when raw is set', async () => {
        pageSpy.mockResolvedValue({ rows: [{ count: 1 }] });

        const page = await repo.runRawQueryPaged('SELECT COUNT(*) AS count FROM items', {}, { raw: true });

        expect(page.rows[0]).not.toBeInstanceOf(Item);
    });

    it('should append ALLOW FILTERING when asked', async () => {
        await repo.runRawQueryPaged('SELECT * FROM items', {}, { allowFiltering: true });

        const [emitted] = pageSpy.mock.calls[0];
        expect(emitted).toBe('SELECT * FROM items ALLOW FILTERING');
    });

    it('should throw before executing when a parameter is missing', async () => {
        await expect(repo.runRawQueryPaged('SELECT * FROM items WHERE id = :id', {})).rejects.toThrow(
            InvalidQueryError
        );

        expect(pageSpy).not.toHaveBeenCalled();
    });

    it('should wrap a driver failure', async () => {
        const driverError = new Error('unconfigured table items');
        pageSpy.mockRejectedValue(driverError);

        const error = await repo.runRawQueryPaged('SELECT * FROM items', {}).catch((caught) => caught);

        expect(error).toBeInstanceOf(QueryFailedError);
        expect(error.cause).toBe(driverError);
    });
});

describe('streamRawQuery', () => {
    let ds: DataSource;
    let repo: Repository<Item>;
    let streamSpy: ReturnType<typeof vi.fn>;

    const iterate = (rows: object[]) =>
        vi.fn().mockImplementation(async function* () {
            yield* rows;
        });

    const collect = async <R>(rows: AsyncIterableIterator<R>): Promise<R[]> => {
        const collected: R[] = [];

        for await (const row of rows) {
            collected.push(row);
        }

        return collected;
    };

    beforeEach(async () => {
        vi.clearAllMocks();
        ds = new DataSource({ contactPoints: ['localhost'], localDataCenter: 'datacenter1', keyspace: 'test' });
        await ds.initialize();
        repo = ds.getRepository<Item>(Item);
        streamSpy = iterate([]);
        (ds as any).streamQuery = streamSpy;
    });

    it('should yield each row mapped onto the entity', async () => {
        (ds as any).streamQuery = iterate([
            { id: 'a', name: 'first' },
            { id: 'b', name: 'second' },
        ]);

        const rows = await collect(repo.streamRawQuery('SELECT * FROM items', {}));

        expect(rows).toHaveLength(2);
        expect(rows[0]).toBeInstanceOf(Item);
        expect(rows[1].name).toBe('second');
    });

    it('should yield driver rows untouched when raw is set', async () => {
        (ds as any).streamQuery = iterate([{ count: 7 }]);

        const rows = await collect(
            repo.streamRawQuery<{ count: number }>('SELECT COUNT(*) FROM items', {}, { raw: true })
        );

        expect(rows[0]).not.toBeInstanceOf(Item);
        expect(rows[0].count).toBe(7);
    });

    it('should substitute parameters and carry fetchSize', async () => {
        await collect(repo.streamRawQuery('SELECT * FROM items WHERE id = :id', { id: 'abc' }, { fetchSize: 10 }));

        expect(streamSpy).toHaveBeenCalledWith('SELECT * FROM items WHERE id = ?', ['abc'], {
            prepare: true,
            fetchSize: 10,
        });
    });

    it('should append ALLOW FILTERING when asked', async () => {
        await collect(repo.streamRawQuery('SELECT * FROM items', {}, { allowFiltering: true }));

        const [emitted] = streamSpy.mock.calls[0];
        expect(emitted).toBe('SELECT * FROM items ALLOW FILTERING');
    });

    it('should throw before executing when a parameter is missing', async () => {
        await expect(collect(repo.streamRawQuery('SELECT * FROM items WHERE id = :id', {}))).rejects.toThrow(
            InvalidQueryError
        );

        expect(streamSpy).not.toHaveBeenCalled();
    });

    it('should wrap a driver failure raised part way through the scan', async () => {
        const driverError = new Error('read timeout');
        (ds as any).streamQuery = vi.fn().mockImplementation(async function* () {
            yield { id: 'a', name: 'first' };
            throw driverError;
        });

        const rows: Item[] = [];
        const error = await (async () => {
            try {
                for await (const row of repo.streamRawQuery('SELECT * FROM items', {})) {
                    rows.push(row);
                }
            } catch (caught) {
                return caught as QueryFailedError;
            }
        })();

        expect(rows).toHaveLength(1);
        expect(error).toBeInstanceOf(QueryFailedError);
        expect(error!.cause).toBe(driverError);
    });

    it('should not dress a consumer error up as a query failure', async () => {
        (ds as any).streamQuery = iterate([{ id: 'a' }, { id: 'b' }]);
        const consumerError = new Error('consumer gave up');

        const caught = await (async () => {
            try {
                for await (const row of repo.streamRawQuery('SELECT * FROM items', {})) {
                    void row;
                    throw consumerError;
                }
            } catch (error) {
                return error;
            }
        })();

        expect(caught).toBe(consumerError);
    });

    it('should not dress an exception thrown into the iterator up as a query failure', async () => {
        (ds as any).streamQuery = iterate([{ id: 'a' }, { id: 'b' }]);
        const cancellation = new Error('cancelled');
        const rows = repo.streamRawQuery('SELECT * FROM items', {});

        await rows.next();

        // The discriminating case for stepping the iterator by hand: inside a
        // `for await`, this would surface at the yield and be caught as a query failure
        await expect(rows.throw!(cancellation)).rejects.toBe(cancellation);
    });
});

describe('QueryFailedError', () => {
    it('should be a ScyllormError with a stable code', () => {
        const error = new QueryFailedError('SELECT * FROM items', new Error('boom'));

        expect(error).toBeInstanceOf(ScyllormError);
        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe('QueryFailedError');
        expect(error.code).toBe('SCYLLORM_QUERY_FAILED');
    });
});
