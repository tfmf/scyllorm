import { describe, it, expect, vi } from 'vitest';
import { DataSource } from '../../data-source/DataSource';
import { Repository } from '../Repository';
import { BaseModel } from '../../model/BaseModel';
import { Entity } from '../../decorators/Entity';
import { Column } from '../../decorators/Column';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';
import { Index } from '../../decorators/IndexDecorator';
import { Append, Between, Contains, GreaterThan, In } from '../query-utils';
import { ColumnValidationError, EntityNotFoundError, InvalidQueryError, UnknownColumnError } from '../../errors';

// Mock cassandra-driver
vi.mock('cassandra-driver', async (importOriginal) => {
    class MockClient {
        connect = vi.fn().mockResolvedValue(undefined);
        shutdown = vi.fn().mockResolvedValue(undefined);
        execute = vi.fn().mockResolvedValue({ rows: [] });
    }
    // Partial mock: the real value types (`types.Long`, `types.Uuid`, …) stay available
    return {
        ...(await importOriginal<typeof import('cassandra-driver')>()),
        Client: MockClient,
        errors: {
            NoHostAvailableError: class extends Error {},
            DriverInternalError: class extends Error {},
        },
    };
});

const hooks = {
    beforeUpdate: vi.fn(),
    afterUpdate: vi.fn(),
    beforeDelete: vi.fn(),
    afterDelete: vi.fn(),
    afterLoad: vi.fn(),
};

@Entity('cn_people')
class Person extends BaseModel {
    @PrimaryKeyColumn('UUID', { partitionKey: true, name: 'person_id' })
    personId: string;

    @Column('TEXT', { name: 'first_name' })
    firstName: string;

    @Column('TEXT')
    city: string;

    @Column('INT', { name: 'age_years' })
    age: number;

    @Column('LIST', { of: 'TEXT', name: 'nick_names' })
    nickNames: string[];

    @Column('TIMESTAMP', { name: 'created_at' })
    createdAt: Date;

    static beforeUpdate = hooks.beforeUpdate;
    static afterUpdate = hooks.afterUpdate;
    static beforeDelete = hooks.beforeDelete;
    static afterDelete = hooks.afterDelete;

    async afterLoad(): Promise<void> {
        hooks.afterLoad(this.personId, this.firstName);
    }
}

@Entity('cn_hits')
class Hit extends BaseModel {
    @PrimaryKeyColumn('TEXT', { partitionKey: true, name: 'page_id' })
    pageId: string;

    @Column('COUNTER', { name: 'hit_count' })
    hitCount: number;

    @Column('COUNTER')
    plain: number;
}

// Camel-cased database names, which the driver hands back lowercased
@Entity('cn_camel')
class Camel extends BaseModel {
    @PrimaryKeyColumn('TEXT', { partitionKey: true })
    id: string;

    @Column('TEXT', { name: 'FirstName' })
    first: string;
}

// An entity that never uses `name`, for the byte-identical regression
@Entity('cn_plain')
@Index('cn_plain_by_label', 'label')
class Plain extends BaseModel {
    @PrimaryKeyColumn('UUID', { partitionKey: true })
    id: string;

    @Column('TEXT')
    label: string;

    @Column('INT')
    score: number;

    @Column('TIMESTAMP')
    createdAt: Date;

    @Column('COUNTER')
    visits: number;
}

@Entity('cn_base_thing')
class BaseThing extends BaseModel {
    @PrimaryKeyColumn('TEXT', { partitionKey: true, name: 'thing_id' })
    id: string;

    @Column('TEXT', { name: 'label_text' })
    label: string;
}

@Entity('cn_child_thing')
class ChildThing extends BaseThing {
    @Column('TEXT', { name: 'title_text' })
    label: string;

    @Column('TEXT', { name: 'extra_col' })
    extra: string;
}

@Entity('cn_child_plain_thing')
class ChildPlainThing extends BaseThing {
    @Column('TEXT')
    label: string;
}

let tableCounter = 0;

/**
 * Builds an entity from `[property, type, options]` triples, with a fresh table name.
 * Applies the decorators by hand so that malformed declarations need no class each.
 */
function entityOf(columns: Array<[string, 'TEXT' | 'INT', Record<string, unknown> | undefined]>): typeof BaseModel {
    class Dynamic extends BaseModel {}

    PrimaryKeyColumn('UUID', { partitionKey: true })(Dynamic.prototype, 'id');

    for (const [property, type, options] of columns) {
        Column(type, options)(Dynamic.prototype, property);
    }

    Entity(`cn_dynamic_${++tableCounter}`)(Dynamic);

    return Dynamic;
}

function setup<T extends typeof BaseModel & (new () => InstanceType<T>)>(entityClass: T, response: unknown[] = []) {
    const ds = new DataSource({ contactPoints: ['x'], localDataCenter: 'dc1' } as never);
    const executed: Array<{ query: string; params: unknown[]; options: unknown }> = [];

    vi.spyOn(ds, 'executeQuery').mockImplementation(async (query: string, params: unknown[], options: unknown) => {
        executed.push({ query, params, options });
        return response as never;
    });

    const executeQueryPage = vi.fn().mockResolvedValue({ rows: response, pageState: undefined });
    const streamQuery = vi.fn(async function* () {
        for (const row of response) {
            yield row;
        }
    });
    Object.assign(ds, { executeQueryPage, streamQuery });

    const repo = ds.getRepository(entityClass) as Repository<InstanceType<T>>;

    return { repo, executed, executeQueryPage, streamQuery };
}

