import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    BaseModel,
    Between,
    Column,
    Contains,
    ContainsKey,
    DataSource,
    Entity,
    EntityNotFoundError,
    GreaterThan,
    InvalidQueryError,
    PrimaryKeyColumn,
    Repository,
} from '../src';

// Keyspace-qualified table names: the connection is opened without a session
// keyspace, which is the supported pattern for multi-keyspace apps.
@Entity('scyllorm_e2e.employees')
class Employee extends BaseModel {
    @PrimaryKeyColumn('INT', { partitionKey: true })
    id: number;

    @Column('TEXT')
    first_name: string;

    @Column('INT')
    age: number;

    @Column('TEXT')
    city: string | null;

    @Column('SET')
    tags: string[];

    @Column('MAP')
    metadata: Record<string, number>;
}

@Entity('scyllorm_e2e.page_views')
class PageView extends BaseModel {
    @PrimaryKeyColumn('TEXT', { partitionKey: true })
    id: string;

    @Column('COUNTER')
    views: unknown; // The driver returns a Long; compare through String()/Number()
}

function makeEmployee(
    id: number,
    firstName: string,
    age: number,
    city: string,
    tags: string[],
    metadata: Record<string, number>
): Employee {
    const employee = new Employee();
    employee.id = id;
    employee.first_name = firstName;
    employee.age = age;
    employee.city = city;
    employee.tags = tags;
    employee.metadata = metadata;
    return employee;
}

const SEED = [
    makeEmployee(1, 'Alice', 30, 'Lisbon', ['admin', 'dev'], { logins: 10 }),
    makeEmployee(2, 'Bob', 25, 'Porto', ['dev'], { logins: 5 }),
    makeEmployee(3, 'Carol', 35, 'Lisbon', ['ops'], { visits: 2 }),
    makeEmployee(4, 'Dave', 40, 'Faro', ['admin'], { logins: 1, visits: 7 }),
    makeEmployee(5, 'Eve', 28, 'Braga', ['qa'], { audits: 3 }),
];

