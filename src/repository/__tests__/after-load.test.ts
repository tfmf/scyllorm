import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataSource } from '../../data-source/DataSource';
import { Repository } from '../Repository';
import { BaseModel } from '../../model/BaseModel';
import { Entity } from '../../decorators/Entity';
import { Column } from '../../decorators/Column';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';
import { QueryFailedError } from '../../errors';

/* eslint-disable @typescript-eslint/no-explicit-any */

vi.mock('cassandra-driver', async (importOriginal) => {
    class MockClient {
        connect = vi.fn().mockResolvedValue(undefined);
        shutdown = vi.fn().mockResolvedValue(undefined);
        execute = vi.fn().mockResolvedValue({ rows: [] });
    }
    // Partial mock: real value types (`types.Long`, `types.Uuid`, …) stay available
    return {
        ...(await importOriginal<typeof import('cassandra-driver')>()),
        Client: MockClient,
        errors: {
            NoHostAvailableError: class extends Error {},
            DriverInternalError: class extends Error {},
        },
    };
});

// Shared by the entities below; reset in beforeEach
let log: string[] = [];
let failOn: string | undefined;

@Entity('after_load_items')
class LoadedItem extends BaseModel {
    @PrimaryKeyColumn('TEXT')
    id: string;

    @Column('TEXT', { transformer: { to: (v: string) => v, from: (v: string) => v.toUpperCase() } })
    label: string;

    // Set by the hook only
    seen: string | undefined;
    // What the hook observed in the columns when it ran
    labelAtHook: string | undefined;

    async afterLoad(): Promise<void> {
        log.push(`start:${this.id}`);
        await new Promise((resolve) => setTimeout(resolve, 1));
        this.labelAtHook = this.label;
        this.seen = 'loaded';
        if (failOn === this.id) {
            throw new Error(`hook failed for ${this.id}`);
        }
        log.push(`end:${this.id}`);
    }
}

@Entity('after_load_children')
class LoadedChild extends LoadedItem {}

@Entity('after_load_plain')
class PlainItem extends BaseModel {
    @PrimaryKeyColumn('TEXT')
    id: string;

    @Column('TEXT')
    label: string;
}

const rows = [
    { id: 'a', label: 'one' },
    { id: 'b', label: 'two' },
    { id: 'c', label: 'three' },
];