const PERSON_ROW = {
    person_id: '11111111-1111-4111-8111-111111111111',
    first_name: 'Ann',
    city: 'Lisbon',
    age_years: 30,
    nick_names: ['a'],
    created_at: new Date(0),
};

describe('column name: writes', () => {
    it('save() emits the database names in the column list, in declaration order, binding by property', async () => {
        const { repo, executed } = setup(Person);
        const person = repo.create({
            personId: '11111111-1111-4111-8111-111111111111',
            firstName: 'Ann',
            city: 'Lisbon',
            age: 30,
            nickNames: ['a'],
            createdAt: new Date(0),
        });

        await repo.save(person);

        expect(executed[0].query).toEqual(
            'INSERT INTO cn_people (person_id, first_name, city, age_years, nick_names, created_at) ' +
                'VALUES (?, ?, ?, ?, ?, ?)'
        );
        expect(executed[0].params).toEqual([
            '11111111-1111-4111-8111-111111111111',
            'Ann',
            'Lisbon',
            30,
            ['a'],
            new Date(0),
        ]);
    });

    it('save() with ttl keeps USING at the end', async () => {
        const { repo, executed } = setup(Person);
        const person = repo.create({
            personId: '11111111-1111-4111-8111-111111111111',
            firstName: 'Ann',
            city: 'Lisbon',
            age: 30,
            nickNames: [],
            createdAt: new Date(0),
        });

        await repo.save(person, { ttl: 60 });

        expect(executed[0].query).toEqual(
            'INSERT INTO cn_people (person_id, first_name, city, age_years, nick_names, created_at) ' +
                'VALUES (?, ?, ?, ?, ?, ?) USING TTL ?'
        );
    });

    it('validation errors on a renamed column name the property, not the database name', async () => {
        const { repo } = setup(Person);
        const person = repo.create({
            personId: '11111111-1111-4111-8111-111111111111',
            firstName: 5 as never,
            city: 'x',
            age: 1,
        });

        const error = await repo.save(person).catch((e) => e);

        expect(error).toBeInstanceOf(ColumnValidationError);
        expect(error.message).toContain('firstName');
        expect(error.message).not.toContain('first_name');
    });

    it('insertIfNotExists() emits database names and IF NOT EXISTS', async () => {
        const { repo, executed } = setup(Person, [{ '[applied]': true }]);
        const person = repo.create({
            personId: '11111111-1111-4111-8111-111111111111',
            firstName: 'Ann',
            city: 'Lisbon',
            age: 30,
            nickNames: [],
            createdAt: new Date(0),
        });

        await expect(repo.insertIfNotExists(person)).resolves.toBe(true);

        expect(executed[0].query).toEqual(
            'INSERT INTO cn_people (person_id, first_name, city, age_years, nick_names, created_at) ' +
                'VALUES (?, ?, ?, ?, ?, ?) IF NOT EXISTS'
        );
    });

    it('saveStatement() emits database names', () => {
        const { repo } = setup(Person);
        const person = repo.create({
            personId: '11111111-1111-4111-8111-111111111111',
            firstName: 'Ann',
            city: 'Lisbon',
            age: 30,
            nickNames: ['n'],
            createdAt: new Date(0),
        });

        expect(repo.saveStatement(person, { ttl: 5 })).toEqual({
            query:
                'INSERT INTO cn_people (person_id, first_name, city, age_years, nick_names, created_at) ' +
                'VALUES (?, ?, ?, ?, ?, ?) USING TTL ?',
            params: ['11111111-1111-4111-8111-111111111111', 'Ann', 'Lisbon', 30, ['n'], new Date(0), 5],
        });
    });

    it('update() renames SET columns and condition columns', async () => {
        const { repo, executed } = setup(Person);

        await repo.update({ personId: '11111111-1111-4111-8111-111111111111' }, { firstName: 'Bob', age: 31 });

        expect(executed[0].query).toEqual('UPDATE cn_people SET first_name = ?, age_years = ? WHERE person_id = ?');
        expect(executed[0].params).toEqual(['Bob', 31, '11111111-1111-4111-8111-111111111111']);
    });

    it('update() with ttl and a renamed condition other than the key', async () => {
        const { repo, executed } = setup(Person);

        await repo.update(
            { personId: '11111111-1111-4111-8111-111111111111', firstName: 'Ann' },
            { city: 'Porto' },
            { ttl: 10 }
        );

        expect(executed[0].query).toEqual(
            'UPDATE cn_people USING TTL ? SET city = ? WHERE person_id = ? AND first_name = ?'
        );
        expect(executed[0].params).toEqual([10, 'Porto', '11111111-1111-4111-8111-111111111111', 'Ann']);
    });

    it('update() binds null as a tombstone on a renamed column', async () => {
        const { repo, executed } = setup(Person);

        await repo.update({ personId: '11111111-1111-4111-8111-111111111111' }, { firstName: null as never });

        expect(executed[0].query).toEqual('UPDATE cn_people SET first_name = ? WHERE person_id = ?');
        expect(executed[0].params).toEqual([null, '11111111-1111-4111-8111-111111111111']);
    });

    it('updateIfExists() renames and appends IF EXISTS', async () => {
        const { repo, executed } = setup(Person, [{ '[applied]': true }]);

        await expect(
            repo.updateIfExists({ personId: '11111111-1111-4111-8111-111111111111' }, { age: 2 })
        ).resolves.toBe(true);

        expect(executed[0].query).toEqual('UPDATE cn_people SET age_years = ? WHERE person_id = ? IF EXISTS');
    });

    it('updateStatement() renames, and a collection update renders under the database name', () => {
        const { repo } = setup(Person);

        expect(
            repo.updateStatement({ personId: '11111111-1111-4111-8111-111111111111' }, { firstName: 'Bob' })
        ).toEqual({
            query: 'UPDATE cn_people SET first_name = ? WHERE person_id = ?',
            params: ['Bob', '11111111-1111-4111-8111-111111111111'],
        });
        expect(
            repo.updateStatement({ personId: '11111111-1111-4111-8111-111111111111' }, { nickNames: Append(['x']) })
        ).toEqual({
            query: 'UPDATE cn_people SET nick_names = nick_names + ? WHERE person_id = ?',
            params: [['x'], '11111111-1111-4111-8111-111111111111'],
            isIdempotent: false,
        });
    });

    it('update() rejects assigning a renamed primary key by its property name', async () => {
        const { repo } = setup(Person);

        const error = await repo
            .update(
                { personId: '11111111-1111-4111-8111-111111111111' },
                { personId: '22222222-2222-4222-8222-222222222222' }
            )
            .catch((e) => e);

        expect(error).toBeInstanceOf(InvalidQueryError);
        expect(error.message).toContain('personId');
    });

    it('update() rejects assigning a renamed COUNTER by its property name', async () => {
        const { repo } = setup(Hit);

        const error = await repo.update({ pageId: 'p' }, { hitCount: 3 }).catch((e) => e);

        expect(error).toBeInstanceOf(InvalidQueryError);
        expect(error.message).toContain('hitCount');
    });

    it('delete() renames condition columns', async () => {
        const { repo, executed } = setup(Person);

        await repo.delete({ personId: '11111111-1111-4111-8111-111111111111', firstName: 'Ann' });

        expect(executed[0].query).toEqual('DELETE FROM cn_people WHERE person_id = ? AND first_name = ?');
        expect(executed[0].params).toEqual(['11111111-1111-4111-8111-111111111111', 'Ann']);
    });

    it('deleteIfExists() renames and appends IF EXISTS', async () => {
        const { repo, executed } = setup(Person, [{ '[applied]': true }]);

        await expect(repo.deleteIfExists({ personId: '11111111-1111-4111-8111-111111111111' })).resolves.toBe(true);

        expect(executed[0].query).toEqual('DELETE FROM cn_people WHERE person_id = ? IF EXISTS');
    });

    it('deleteStatement() renames, with a timestamp', () => {
        const { repo } = setup(Person);

        expect(repo.deleteStatement({ personId: '11111111-1111-4111-8111-111111111111' }, { timestamp: 7 })).toEqual({
            query: 'DELETE FROM cn_people USING TIMESTAMP ? WHERE person_id = ?',
            params: [expect.anything(), '11111111-1111-4111-8111-111111111111'],
        });
    });
});