describe('Tier 1 API against a live ScyllaDB', () => {
    let dataSource: DataSource;
    let employees: Repository<Employee>;
    let pageViews: Repository<PageView>;

    beforeAll(async () => {
        dataSource = new DataSource({
            contactPoints: ['127.0.0.1'],
            localDataCenter: 'datacenter1',
        });
        await dataSource.initialize();

        await dataSource.executeQuery(
            // Tablets are the default on scylladb/scylla:latest and reject SimpleStrategy,
            // so the keyspace opts out of them to keep the SimpleStrategy RF-1 layout
            'CREATE KEYSPACE IF NOT EXISTS scyllorm_e2e ' +
                "WITH replication = { 'class': 'SimpleStrategy', 'replication_factor': 1 } " +
                "AND tablets = { 'enabled': false }",
            [],
            { prepare: false }
        );
        await dataSource.executeQuery(
            'CREATE TABLE IF NOT EXISTS scyllorm_e2e.employees (' +
                'id int PRIMARY KEY, first_name text, age int, city text, tags set<text>, metadata map<text, int>)',
            [],
            { prepare: false }
        );
        await dataSource.executeQuery(
            'CREATE TABLE IF NOT EXISTS scyllorm_e2e.page_views (id text PRIMARY KEY, views counter)',
            [],
            { prepare: false }
        );

        employees = dataSource.getRepository(Employee);
        pageViews = dataSource.getRepository(PageView);
    });

    afterAll(async () => {
        // Drop the keyspace, then always shut the client down — a live client
        // holds sockets open and vitest would hang on the leaked handles.
        if (dataSource) {
            try {
                await dataSource.executeQuery('DROP KEYSPACE IF EXISTS scyllorm_e2e', [], { prepare: false });
            } finally {
                await dataSource.shutdown();
            }
        }
    });

    it('save() persists rows and findOneBy() reads one back with full fidelity', async () => {
        for (const employee of SEED) {
            await employees.save(employee);
        }

        const alice = await employees.findOneBy({ id: 1 });
        expect(alice).not.toBeNull();
        expect(alice!.id).toBe(1);
        expect(alice!.first_name).toBe('Alice');
        expect(alice!.age).toBe(30);
        expect(alice!.city).toBe('Lisbon');
        expect([...alice!.tags].sort()).toEqual(['admin', 'dev']);
        expect(alice!.metadata).toEqual({ logins: 10 });
    });

    it('find() returns every saved row', async () => {
        const all = await employees.find();
        expect(all.map((row) => row.id).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    });

    it('findBy() with GreaterThan and allowFiltering narrows by age', async () => {
        const older = await employees.findBy({ age: GreaterThan(28) }, true);
        expect(older.map((row) => row.id).sort((a, b) => a - b)).toEqual([1, 3, 4]);
    });

    it('findPaged() walks the pageState with fetchSize 2 without duplicates', async () => {
        const ids: number[] = [];
        let cursor: string | undefined;
        let hasMore: boolean;
        let pages = 0;

        do {
            const page = await employees.findPaged({ fetchSize: 2, pageState: cursor });
            ids.push(...page.rows.map((row) => row.id));
            pages++;

            // The documented cursor contract: a string while more pages remain,
            // undefined once the result set is exhausted
            if (page.hasMore) {
                expect(typeof page.pageState).toBe('string');
            } else {
                expect(page.pageState).toBeUndefined();
            }

            cursor = page.pageState;
            hasMore = page.hasMore;
        } while (hasMore && pages < 10);

        expect(pages).toBeGreaterThanOrEqual(3);
        expect(new Set(ids).size).toBe(ids.length); // no duplicates across pages
        expect([...ids].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    });

    it('stream() yields every row one at a time', async () => {
        const ids: number[] = [];

        for await (const row of employees.stream({ fetchSize: 2 })) {
            ids.push(row.id);
        }

        expect(ids.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    });

    it('update() changes a column and the change is read back', async () => {
        await employees.update({ id: 2 }, { city: 'Madrid' });

        const bob = await employees.findOneBy({ id: 2 });
        expect(bob!.city).toBe('Madrid');
        expect(bob!.first_name).toBe('Bob'); // untouched columns keep their values
    });

    it('update() with null deletes the cell', async () => {
        await employees.update({ id: 2 }, { city: null });

        const bob = await employees.findOneBy({ id: 2 });
        expect(bob!.city ?? null).toBeNull();
    });

    it('update() on a primary key column is rejected locally', async () => {
        const failure = await employees.update({ id: 2 }, { id: 99 } as Partial<Employee>).then(
            () => null,
            (error: unknown) => error
        );

        expect(failure).toBeInstanceOf(InvalidQueryError);
        expect((failure as InvalidQueryError).code).toBe('SCYLLORM_INVALID_QUERY');

        // Rejected before reaching the server: the row is untouched
        const bob = await employees.findOneBy({ id: 2 });
        expect(bob!.id).toBe(2);
    });

    it('increment() and decrement() move a counter to the exact value', async () => {
        await pageViews.increment({ id: 'home' }, 'views'); // +1 default
        await pageViews.increment({ id: 'home' }, 'views', 5); // +5
        await pageViews.decrement({ id: 'home' }, 'views', 2); // -2

        const home = await pageViews.findOneBy({ id: 'home' });
        expect(home).not.toBeNull();
        expect(String(home!.views)).toBe('4');
        expect(Number(String(home!.views))).toBe(4);
    });

    it('count(), countBy(), exists() and existsBy() agree with the data', async () => {
        expect(await employees.count()).toBe(5);
        expect(await employees.countBy({ age: GreaterThan(28) }, true)).toBe(3);
        expect(await employees.exists()).toBe(true);
        expect(await employees.existsBy({ id: 3 })).toBe(true);
        expect(await employees.existsBy({ id: 424242 })).toBe(false);
    });

    it('Between() returns the inclusive age range', async () => {
        const inRange = await employees.find({ where: { age: Between(28, 35) } }, true);
        // Both endpoints included: Eve is exactly 28 and Carol exactly 35
        expect(inRange.map((row) => row.id).sort((a, b) => a - b)).toEqual([1, 3, 5]);
    });

    it('Contains() matches rows whose set holds the value', async () => {
        const admins = await employees.find({ where: { tags: Contains('admin') } }, true);
        expect(admins.map((row) => row.id).sort((a, b) => a - b)).toEqual([1, 4]);
    });

    it('ContainsKey() matches rows whose map holds the key', async () => {
        const withLogins = await employees.find({ where: { metadata: ContainsKey('logins') } }, true);
        expect(withLogins.map((row) => row.id).sort((a, b) => a - b)).toEqual([1, 2, 4]);
    });

    it('create() assigns declared columns, ignores undeclared keys, and saves', async () => {
        const created = employees.create({
            id: 6,
            first_name: 'Frank',
            age: 22,
            city: 'Porto',
            tags: ['new'],
            metadata: { logins: 0 },
            bogus: 'must not be assigned',
        } as unknown as Partial<Employee>);

        expect('bogus' in created).toBe(false);
        expect(created).toBeInstanceOf(Employee);

        await employees.save(created);

        const frank = await employees.findOneBy({ id: 6 });
        expect(frank!.first_name).toBe('Frank');
        expect(frank!.age).toBe(22);
        expect([...frank!.tags]).toEqual(['new']);
    });

    it('findOneOrFail() returns the entity when it exists', async () => {
        const frank = await employees.findOneOrFail({ id: 6 });
        expect(frank.first_name).toBe('Frank');
    });

    it('findOneOrFail() rejects with EntityNotFoundError that hides the value', async () => {
        const failure = await employees.findOneOrFail({ id: 424242 }).then(
            () => null,
            (error: unknown) => error
        );

        expect(failure).toBeInstanceOf(EntityNotFoundError);
        expect((failure as EntityNotFoundError).message).not.toContain('424242');
    });

    it('delete() removes a single row', async () => {
        await employees.delete({ id: 6 });

        expect(await employees.findOneBy({ id: 6 })).toBeNull();
        expect(await employees.count()).toBe(5);
    });

    it('clear() empties the table', async () => {
        await employees.clear();

        expect(await employees.count()).toBe(0);
        expect(await employees.exists()).toBe(false);
    });

    it('runRawQuery() binds :name parameters against the live server', async () => {
        await employees.runRawQuery(
            'INSERT INTO scyllorm_e2e.employees (id, first_name, age) VALUES (:id, :first_name, :age)',
            { id: 7, first_name: 'Grace', age: 41 }
        );

        const rows = await employees.runRawQuery('SELECT * FROM scyllorm_e2e.employees WHERE id = :id', { id: 7 });
        expect(rows).toHaveLength(1);
        expect(rows[0].first_name).toBe('Grace');
        expect(rows[0].age).toBe(41);
    });
});