describe('afterLoad()', () => {
    let ds: DataSource;
    let repo: Repository<LoadedItem>;
    let executeSpy: ReturnType<typeof vi.fn>;
    let pageSpy: ReturnType<typeof vi.fn>;
    let streamSpy: ReturnType<typeof vi.fn>;
    let hookSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
        vi.restoreAllMocks();
        vi.clearAllMocks();
        log = [];
        failOn = undefined;
        ds = new DataSource({ contactPoints: ['localhost'], localDataCenter: 'datacenter1', keyspace: 'test' });
        await ds.initialize();
        repo = ds.getRepository<LoadedItem>(LoadedItem);
        executeSpy = vi.fn().mockImplementation(async () => rows.map((row) => ({ ...row })));
        pageSpy = vi
            .fn()
            .mockImplementation(async () => ({ rows: rows.map((row) => ({ ...row })), pageState: 'next' }));
        streamSpy = vi.fn(async function* () {
            for (const row of rows) {
                yield { ...row };
            }
        });
        (ds as any).executeQuery = executeSpy;
        (ds as any).executeQueryPage = pageSpy;
        (ds as any).streamQuery = streamSpy;
        hookSpy = vi.spyOn(LoadedItem.prototype, 'afterLoad');
    });

    // Each read path, with how it hands back its entities
    const paths: Array<[string, () => Promise<LoadedItem[]>, number]> = [
        ['find()', () => repo.find(), 3],
        ['findPaged()', async () => (await repo.findPaged()).rows, 3],
        [
            'stream()',
            async () => {
                const out: LoadedItem[] = [];
                for await (const entity of repo.stream()) {
                    out.push(entity);
                }
                return out;
            },
            3,
        ],
        ['findBy()', () => repo.findBy({ id: 'a' }), 3],
        ['findOneBy()', async () => [(await repo.findOneBy({ id: 'a' }))!], 1],
        ['findOne()', async () => [(await repo.findOne())!], 1],
        ['findOneOrFail()', async () => [await repo.findOneOrFail({ id: 'a' })], 1],
        ['runRawQuery()', () => repo.runRawQuery('SELECT * FROM after_load_items', {}), 3],
        ['runRawQueryPaged()', async () => (await repo.runRawQueryPaged('SELECT * FROM after_load_items', {})).rows, 3],
        [
            'streamRawQuery()',
            async () => {
                const out: LoadedItem[] = [];
                for await (const entity of repo.streamRawQuery('SELECT * FROM after_load_items', {})) {
                    out.push(entity);
                }
                return out;
            },
            3,
        ],
    ];

    describe.each(paths)('%s', (_name, run, expected) => {
        it('calls afterLoad once per entity and awaits it', async () => {
            const entities = await run();

            expect(entities).toHaveLength(expected);
            expect(hookSpy).toHaveBeenCalledTimes(expected);
            // The hook sets this after a tick: only visible if it was awaited
            expect(entities.every((entity) => entity.seen === 'loaded')).toBe(true);
            expect(entities.every((entity) => entity instanceof LoadedItem)).toBe(true);
        });

        it('runs the hook after the columns, transformer.from included, are assigned', async () => {
            const entities = await run();

            expect(entities.map((entity) => entity.labelAtHook)).toEqual(['ONE', 'TWO', 'THREE'].slice(0, expected));
        });
    });

    describe('order', () => {
        it('find() runs the hooks one at a time, in row order, after all rows are mapped', async () => {
            await repo.find();

            expect(log).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
        });

        it('find() maps every row before the first hook runs', async () => {
            const mapped: string[] = [];
            const original = (repo as any).mapRowToEntity.bind(repo);
            (repo as any).mapRowToEntity = (row: { id: string }) => {
                mapped.push(row.id);
                return original(row);
            };
            hookSpy.mockImplementation(function (this: LoadedItem) {
                log.push(`hook:${this.id}:after-${mapped.length}-mapped`);
            });

            await repo.find();

            expect(log).toEqual(['hook:a:after-3-mapped', 'hook:b:after-3-mapped', 'hook:c:after-3-mapped']);
        });

        it('findPaged() and runRawQuery() also run in row order', async () => {
            await repo.findPaged();
            expect(log.filter((entry) => entry.startsWith('end:'))).toEqual(['end:a', 'end:b', 'end:c']);

            log = [];
            await repo.runRawQuery('SELECT * FROM after_load_items', {});
            expect(log.filter((entry) => entry.startsWith('end:'))).toEqual(['end:a', 'end:b', 'end:c']);
        });
    });

    describe('what does not call it', () => {
        it('skips raw: true on runRawQuery, runRawQueryPaged and streamRawQuery', async () => {
            const list = await repo.runRawQuery('SELECT * FROM after_load_items', {}, { raw: true });
            const page = await repo.runRawQueryPaged('SELECT * FROM after_load_items', {}, { raw: true });
            const streamed: object[] = [];
            for await (const row of repo.streamRawQuery('SELECT * FROM after_load_items', {}, { raw: true })) {
                streamed.push(row);
            }

            expect(hookSpy).not.toHaveBeenCalled();
            // Plain rows, not entities
            expect(list[0]).not.toBeInstanceOf(LoadedItem);
            expect(page.rows[0]).not.toBeInstanceOf(LoadedItem);
            expect(streamed[0]).not.toBeInstanceOf(LoadedItem);
            expect(list[0]).toEqual({ id: 'a', label: 'one' });
        });

        it('is not called by save() or create()', async () => {
            const entity = repo.create({ id: 'x', label: 'y' });
            await repo.save(entity);

            expect(hookSpy).not.toHaveBeenCalled();
            expect(entity.seen).toBeUndefined();
        });

        it('is not called by count(), countBy(), exists() or existsBy()', async () => {
            executeSpy.mockResolvedValue([{ count: 3 }]);
            await repo.count();
            await repo.countBy({ id: 'a' });
            await repo.exists();
            await repo.existsBy({ id: 'a' });

            expect(hookSpy).not.toHaveBeenCalled();
        });

        it('is not called when a read finds nothing', async () => {
            executeSpy.mockResolvedValue([]);

            expect(await repo.find()).toEqual([]);
            expect(await repo.findOneBy({ id: 'zz' })).toBeNull();
            expect(hookSpy).not.toHaveBeenCalled();
        });
    });

    describe('errors', () => {
        beforeEach(() => {
            failOn = 'b';
        });

        it('a throwing hook rejects find() with its own error', async () => {
            await expect(repo.find()).rejects.toThrow('hook failed for b');
        });

        it('a throwing hook rejects findPaged(), findBy() and findOneBy()', async () => {
            failOn = 'a';
            await expect(repo.findPaged()).rejects.toThrow('hook failed for a');
            await expect(repo.findBy({ id: 'a' })).rejects.toThrow('hook failed for a');
            await expect(repo.findOneBy({ id: 'a' })).rejects.toThrow('hook failed for a');
            await expect(repo.findOne()).rejects.toThrow('hook failed for a');
            await expect(repo.findOneOrFail({ id: 'a' })).rejects.toThrow('hook failed for a');
        });

        it('a throwing hook stops later hooks from running', async () => {
            await expect(repo.find()).rejects.toThrow();

            expect(log).toEqual(['start:a', 'end:a', 'start:b']);
        });

        it('the raw family rejects with the hook error, not a QueryFailedError', async () => {
            failOn = 'a';
            const query = 'SELECT * FROM after_load_items';
            const results = await Promise.allSettled([
                repo.runRawQuery(query, {}),
                repo.runRawQueryPaged(query, {}),
                repo.streamRawQuery(query, {}).next(),
            ]);

            for (const result of results) {
                expect(result.status).toBe('rejected');
                const reason = (result as PromiseRejectedResult).reason;
                expect(reason).not.toBeInstanceOf(QueryFailedError);
                expect(reason).toBeInstanceOf(Error);
                expect(reason.message).toBe('hook failed for a');
            }
        });

        it('stream() yields hooked entities, then rejects on the next() of the failing row', async () => {
            const iterator = repo.stream();

            const first = await iterator.next();
            expect(first.value.id).toBe('a');
            expect(first.value.seen).toBe('loaded');

            await expect(iterator.next()).rejects.toThrow('hook failed for b');
        });

        it('streamRawQuery() yields hooked entities, then rejects with the hook error', async () => {
            const iterator = repo.streamRawQuery('SELECT * FROM after_load_items', {});

            expect((await iterator.next()).value.seen).toBe('loaded');

            const failure = await iterator.next().catch((error) => error);
            expect(failure).not.toBeInstanceOf(QueryFailedError);
            expect(failure.message).toBe('hook failed for b');
        });
    });

    describe('entities', () => {
        it('without afterLoad behave as before', async () => {
            const plainRepo = ds.getRepository<PlainItem>(PlainItem);

            const found = await plainRepo.find();
            const one = await plainRepo.findOneBy({ id: 'a' });

            expect(found).toHaveLength(3);
            expect(found[0]).toBeInstanceOf(PlainItem);
            expect(found.map((entity) => ({ id: entity.id, label: entity.label }))).toEqual(rows);
            expect(one).toBeInstanceOf(PlainItem);
            expect(one!.id).toBe('a');
            expect((found[0] as any).afterLoad).toBeUndefined();
        });

        it('with a non-function afterLoad member are read without calling it', async () => {
            // A JavaScript entity, or one typed loosely, can hold a plain value under that name
            class ValueItem extends PlainItem {}
            (ValueItem.prototype as any).afterLoad = 'not a hook';
            const valueRepo = ds.getRepository<ValueItem>(ValueItem);

            const found = await valueRepo.find();

            expect(found).toHaveLength(3);
            expect((found[0] as any).afterLoad).toBe('not a hook');
        });

        it('with an afterLoad of their own returning a value still compile and have it awaited', async () => {
            class Counting extends PlainItem {
                loaded = 0;
                async afterLoad(): Promise<number> {
                    return ++this.loaded;
                }
            }
            const countingRepo = ds.getRepository<Counting>(Counting);

            const found = await countingRepo.find();

            expect(found.map((entity) => entity.loaded)).toEqual([1, 1, 1]);
        });

        it('inherit a parent afterLoad in a subclass', async () => {
            const childRepo = ds.getRepository<LoadedChild>(LoadedChild);

            const found = await childRepo.find();

            expect(found).toHaveLength(3);
            expect(found[0]).toBeInstanceOf(LoadedChild);
            expect(found.every((entity) => entity.seen === 'loaded')).toBe(true);
            expect(found.map((entity) => entity.labelAtHook)).toEqual(['ONE', 'TWO', 'THREE']);
            expect(log).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
        });
    });
});