describe('column name: COUNTER', () => {
    it('increment() and decrement() emit the database name of the counter and the key', async () => {
        const { repo, executed } = setup(Hit);

        await repo.increment({ pageId: 'home' }, 'hitCount', 3);
        await repo.decrement({ pageId: 'home' }, 'hitCount');

        expect(executed[0].query).toEqual('UPDATE cn_hits SET hit_count = hit_count + ? WHERE page_id = ?');
        expect(executed[0].params).toEqual([3, 'home']);
        expect(executed[1].query).toEqual('UPDATE cn_hits SET hit_count = hit_count - ? WHERE page_id = ?');
        expect(executed[1].params).toEqual([1, 'home']);
        expect(executed[0].options).toMatchObject({ isIdempotent: false });
    });

    it('incrementStatement() and decrementStatement() are marked counter and renamed', () => {
        const { repo } = setup(Hit);

        expect(repo.incrementStatement({ pageId: 'home' }, 'hitCount', 2)).toEqual({
            query: 'UPDATE cn_hits SET hit_count = hit_count + ? WHERE page_id = ?',
            params: [2, 'home'],
            counter: true,
        });
        expect(repo.decrementStatement({ pageId: 'home' }, 'hitCount', 2)).toEqual({
            query: 'UPDATE cn_hits SET hit_count = hit_count - ? WHERE page_id = ?',
            params: [2, 'home'],
            counter: true,
        });
    });

    it('an unrenamed counter on the same entity is unchanged', () => {
        const { repo } = setup(Hit);

        expect(repo.incrementStatement({ pageId: 'home' }, 'plain').query).toEqual(
            'UPDATE cn_hits SET plain = plain + ? WHERE page_id = ?'
        );
    });

    it('increment() by the database name is an UnknownColumnError', async () => {
        const { repo, executed } = setup(Hit);

        await expect(repo.increment({ pageId: 'home' }, 'hit_count' as never)).rejects.toBeInstanceOf(
            UnknownColumnError
        );
        expect(executed).toHaveLength(0);
    });

    it('increment() on a renamed non-counter column still says it is not a counter, by property name', async () => {
        const { repo } = setup(Person);

        const error = await repo.increment({ personId: '11111111-1111-4111-8111-111111111111' }, 'age').catch((e) => e);

        expect(error).toBeInstanceOf(InvalidQueryError);
        expect(error.message).toContain('age');
    });
});

