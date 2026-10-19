import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
    BaseModel,
    Column,
    ColumnValidationError,
    Contains,
    DataSource,
    Entity,
    In,
    PrimaryKeyColumn,
    Repository,
    UserDefinedType,
} from '../src';

// Features of 0.9.0 that only a real server can vouch for: user-defined types
// and synchronize() with alter.

const KS = 'scyllorm_v090_schema';
const warnings: string[] = [];
const logger = { info: () => undefined, warn: (message: string) => warnings.push(message), error: () => undefined };

const geo: UserDefinedType = { name: 'geo', fields: { lat: 'DOUBLE', lon: 'DOUBLE' } };
const address: UserDefinedType = {
    name: 'address',
    fields: { street: 'TEXT', city: 'TEXT', geo: { type: 'UDT', udt: geo } },
};
const plainPoint: UserDefinedType = { name: 'point', fields: { x: 'INT', y: 'INT' } };

@Entity(`${KS}.places`)
class Place extends BaseModel {
    @PrimaryKeyColumn('INT', { partitionKey: true })
    id: number;

    @Column('UDT', { udt: address })
    home: { street: string; city: string; geo: { lat: number; lon: number } };

    @Column('LIST', { of: 'UDT', udt: address })
    others: Array<{ street: string; city: string; geo: null }>;

    @Column('UDT', { udt: plainPoint, frozen: false })
    spot: { x: number; y: number };
}

// v1 and v2 describe the same table; v2 grew a column, a static column and a UDT field
const noteV1: UserDefinedType = { name: 'note_body', fields: { text: 'TEXT' } };
const noteV2: UserDefinedType = { name: 'note_body', fields: { text: 'TEXT', lang: 'TEXT' } };

@Entity(`${KS}.notes`)
class NoteV1 extends BaseModel {
    @PrimaryKeyColumn('INT', { partitionKey: true })
    pid: number;

    @PrimaryKeyColumn('INT', { clusteringKey: true })
    seq: number;

    @Column('UDT', { udt: noteV1 })
    body: { text: string };

    @Column('INT')
    changed: number;
}

@Entity(`${KS}.notes`)
class NoteV2 extends BaseModel {
    @PrimaryKeyColumn('INT', { partitionKey: true })
    pid: number;

    @PrimaryKeyColumn('INT', { clusteringKey: true })
    seq: number;

    @Column('UDT', { udt: noteV2 })
    body: { text: string; lang?: string };

    // Declared as TEXT now, while the table has INT: only warned about
    @Column('TEXT')
    changed: string;

    @Column('TEXT')
    extra: string;

    @Column('TEXT', { static: true })
    owner: string;
}

