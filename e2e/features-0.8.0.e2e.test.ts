import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    Append,
    BaseModel,
    Column,
    DataSource,
    Entity,
    In,
    Index,
    InvalidQueryError,
    Prepend,
    PrimaryKeyColumn,
    PutKeys,
    Remove,
    RemoveKeys,
    Repository,
} from '../src';

// Features of 0.8.0 that only a real server can vouch for: renamed columns,
// transformers, static columns, afterLoad and collection updates.

const KS = 'scyllorm_v080';
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

@Entity(`${KS}.people`)
@Index('people_last_name_idx', 'lastName')
class Person extends BaseModel {
    @PrimaryKeyColumn('INT', { partitionKey: true, name: 'org_id' })
    orgId: number;

    @PrimaryKeyColumn('INT', { clusteringKey: true, order: 'DESC', name: 'person_seq' })
    personSeq: number;

    @Column('TEXT', { name: 'first_name' })
    firstName: string;

    @Column('TEXT', { name: 'last_name' })
    lastName: string;
}

enum Level {
    Low = 1,
    Mid = 2,
    High = 3,
}

@Entity(`${KS}.settings`)
class Setting extends BaseModel {
    @PrimaryKeyColumn('INT', { partitionKey: true })
    id: number;

    @Column('TEXT', {
        transformer: {
            to: (v) => JSON.stringify(v),
            from: (v) => JSON.parse(v as string),
        },
    })
    payload: { a: number; tags: string[] };

    @Column('INT', {
        transformer: { to: (v) => v as number, from: (v) => Level[v as number] },
    })
    level: Level | string;
}

@Entity(`${KS}.static_rows`)
class StaticRow extends BaseModel {
    @PrimaryKeyColumn('INT', { partitionKey: true })
    pid: number;

    @PrimaryKeyColumn('INT', { clusteringKey: true })
    seq: number;

    @Column('TEXT', { static: true })
    owner: string;

    @Column('TEXT')
    body: string;
}

@Entity(`${KS}.hooked`)
class Hooked extends BaseModel {
    static loaded = 0;

    @PrimaryKeyColumn('INT', { partitionKey: true })
    id: number;

    @Column('TEXT')
    body: string;

    seen = false;

    async afterLoad(): Promise<void> {
        Hooked.loaded++;
        this.seen = true;
    }
}

@Entity(`${KS}.collections`)
class Coll extends BaseModel {
    @PrimaryKeyColumn('INT', { partitionKey: true })
    id: number;

    @Column('LIST', { of: 'INT' })
    lst: number[];

    @Column('SET', { of: 'TEXT' })
    st: string[];

    @Column('MAP', { of: ['TEXT', 'INT'] })
    mp: Record<string, number>;
}