describe('column name: reads', () => {
    it('find() with no options still selects *', async () => {
        const { repo, executed } = setup(Person);

        await repo.find();

        expect(executed[0].query).toEqual('SELECT * FROM cn_people');
    });

    it('select projects database names, in the order given', async () => {
        const { repo, executed } = setup(Person);

        await repo.find({ select: ['age', 'personId', 'city', 'firstName'] });

        expect(executed[0].query).toEqual('SELECT age_years, person_id, city, first_name FROM cn_people');
    });

    it('where renders database names across every operator', async () => {
        const { repo, executed } = setup(Person);

        await repo.find({
            where: {
                firstName: 'Ann',
                age: GreaterThan(18),
                city: In(['A', 'B']),
                createdAt: Between(new Date(0), new Date(1)),
                nickNames: Contains('x'),
            },
        });

        expect(executed[0].query).toEqual(
            'SELECT * FROM cn_people WHERE first_name = ? AND age_years > ? AND city IN (?, ?) ' +
                'AND created_at >= ? AND created_at <= ? AND nick_names CONTAINS ?'
        );
        expect(executed[0].params).toEqual(['Ann', 18, 'A', 'B', new Date(0), new Date(1), 'x']);
    });

    it('orderBy renders database names, combined with select, where and limit', async () => {
        const { repo, executed } = setup(Person);

        await repo.find({
            select: ['firstName'],
            where: { personId: '11111111-1111-4111-8111-111111111111' },
            orderBy: { createdAt: 'DESC', age: 'ASC' },
            limit: 5,
        });

        expect(executed[0].query).toEqual(
            'SELECT first_name FROM cn_people WHERE person_id = ? ORDER BY created_at DESC, age_years ASC LIMIT ?'
        );
        expect(executed[0].params).toEqual(['11111111-1111-4111-8111-111111111111', 5]);
    });

    it('findPaged() and stream() render database names too', async () => {
        const { repo, executeQueryPage, streamQuery } = setup(Person, [PERSON_ROW]);

        const page = await repo.findPaged({ select: ['firstName'], where: { age: 3 } });
        const streamed: Person[] = [];

        for await (const person of repo.stream({ orderBy: { age: 'DESC' } })) {
            streamed.push(person);
        }

        expect(executeQueryPage.mock.calls[0][0]).toEqual('SELECT first_name FROM cn_people WHERE age_years = ?');
        expect(streamQuery.mock.calls[0][0]).toEqual('SELECT * FROM cn_people ORDER BY age_years DESC');
        expect(page.rows[0].firstName).toBe('Ann');
        expect(streamed[0].firstName).toBe('Ann');
    });

    it('findBy() renders database names', async () => {
        const { repo, executed } = setup(Person);

        await repo.findBy({ firstName: 'Ann', age: GreaterThan(1) }, true);

        expect(executed[0].query).toEqual(
            'SELECT * FROM cn_people WHERE first_name = ? AND age_years > ? ALLOW FILTERING'
        );
    });

    it('findOneBy() and findOneOrFail() render database names', async () => {
        const { repo, executed } = setup(Person, [PERSON_ROW]);

        await repo.findOneBy({ firstName: 'Ann' });
        await repo.findOneOrFail({ personId: '11111111-1111-4111-8111-111111111111' });

        expect(executed[0].query).toEqual('SELECT * FROM cn_people WHERE first_name = ? LIMIT 1');
        expect(executed[1].query).toEqual('SELECT * FROM cn_people WHERE person_id = ? LIMIT 1');
    });

    it('findOneOrFail() reports the property names it searched by', async () => {
        const { repo } = setup(Person, []);

        const error = await repo.findOneOrFail({ firstName: 'Zed' }).catch((e) => e);

        expect(error).toBeInstanceOf(EntityNotFoundError);
        expect(error.criteriaColumns).toEqual(['firstName']);
    });

    it('count(), countBy() and existsBy() render database names', async () => {
        const { repo, executed } = setup(Person, [{ count: 4 }]);

        await expect(repo.count({ firstName: 'Ann' })).resolves.toBe(4);
        await expect(repo.countBy({ age: GreaterThan(1) }, true)).resolves.toBe(4);
        await expect(repo.existsBy({ createdAt: GreaterThan(new Date(0)) })).resolves.toBe(true);

        expect(executed[0].query).toEqual('SELECT COUNT(*) FROM cn_people WHERE first_name = ?');
        expect(executed[1].query).toEqual('SELECT COUNT(*) FROM cn_people WHERE age_years > ? ALLOW FILTERING');
        expect(executed[2].query).toEqual('SELECT * FROM cn_people WHERE created_at > ? LIMIT 1');
    });
});