describe('0.9.0 schema (e2e)', () => {
    let ds: DataSource;
    let places: Repository<Place>;

    const alters = (spy: ReturnType<typeof vi.spyOn>): string[] =>
        spy.mock.calls.map((call) => call[0] as string).filter((query) => query.startsWith('ALTER'));

    beforeAll(async () => {
        ds = new DataSource({ contactPoints: ['127.0.0.1'], localDataCenter: 'datacenter1', logger });
        await ds.initialize();
        await ds.executeQuery(
            `CREATE KEYSPACE IF NOT EXISTS ${KS} ` +
                "WITH replication = { 'class': 'SimpleStrategy', 'replication_factor': 1 } " +
                "AND tablets = { 'enabled': false }",
            [],
            { prepare: false }
        );
        await ds.synchronize([Place]);
        places = ds.getRepository(Place);
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

    describe('UDT columns', () => {
        it('round-trips nested, list-of-frozen and non-frozen UDT values', async () => {
            const place = new Place();
            place.id = 1;
            place.home = { street: 'Main', city: 'Porto', geo: { lat: 41.1, lon: -8.6 } };
            place.others = [{ street: 'Side', city: 'Lisbon', geo: null }];
            place.spot = { x: 3, y: 4 };
            await places.save(place);

            const found = await places.findOneBy({ id: 1 });

            expect(found?.home).toEqual({ street: 'Main', city: 'Porto', geo: { lat: 41.1, lon: -8.6 } });
            expect(found?.others).toEqual([{ street: 'Side', city: 'Lisbon', geo: null }]);
            expect(found?.spot).toEqual({ x: 3, y: 4 });
        });

        it('filters by a UDT value, IN of UDTs and Contains() on a list of UDTs', async () => {
            const home = { street: 'Main', city: 'Porto', geo: { lat: 41.1, lon: -8.6 } };
            const other = { street: 'Side', city: 'Lisbon', geo: null };

            expect((await places.findBy({ home }, true)).map((p) => p.id)).toEqual([1]);
            expect(await places.countBy({ home: In([home, { ...home, city: 'Braga' }]) }, true)).toBe(1);
            expect((await places.findBy({ others: Contains(other) }, true)).map((p) => p.id)).toEqual([1]);
            expect(await places.findBy({ home: { ...home, city: 'Braga' } }, true)).toEqual([]);
        });

        it('rejects a written object with an unknown field locally', async () => {
            const place = new Place();
            place.id = 2;
            place.spot = { x: 1, z: 2 } as never;

            await expect(places.save(place)).rejects.toThrow(ColumnValidationError);
            expect(await places.findOneBy({ id: 2 })).toBeNull();
        });

        it('is idempotent to synchronize twice', async () => {
            await expect(ds.synchronize([Place])).resolves.toBeUndefined();
        });
    });

    describe('synchronize with alter', () => {
        it('adds a column, a static column and a UDT field, and the data round-trips', async () => {
            await ds.synchronize([NoteV1]);
            const v1 = ds.getRepository(NoteV1);
            const note = new NoteV1();
            note.pid = 1;
            note.seq = 1;
            note.body = { text: 'hello' };
            note.changed = 7;
            await v1.save(note);

            warnings.length = 0;
            await ds.synchronize([NoteV2], { alter: true });

            const v2 = ds.getRepository(NoteV2);
            const old = await v2.findOneBy({ pid: 1, seq: 1 });

            expect(old?.body).toMatchObject({ text: 'hello' });
            expect(old?.extra).toBeNull();

            const fresh = new NoteV2();
            fresh.pid = 1;
            fresh.seq = 2;
            fresh.body = { text: 'ola', lang: 'pt' };
            fresh.extra = 'x';
            fresh.owner = 'me';
            await v2.save(fresh);

            const found = await v2.findOneBy({ pid: 1, seq: 2 });

            expect(found?.body).toEqual({ text: 'ola', lang: 'pt' });
            expect(found?.extra).toBe('x');
            expect(found?.owner).toBe('me');
        });

        it('only warns about a changed column type', () => {
            expect(warnings.some((w) => /NoteV2.*changed.*int in the database but declared as text/.test(w))).toBe(
                true
            );
        });

        it('warns about an undeclared database column and keeps it', async () => {
            await ds.executeQuery(`ALTER TABLE ${KS}.notes ADD legacy text`, [], { prepare: false });
            warnings.length = 0;
            await ds.synchronize([NoteV2], { alter: true });

            expect(warnings.some((w) => /column legacy.*not declared/.test(w))).toBe(true);
        });

        it('issues no ALTER on a second run against an up-to-date schema', async () => {
            const spy = vi.spyOn(ds, 'executeQuery');
            await ds.synchronize([NoteV2], { alter: true });

            expect(alters(spy)).toEqual([]);
            spy.mockRestore();
        });
    });

    describe('alter on a table whose key layout differs', () => {
        @Entity(`${KS}.layout`)
        class Layout extends BaseModel {
            @PrimaryKeyColumn('INT', { partitionKey: true })
            b: number;

            @PrimaryKeyColumn('INT', { partitionKey: true })
            a: number;

            @PrimaryKeyColumn('INT', { clusteringKey: true })
            c: number;

            @Column('TEXT')
            v: string;
        }

        it('warns about key position and clustering order it cannot alter', async () => {
            await ds.executeQuery(
                `CREATE TABLE ${KS}.layout (a int, b int, c int, v text, PRIMARY KEY ((a, b), c)) ` +
                    'WITH CLUSTERING ORDER BY (c DESC)',
                [],
                { prepare: false }
            );
            warnings.length = 0;
            await ds.synchronize([Layout], { alter: true });

            expect(warnings.filter((w) => /key column/.test(w))).toEqual([
                `Entity Layout: key column b of table ${KS}.layout is at position 1 in the database but declared at position 0; keys cannot be altered.`,
                `Entity Layout: key column a of table ${KS}.layout is at position 0 in the database but declared at position 1; keys cannot be altered.`,
                `Entity Layout: key column c of table ${KS}.layout is ordered DESC in the database but declared ASC; keys cannot be altered.`,
            ]);
        });
    });

    describe('alter on a connection keyspace with capitals', () => {
        const MIXED = 'ScyllormV090Mixed';
        const pin1: UserDefinedType = { name: 'pin', fields: { x: 'INT' } };
        const pin2: UserDefinedType = { name: 'pin', fields: { x: 'INT', y: 'INT' } };

        @Entity('items')
        class ItemV1 extends BaseModel {
            @PrimaryKeyColumn('INT', { partitionKey: true })
            id: number;

            @Column('UDT', { udt: pin1 })
            p: { x: number };
        }

        @Entity('items')
        class ItemV2 extends BaseModel {
            @PrimaryKeyColumn('INT', { partitionKey: true })
            id: number;

            @Column('UDT', { udt: pin2 })
            p: { x: number; y: number };

            @Column('TEXT')
            added: string;
        }

        let mixed: DataSource;

        beforeAll(async () => {
            await ds.executeQuery(
                `CREATE KEYSPACE IF NOT EXISTS "${MIXED}" ` +
                    "WITH replication = { 'class': 'SimpleStrategy', 'replication_factor': 1 } " +
                    "AND tablets = { 'enabled': false }",
                [],
                { prepare: false }
            );
            mixed = new DataSource({
                contactPoints: ['127.0.0.1'],
                localDataCenter: 'datacenter1',
                keyspace: MIXED,
                logger,
            });
            await mixed.initialize();
        });

        afterAll(async () => {
            try {
                await mixed?.shutdown();
            } finally {
                await ds.executeQuery(`DROP KEYSPACE IF EXISTS "${MIXED}"`, [], { prepare: false });
            }
        });

        it('reads the quoted keyspace back and adds the missing field and column', async () => {
            await mixed.synchronize([ItemV1]);
            warnings.length = 0;

            const spy = vi.spyOn(mixed, 'executeQuery');
            await mixed.synchronize([ItemV2], { alter: true });

            expect(alters(spy)).toEqual(['ALTER TYPE pin ADD y int', 'ALTER TABLE items ADD added text']);
            expect(warnings).toEqual([]);
            spy.mockRestore();

            const items = mixed.getRepository(ItemV2);
            const item = new ItemV2();
            item.id = 1;
            item.p = { x: 1, y: 2 };
            item.added = 'yes';
            await items.save(item);

            expect(await items.findOneBy({ id: 1 })).toMatchObject({ p: { x: 1, y: 2 }, added: 'yes' });
        });
    });
});