describe('0.8.0 features against a live ScyllaDB', () => {
    let ds: DataSource;
    let people: Repository<Person>;
    let settings: Repository<Setting>;
    let statics: Repository<StaticRow>;
    let hooked: Repository<Hooked>;
    let colls: Repository<Coll>;

    const coll = async (id: number): Promise<Coll> => (await colls.findOneBy({ id }))!;
    // Written a minute in the past: a Paxos (IF EXISTS) update stamped in the same millisecond as the
    // seed could otherwise lose to the seed's list tombstone
    const seed = (id: number): Promise<unknown> =>
        colls.save(colls.create({ id, lst: [1, 2, 3], st: ['a', 'b'], mp: { x: 1, y: 2 } }), {
            timestamp: (Date.now() - 60_000) * 1000,
        });

    beforeAll(async () => {
        ds = new DataSource({ contactPoints: ['127.0.0.1'], localDataCenter: 'datacenter1', logger: silent });
        await ds.initialize();
        await ds.executeQuery(
            `CREATE KEYSPACE IF NOT EXISTS ${KS} ` +
                "WITH replication = { 'class': 'SimpleStrategy', 'replication_factor': 1 } " +
                "AND tablets = { 'enabled': false }",
            [],
            { prepare: false }
        );
        await ds.synchronize([Person, Setting, StaticRow, Hooked, Coll]);
        people = ds.getRepository(Person);
        settings = ds.getRepository(Setting);
        statics = ds.getRepository(StaticRow);
        hooked = ds.getRepository(Hooked);
        colls = ds.getRepository(Coll);
    });

    afterAll(async () => {
        if (ds) {
            try {
                await ds.executeQuery(`DROP KEYSPACE IF EXISTS ${KS}`, [], { prepare: false });
            } finally {
                await ds.shutdown();
            }
        }
    });

    it('creates snake_case columns for a camelCase model', async () => {
        const rows = await ds.executeQuery<{ column_name: string; kind: string }>(
            'SELECT column_name, kind FROM system_schema.columns WHERE keyspace_name = ? AND table_name = ?',
            [KS, 'people']
        );
        const kinds = Object.fromEntries(rows.map((r) => [r.column_name, r.kind]));
        expect(kinds).toEqual({
            org_id: 'partition_key',
            person_seq: 'clustering',
            first_name: 'regular',
            last_name: 'regular',
        });
    });

    it('round-trips renamed columns through find/select/orderBy/update/delete/raw', async () => {
        for (const [seq, first, last] of [
            [1, 'Ann', 'Lee'],
            [2, 'Bob', 'Kim'],
            [3, 'Cy', 'Lee'],
        ] as const) {
            await people.save(people.create({ orgId: 1, personSeq: seq, firstName: first, lastName: last }));
        }

        const all = await people.find({ where: { orgId: 1 } });
        expect(all.map((p) => [p.personSeq, p.firstName, p.lastName])).toEqual([
            [3, 'Cy', 'Lee'],
            [2, 'Bob', 'Kim'],
            [1, 'Ann', 'Lee'],
        ]);

        const asc = await people.find({ where: { orgId: 1 }, orderBy: { personSeq: 'ASC' } });
        expect(asc.map((p) => p.personSeq)).toEqual([1, 2, 3]);

        const sel = await people.find({ where: { orgId: 1, personSeq: 2 }, select: ['firstName'] });
        expect(sel).toHaveLength(1);
        expect(sel[0].firstName).toBe('Bob');

        await people.update({ orgId: 1, personSeq: 2 }, { firstName: 'Rob' });
        expect((await people.findOneBy({ orgId: 1, personSeq: 2 }))!.firstName).toBe('Rob');

        const raw = await people.runRawQuery(
            'SELECT org_id, person_seq, first_name FROM ' + KS + '.people WHERE org_id = :o',
            {
                o: 1,
            }
        );
        expect(raw.map((p) => [p.orgId, p.personSeq, p.firstName]).sort()).toEqual([
            [1, 1, 'Ann'],
            [1, 2, 'Rob'],
            [1, 3, 'Cy'],
        ]);

        await people.delete({ orgId: 1, personSeq: 3 });
        expect(await people.findOneBy({ orgId: 1, personSeq: 3 })).toBeNull();
        expect(await people.count({ orgId: 1 })).toBe(2);
    });

    it('queries a renamed indexed column through its index', async () => {
        const rows = await people.find({ where: { lastName: 'Lee' } });
        expect(rows.map((p) => p.firstName)).toEqual(['Ann']);
    });

    it('round-trips JSON-in-TEXT and enum-as-INT transformers', async () => {
        await settings.save(settings.create({ id: 1, payload: { a: 1, tags: ['x'] }, level: Level.Low }));
        await settings.save(settings.create({ id: 2, payload: { a: 2, tags: [] }, level: Level.High }));
        await settings.save(settings.create({ id: 3, payload: { a: 3, tags: ['y', 'z'] }, level: Level.Mid }));

        const one = (await settings.findOneBy({ id: 1 }))!;
        expect(one.payload).toEqual({ a: 1, tags: ['x'] });
        expect(one.level).toBe('Low');

        // Raw storage holds the transformed value
        const stored = await settings.runRawQuery(
            `SELECT payload, level FROM ${KS}.settings WHERE id = 3`,
            {},
            { raw: true }
        );
        expect(stored[0].payload).toBe('{"a":3,"tags":["y","z"]}');
        expect(stored[0].level).toBe(2);

        await settings.update({ id: 3 }, { payload: { a: 30, tags: [] } });
        expect((await settings.findOneBy({ id: 3 }))!.payload).toEqual({ a: 30, tags: [] });
    });

    it('filters on a transformed column, by equality and with In()', async () => {
        const eq = await settings.find({ where: { level: Level.High } }, true);
        expect(eq.map((s) => s.id)).toEqual([2]);

        const inn = await settings.find({ where: { level: In([Level.Low, Level.Mid]) } }, true);
        expect(inn.map((s) => s.id).sort()).toEqual([1, 3]);
        expect(inn.map((s) => s.level).sort()).toEqual(['Low', 'Mid']);
    });

    it('creates a static column that is shared across a partition', async () => {
        const rows = await ds.executeQuery<{ kind: string }>(
            'SELECT kind FROM system_schema.columns WHERE keyspace_name = ? AND table_name = ? AND column_name = ?',
            [KS, 'static_rows', 'owner']
        );
        expect(rows[0].kind).toBe('static');

        await statics.save(statics.create({ pid: 1, seq: 1, owner: 'me', body: 'a' }));
        await statics.save(statics.create({ pid: 1, seq: 2, body: 'b' } as Partial<StaticRow>));
        const all = await statics.find({ where: { pid: 1 } });
        expect(all).toHaveLength(2);
        expect(all.map((r) => r.owner)).toEqual(['me', 'me']);

        await statics.update({ pid: 1 }, { owner: 'you' });
        expect((await statics.find({ where: { pid: 1 } })).map((r) => r.owner)).toEqual(['you', 'you']);
    });

    it('runs afterLoad on find, stream and raw queries', async () => {
        for (const id of [1, 2, 3]) {
            await hooked.save(hooked.create({ id, body: `b${id}` }));
        }

        Hooked.loaded = 0;
        const found = await hooked.find();
        expect(found).toHaveLength(3);
        expect(found.every((h) => h.seen)).toBe(true);
        expect(Hooked.loaded).toBe(3);

        Hooked.loaded = 0;
        const streamed: Hooked[] = [];
        for await (const h of hooked.stream()) {
            streamed.push(h);
        }
        expect(streamed).toHaveLength(3);
        expect(streamed.every((h) => h.seen)).toBe(true);
        expect(Hooked.loaded).toBe(3);

        Hooked.loaded = 0;
        const raw = await hooked.runRawQuery(`SELECT id, body FROM ${KS}.hooked`);
        expect(raw).toHaveLength(3);
        expect(raw.every((h) => h.seen)).toBe(true);
        expect(Hooked.loaded).toBe(3);

        Hooked.loaded = 0;
        await hooked.runRawQuery(`SELECT id, body FROM ${KS}.hooked`, {}, { raw: true });
        expect(Hooked.loaded).toBe(0);
    });

    it('applies every collection update through update()', async () => {
        await seed(1);

        await colls.update({ id: 1 }, { lst: Append([4, 5]) });
        expect((await coll(1)).lst).toEqual([1, 2, 3, 4, 5]);
        await colls.update({ id: 1 }, { lst: Prepend([0]) });
        expect((await coll(1)).lst).toEqual([0, 1, 2, 3, 4, 5]);
        await colls.update({ id: 1 }, { lst: Remove([0, 5]) });
        expect((await coll(1)).lst).toEqual([1, 2, 3, 4]);

        await colls.update({ id: 1 }, { st: Append(['c']) });
        expect([...(await coll(1)).st].sort()).toEqual(['a', 'b', 'c']);
        await colls.update({ id: 1 }, { st: Remove(['a']) });
        expect([...(await coll(1)).st].sort()).toEqual(['b', 'c']);

        await colls.update({ id: 1 }, { mp: PutKeys({ y: 20, z: 30 }) });
        expect((await coll(1)).mp).toEqual({ x: 1, y: 20, z: 30 });
        await colls.update({ id: 1 }, { mp: RemoveKeys(['x']) });
        expect((await coll(1)).mp).toEqual({ y: 20, z: 30 });
    });

    it('treats an empty collection operand as a no-op', async () => {
        await seed(2);
        await colls.update({ id: 2 }, { lst: Append([]), st: Remove([]), mp: PutKeys({}) });
        await colls.update({ id: 2 }, { lst: Prepend([]), mp: RemoveKeys([]) });
        const row = await coll(2);
        expect(row.lst).toEqual([1, 2, 3]);
        expect([...row.st].sort()).toEqual(['a', 'b']);
        expect(row.mp).toEqual({ x: 1, y: 2 });
    });

    it('applies collection updates through updateIfExists()', async () => {
        await seed(3);
        expect(await colls.updateIfExists({ id: 3 }, { lst: Append([9]), mp: PutKeys({ w: 7 }) })).toBe(true);
        const row = await coll(3);
        expect(row.lst).toEqual([1, 2, 3, 9]);
        expect(row.mp).toEqual({ x: 1, y: 2, w: 7 });

        expect(await colls.updateIfExists({ id: 999 }, { lst: Append([1]) })).toBe(false);
        expect(await colls.findOneBy({ id: 999 })).toBeNull();
    });

    it('applies collection updates in a batch via updateStatement()', async () => {
        await seed(4);
        await seed(5);
        await ds.executeBatch([
            colls.updateStatement({ id: 4 }, { lst: Prepend([-1]), st: Append(['z']) }),
            colls.updateStatement({ id: 5 }, { mp: RemoveKeys(['x']), st: Remove(['b']) }),
        ]);
        const a = await coll(4);
        expect(a.lst).toEqual([-1, 1, 2, 3]);
        expect([...a.st].sort()).toEqual(['a', 'b', 'z']);
        const b = await coll(5);
        expect(b.mp).toEqual({ y: 2 });
        expect([...b.st]).toEqual(['a']);
    });

    it('rejects an invalid collection update locally, before any query', async () => {
        await seed(6);
        await expect(colls.update({ id: 6 }, { st: Prepend(['q']) })).rejects.toBeInstanceOf(InvalidQueryError);
        await expect(colls.update({ id: 6 }, { lst: PutKeys({ a: 1 }) })).rejects.toBeInstanceOf(InvalidQueryError);
        const row = await coll(6);
        expect([...row.st].sort()).toEqual(['a', 'b']);
        expect(row.lst).toEqual([1, 2, 3]);
    });
});