describe('column name: row mapping', () => {
    it('reads each row by the database name into the property', async () => {
        const { repo } = setup(Person, [PERSON_ROW]);

        const [person] = await repo.find();

        expect(person).toBeInstanceOf(Person);
        expect(person.personId).toBe('11111111-1111-4111-8111-111111111111');
        expect(person.firstName).toBe('Ann');
        expect(person.city).toBe('Lisbon');
        expect(person.age).toBe(30);
        expect(person.nickNames).toEqual(['a']);
        expect(person.createdAt).toEqual(new Date(0));
        expect(person).not.toHaveProperty('first_name');
        expect(person).not.toHaveProperty('age_years');
    });

    it('does not read the property name of a renamed column from the row', async () => {
        const { repo } = setup(Person, [
            { person_id: '11111111-1111-4111-8111-111111111111', firstName: 'wrong-key', city: 'x' },
        ]);

        const [person] = await repo.find();

        expect(person.personId).toBe('11111111-1111-4111-8111-111111111111');
        expect(person.firstName).toBeUndefined();
    });

    it('maps a projected row, leaving unselected properties undefined', async () => {
        const { repo } = setup(Person, [{ first_name: 'Ann' }]);

        const [person] = await repo.find({ select: ['firstName'] });

        expect(person.firstName).toBe('Ann');
        expect(person.age).toBeUndefined();
    });

    it('falls back to the lowercased database name, as the driver folds unquoted identifiers', async () => {
        const { repo } = setup(Camel, [{ id: 'a', firstname: 'lower' }]);

        const [row] = await repo.find();

        expect(row.first).toBe('lower');
    });

    it('prefers the exact database name over its lowercased form', async () => {
        const { repo } = setup(Camel, [{ id: 'a', FirstName: 'exact', firstname: 'lower' }]);

        const [row] = await repo.find();

        expect(row.first).toBe('exact');
    });

    it('findOneBy() and findOne() map renamed columns', async () => {
        const { repo } = setup(Person, [PERSON_ROW]);

        expect((await repo.findOneBy({ personId: '11111111-1111-4111-8111-111111111111' }))?.firstName).toBe('Ann');
        expect((await repo.findOne())?.firstName).toBe('Ann');
    });

    it('maps raw query rows by the database name, and leaves raw: true rows untouched', async () => {
        const { repo } = setup(Person, [PERSON_ROW]);

        const [mapped] = await repo.runRawQuery('SELECT * FROM cn_people WHERE person_id = :id', {
            id: '11111111-1111-4111-8111-111111111111',
        });
        const [raw] = await repo.runRawQuery<Record<string, unknown>>(
            'SELECT * FROM cn_people WHERE person_id = :id',
            { id: '11111111-1111-4111-8111-111111111111' },
            { raw: true }
        );

        expect(mapped).toBeInstanceOf(Person);
        expect(mapped.firstName).toBe('Ann');
        expect(raw).toEqual(PERSON_ROW);
    });

    it('maps paged and streamed raw query rows', async () => {
        const { repo } = setup(Person, [PERSON_ROW]);

        const page = await repo.runRawQueryPaged('SELECT * FROM cn_people', {});
        const streamed: Person[] = [];

        for await (const person of repo.streamRawQuery('SELECT * FROM cn_people', {})) {
            streamed.push(person);
        }

        expect(page.rows[0].firstName).toBe('Ann');
        expect(streamed[0].firstName).toBe('Ann');
    });

    it('runs afterLoad on the mapped entity with the properties already assigned', async () => {
        hooks.afterLoad.mockClear();
        const { repo } = setup(Person, [PERSON_ROW]);

        await repo.find();

        expect(hooks.afterLoad).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', 'Ann');
    });
});

describe('column name: property-facing API', () => {
    it('getColumnNames() returns property names in declaration order', () => {
        const { repo } = setup(Person);

        expect(repo.getColumnNames()).toEqual(['personId', 'firstName', 'city', 'age', 'nickNames', 'createdAt']);
    });

    it('create() takes property names and ignores database names', () => {
        const { repo } = setup(Person);

        const person = repo.create({
            personId: '11111111-1111-4111-8111-111111111111',
            firstName: 'Ann',
            first_name: 'ignored',
            age_years: 1,
        } as never);

        expect(person.personId).toBe('11111111-1111-4111-8111-111111111111');
        expect(person.firstName).toBe('Ann');
        expect(person).not.toHaveProperty('first_name');
        expect(person).not.toHaveProperty('age_years');
    });

    it('update() hooks receive the conditions and values as the caller keyed them', async () => {
        hooks.beforeUpdate.mockClear();
        hooks.afterUpdate.mockClear();
        const { repo } = setup(Person);

        await repo.update({ personId: '11111111-1111-4111-8111-111111111111' }, { firstName: 'Bob' });

        expect(hooks.beforeUpdate).toHaveBeenCalledWith(
            { personId: '11111111-1111-4111-8111-111111111111' },
            { firstName: 'Bob' }
        );
        expect(hooks.afterUpdate).toHaveBeenCalledWith(
            { personId: '11111111-1111-4111-8111-111111111111' },
            { firstName: 'Bob' }
        );
    });

    it('delete() hooks receive the conditions as the caller keyed them', async () => {
        hooks.beforeDelete.mockClear();
        hooks.afterDelete.mockClear();
        const { repo } = setup(Person);

        await repo.delete({ personId: '11111111-1111-4111-8111-111111111111', firstName: 'Ann' });

        expect(hooks.beforeDelete).toHaveBeenCalledWith({
            personId: '11111111-1111-4111-8111-111111111111',
            firstName: 'Ann',
        });
        expect(hooks.afterDelete).toHaveBeenCalledWith({
            personId: '11111111-1111-4111-8111-111111111111',
            firstName: 'Ann',
        });
    });

    describe('passing the database name instead of the property name', () => {
        const attempts: Array<[string, (repo: Repository<Person>) => Promise<unknown>]> = [
            ['where', (repo) => repo.find({ where: { first_name: 'Ann' } })],
            ['select', (repo) => repo.find({ select: ['first_name'] as never })],
            ['orderBy', (repo) => repo.find({ orderBy: { created_at: 'ASC' } })],
            ['findBy', (repo) => repo.findBy({ age_years: 3 })],
            ['findOneBy', (repo) => repo.findOneBy({ first_name: 'Ann' } as never)],
            ['findOneOrFail', (repo) => repo.findOneOrFail({ first_name: 'Ann' } as never)],
            ['countBy', (repo) => repo.countBy({ age_years: 3 })],
            ['existsBy', (repo) => repo.existsBy({ age_years: 3 })],
            ['delete', (repo) => repo.delete({ person_id: '11111111-1111-4111-8111-111111111111' } as never)],
            [
                'update condition',
                (repo) => repo.update({ person_id: '11111111-1111-4111-8111-111111111111' } as never, { age: 1 }),
            ],
            [
                'update value',
                (repo) =>
                    repo.update({ personId: '11111111-1111-4111-8111-111111111111' }, { first_name: 'x' } as never),
            ],
            [
                'updateStatement',
                (repo) =>
                    Promise.resolve().then(() =>
                        repo.updateStatement({ personId: '11111111-1111-4111-8111-111111111111' }, {
                            age_years: 1,
                        } as never)
                    ),
            ],
        ];

        it.each(attempts)('%s throws UnknownColumnError listing property names', async (_label, attempt) => {
            const { repo, executed } = setup(Person);

            const error = await attempt(repo).catch((e) => e);

            expect(error).toBeInstanceOf(UnknownColumnError);
            expect(error.knownColumns).toEqual(repo.getColumnNames());
            expect(error.knownColumns).not.toContain('first_name');
            expect(executed).toHaveLength(0);
        });

        it('the message names the rejected database name', async () => {
            const { repo } = setup(Person);

            const error = await repo.find({ where: { first_name: 'Ann' } }).catch((e) => e);

            expect(error.message).toContain('Unknown column "first_name"');
            expect(error.message).toContain('firstName');
        });
    });
});

describe('column name: invalid name option', () => {
    it.each([
        ['a hyphen', 'first-name', '"first-name"'],
        ['an empty string', '', '""'],
        ['a leading digit', '1st', '"1st"'],
        ['a space', 'first name', '"first name"'],
        ['a quoted identifier', '"first"', '"\\"first\\""'],
        ['a dot', 'a.b', '"a.b"'],
        ['an injection attempt', 'x; DROP TABLE t', '"x; DROP TABLE t"'],
        ['a number, cast', 42 as never, '"42"'],
        ['an object, cast', {} as never, '"[object Object]"'],
    ])('rejects %s with invalidIdentifier on the first query', async (_label, name, echoed) => {
        const entity = entityOf([['value', 'TEXT', { name }]]);
        const { repo, executed } = setup(entity as never);

        const errors = await Promise.all([
            repo.find({ where: { id: 'x' } }).catch((e) => e),
            repo.save(new entity() as never).catch((e) => e),
        ]);

        for (const error of errors) {
            expect(error).toBeInstanceOf(InvalidQueryError);
            expect(error.message).toContain('Invalid column identifier');
            expect(error.message).toContain(echoed);
        }
        expect(executed).toHaveLength(0);
    });

    it('getColumnNames() and create() surface it too, on every call', () => {
        const entity = entityOf([['value', 'TEXT', { name: 'first-name' }]]);
        const { repo } = setup(entity as never);

        for (let attempt = 0; attempt < 2; attempt++) {
            expect(() => repo.getColumnNames()).toThrow(InvalidQueryError);
            expect(() => repo.create({})).toThrow(/Invalid column identifier "first-name"/);
        }
    });

    it('a PrimaryKeyColumn name is validated too', async () => {
        class Bad extends BaseModel {}
        PrimaryKeyColumn('UUID', { partitionKey: true, name: 'bad-key' })(Bad.prototype, 'id');
        Entity(`cn_dynamic_${++tableCounter}`)(Bad);
        const { repo } = setup(Bad as never);

        await expect(repo.find({ where: { id: 'x' } })).rejects.toThrow(/Invalid column identifier "bad-key"/);
    });

    it('accepts underscores, digits after the first letter and mixed case', () => {
        const entity = entityOf([
            ['a', 'TEXT', { name: 'col_1' }],
            ['b', 'TEXT', { name: 'Col2X' }],
        ]);
        const { repo } = setup(entity as never);

        expect(repo.getColumnNames()).toEqual(['id', 'a', 'b']);
    });

    it('an undefined name falls back to the property name', async () => {
        const entity = entityOf([['value', 'TEXT', { name: undefined }]]);
        const { repo, executed } = setup(entity as never);

        await repo.find({ select: ['value'] });

        expect(executed[0].query).toMatch(/^SELECT value FROM cn_dynamic_\d+$/);
    });
});

describe('column name: ambiguous columns', () => {
    it('rejects a renamed column that collides with another property name', async () => {
        const entity = entityOf([
            ['userName', 'TEXT', { name: 'user_name' }],
            ['user_name', 'TEXT', undefined],
        ]);
        const { repo } = setup(entity as never);

        const error = await repo.find({ where: { id: 'x' } }).catch((e) => e);

        expect(error).toBeInstanceOf(InvalidQueryError);
        expect(error.message).toContain('"userName"');
        expect(error.message).toContain('"user_name"');
        expect(error.message).toContain('same column to CQL');
    });

    it('rejects a case-only clash between a rename and a property name', () => {
        const entity = entityOf([
            ['mail', 'TEXT', { name: 'EMAIL' }],
            ['email', 'TEXT', undefined],
        ]);
        const { repo } = setup(entity as never);

        expect(() => repo.getColumnNames()).toThrow(InvalidQueryError);
        expect(() => repo.getColumnNames()).toThrow(/"mail".*"email"|"email".*"mail"/);
    });

    it('rejects two renames to the same name, and to names differing only by case', () => {
        const same = setup(
            entityOf([
                ['a', 'TEXT', { name: 'dup' }],
                ['b', 'TEXT', { name: 'dup' }],
            ]) as never
        ).repo;
        const folded = setup(
            entityOf([
                ['a', 'TEXT', { name: 'Dup' }],
                ['b', 'TEXT', { name: 'dUP' }],
            ]) as never
        ).repo;

        expect(() => same.getColumnNames()).toThrow(/same column to CQL/);
        expect(() => folded.getColumnNames()).toThrow(/same column to CQL/);
    });

    it('rejects a rename onto a primary key property name', () => {
        const entity = entityOf([['alias', 'TEXT', { name: 'id' }]]);
        const { repo } = setup(entity as never);

        expect(() => repo.getColumnNames()).toThrow(/same column to CQL/);
    });

    it('rejects on every offending query, not only the first', async () => {
        const entity = entityOf([
            ['a', 'TEXT', { name: 'dup' }],
            ['b', 'TEXT', { name: 'dup' }],
        ]);
        const { repo } = setup(entity as never);

        await expect(repo.find({ where: { id: 'x' } })).rejects.toThrow(InvalidQueryError);
        await expect(repo.find({ where: { id: 'x' } })).rejects.toThrow(InvalidQueryError);
    });

    it('allows two properties to swap names, since the emitted names are distinct', async () => {
        const entity = entityOf([
            ['p', 'TEXT', { name: 'q' }],
            ['q', 'TEXT', { name: 'p' }],
        ]);
        const { repo, executed } = setup(entity as never);

        await repo.find({ select: ['p', 'q'] });

        expect(repo.getColumnNames()).toEqual(['id', 'p', 'q']);
        expect(executed[0].query).toMatch(/^SELECT q, p FROM cn_dynamic_\d+$/);
    });

    it('allows a rename to differ from its own property only by case', async () => {
        const entity = entityOf([['userId', 'TEXT', { name: 'userid' }]]);
        const { repo, executed } = setup(entity as never);

        await repo.find({ select: ['userId'] });

        expect(executed[0].query).toMatch(/^SELECT userid FROM cn_dynamic_\d+$/);
    });
});

describe('column name: inheritance', () => {
    it('a subclass overriding a renamed column uses its own name, in the inherited position', async () => {
        const { repo, executed } = setup(ChildThing, [{ thing_id: 't', title_text: 'child', label_text: 'base' }]);

        const [row] = await repo.find({ select: ['label', 'extra'], where: { id: 't', label: 'x' } });
        await repo.update({ id: 't' }, { label: 'y', extra: 'z' });

        expect(repo.getColumnNames()).toEqual(['id', 'label', 'extra']);
        expect(executed[0].query).toEqual(
            'SELECT title_text, extra_col FROM cn_child_thing WHERE thing_id = ? AND title_text = ?'
        );
        expect(executed[1].query).toEqual('UPDATE cn_child_thing SET title_text = ?, extra_col = ? WHERE thing_id = ?');
        expect(row.label).toBe('child');
    });

    it('the parent keeps its own name after a subclass overrides the column', async () => {
        const { repo, executed } = setup(BaseThing, [{ thing_id: 't', label_text: 'base' }]);

        const [row] = await repo.find({ select: ['label'] });

        expect(executed[0].query).toEqual('SELECT label_text FROM cn_base_thing');
        expect(row.label).toBe('base');
        expect(repo.getColumnNames()).toEqual(['id', 'label']);
    });

    it('a subclass can override a renamed column without a name, dropping the rename', async () => {
        const { repo, executed } = setup(ChildPlainThing, [{ thing_id: 't', label: 'plain' }]);

        const [row] = await repo.find({ select: ['id', 'label'] });

        expect(executed[0].query).toEqual('SELECT thing_id, label FROM cn_child_plain_thing');
        expect(row.label).toBe('plain');
    });

    it('a subclass inherits a renamed primary key', async () => {
        const { repo, executed } = setup(ChildThing);

        await repo.delete({ id: 't' });

        expect(executed[0].query).toEqual('DELETE FROM cn_child_thing WHERE thing_id = ?');
    });
});

describe('column name: regression for entities that never use name', () => {
    it('produces byte-identical CQL and params', async () => {
        const { repo, executed } = setup(Plain, [{ count: 1 }]);
        const created = new Date(0);
        const item = repo.create({
            id: '33333333-3333-4333-8333-333333333333',
            label: 'L',
            score: 2,
            createdAt: created,
            visits: 0,
        });

        await repo.save(item, { ttl: 9 });
        await repo.find({
            select: ['id', 'createdAt'],
            where: { label: 'L', score: GreaterThan(1) },
            orderBy: { createdAt: 'DESC' },
            limit: 2,
        });
        await repo.findOneBy({ id: '33333333-3333-4333-8333-333333333333' });
        await repo.update({ id: '33333333-3333-4333-8333-333333333333' }, { label: 'M', score: 3 });
        await repo.delete({ id: '33333333-3333-4333-8333-333333333333', label: 'M' });
        await repo.increment({ id: '33333333-3333-4333-8333-333333333333' }, 'visits', 4);
        await repo.countBy({ label: 'L' });

        expect(executed.map((e) => e.query)).toEqual([
            'INSERT INTO cn_plain (id, label, score, createdAt, visits) VALUES (?, ?, ?, ?, ?) USING TTL ?',
            'SELECT id, createdAt FROM cn_plain WHERE label = ? AND score > ? ORDER BY createdAt DESC LIMIT ?',
            'SELECT * FROM cn_plain WHERE id = ? LIMIT 1',
            'UPDATE cn_plain SET label = ?, score = ? WHERE id = ?',
            'DELETE FROM cn_plain WHERE id = ? AND label = ?',
            'UPDATE cn_plain SET visits = visits + ? WHERE id = ?',
            'SELECT COUNT(*) FROM cn_plain WHERE label = ?',
        ]);
        expect(executed[0].params).toEqual(['33333333-3333-4333-8333-333333333333', 'L', 2, created, 0, 9]);
        expect(executed[1].params).toEqual(['L', 1, 2]);
        expect(executed[3].params).toEqual(['M', 3, '33333333-3333-4333-8333-333333333333']);
    });

    it('maps rows by the property name, falling back to its lowercase', async () => {
        const { repo } = setup(Plain, [
            { id: '33333333-3333-4333-8333-333333333333', label: 'L', score: 1, createdat: new Date(5), visits: 2 },
        ]);

        const [row] = await repo.find();

        expect(row.createdAt).toEqual(new Date(5));
        expect(row.label).toBe('L');
        expect(repo.getColumnNames()).toEqual(['id', 'label', 'score', 'createdAt', 'visits']);
    });

    it('an unknown name is still an UnknownColumnError listing the declared names', async () => {
        const { repo } = setup(Plain);

        const error = await repo.find({ where: { nope: 1 } }).catch((e) => e);

        expect(error).toBeInstanceOf(UnknownColumnError);
        expect(error.knownColumns).toEqual(['id', 'label', 'score', 'createdAt', 'visits']);
    });
});

describe('column name: not applied to what it should not touch', () => {
    it('a renamed column on one entity does not leak into another entity sharing a property name', async () => {
        const { repo: people, executed } = setup(Person);
        const { repo: plain } = setup(Plain);

        await people.find({ select: ['city'] });
        await plain.find({ select: ['label'] });

        expect(executed[0].query).toEqual('SELECT city FROM cn_people');
    });

    it('does not mutate the entity: the property stays on the instance after save()', async () => {
        const { repo } = setup(Person);
        const person = repo.create({
            personId: '11111111-1111-4111-8111-111111111111',
            firstName: 'Ann',
            city: 'x',
            age: 1,
            nickNames: [],
            createdAt: new Date(0),
        });

        await repo.save(person);

        expect(Object.keys(person).sort()).toEqual(['age', 'city', 'createdAt', 'firstName', 'nickNames', 'personId']);
    });
});
