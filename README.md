# Scyllorm - TypeScript ORM for ScyllaDB & Apache Cassandra
[![NPM](https://img.shields.io/npm/v/scyllorm)](https://www.npmjs.com/package/scyllorm)
[![npm downloads](https://img.shields.io/npm/dt/scyllorm.svg)](https://www.npmjs.com/package/scyllorm)
[![CI](https://github.com/tfmf/scyllorm/actions/workflows/ci.yml/badge.svg)](https://github.com/tfmf/scyllorm/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/badge/coverage-98%25-brightgreen)](https://github.com/tfmf/scyllorm/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/tfmf/scyllorm/blob/main/LICENSE)

<p align="left">
  <img src="assets/scyllorm-logo.png" alt="Scyllorm" width="300">
</p>


Welcome to **Scyllorm**—an experimental TypeScript ORM for ScyllaDB and Apache Cassandra that’s so fresh, it’s practically still in beta diapers. We’ve set out to simplify database interactions in Node.js. By “simplify,” we mean it’s highly opinionated, so prepare to adopt our opinions, or go find another ORM. Features? Yeah, we’ve got some—just not all of them (yet). A few are stuck in the backlog, and others are on the database’s “no-can-do” list.

Under the hood we use the Node.js [Cassandra driver](https://github.com/datastax/nodejs-driver/), and every statement Scyllorm generates is standard CQL 3—no Scylla-only extensions. That makes **both ScyllaDB and Apache Cassandra (3.x/4.x) first-class citizens**: same API, same CQL, pick whichever keeps your pager quieter.

Oh, and we’re currently rolling with the [Data Mapper Pattern](https://en.wikipedia.org/wiki/Data_mapper_pattern) because it’s what all the cool ORMs are doing. Maybe someday we’ll add the [Active Record Pattern](https://en.wikipedia.org/wiki/Active_record_pattern), but we’re still debating whether we like our records active or not.

## Prerequisites 🎒
- <img src="https://github.com/user-attachments/assets/9804b3c6-4be3-4741-a1c9-ff4460eef94e" alt="node" width="20" height="20"> **Node.js:** If you don't have this, you might be in the wrong place.
- <img src="https://github.com/user-attachments/assets/32da44a9-cc43-4987-af94-696488792995" alt="docker" width="20" height="20"> **Docker:** The easiest way to spin up ScyllaDB locally without accidentally summoning Cthulhu.

## Installation 🚀
To install Scyllorm, just hit it with the good ol’ NPM:

```bash
npm install scyllorm
```
(https://www.npmjs.com/package/scyllorm)

## Step-by-Step Guide 🛠
### 1. Summon ScyllaDB via Docker 🐳

**Docker:**

```bash
docker run -d \
  -p 9042:9042 \
  --cpus 2 \
  --memory 2g \
  scylladb/scylla:latest \
  --smp 2 \
  --memory=2G \
  --overprovisioned 1 \
  --authenticator PasswordAuthenticator \
  --authorizer CassandraAuthorizer \
  --max-clustering-key-restrictions-per-query 1500
```

**docker-compose:**

```bash
  core_scylladb:
    container_name: scylladb_server
    image: scylladb/scylla:latest
    ports:
      - "9042:9042" # CQL
    command: --smp 2 --memory=2G --overprovisioned 1 --authenticator PasswordAuthenticator --authorizer CassandraAuthorizer --max-clustering-key-restrictions-per-query 1500
    volumes:
      - ./scylladb_data:/var/lib/scylla
```

### 2. Test Your Connection 🎯
- For a friendly UI, try [DbVisualizer Free](https://www.dbvis.com/).
- Or, if you're feeling hardcore, dive into the terminal:

```bash
docker exec -it scylladb_server cqlsh -u cassandra -p cassandra
```

### 3. Create a Test Table 🛠️
Because what’s a database without a table?

```cql
CREATE KEYSPACE test_keyspace WITH REPLICATION = {'class': 'SimpleStrategy', 'replication_factor': 1} AND durable_writes = true;

USE test_keyspace;

CREATE TABLE employees (
  id int,
  first_name text,
  last_name text,
  age int,
  city text,
  created_at timestamp,
  updated_at timestamp,
  deleted_at timestamp,
  PRIMARY KEY (id, first_name)
);

CREATE INDEX employees_first_first_name_idx ON employees (first_name);
CREATE INDEX employees_first_last_name_idx ON employees (last_name);
```

Allergic to hand-written DDL? Your entities can generate all of this for you — see §10, Schema Synchronization.

### 4. Create Your Model 🎨
Now, let’s make a model:

```typescript
import { BaseModel, Column, Entity, Index, PrimaryKeyColumn } from 'scyllorm';

@Entity('employees')
@Index('employees_first_first_name_idx', 'first_name')
@Index('employees_first_last_name_idx', 'last_name')
export class Employee extends BaseModel {
    @PrimaryKeyColumn('INT', { partitionKey: true })
    id: number;

    @PrimaryKeyColumn('TEXT', { clusteringKey: true })
    first_name: string;

    @Column('TEXT')
    last_name: string;

    @Column('INT', { default: 0 })
    age: number;

    @Column('TEXT', { default: 0 })
    city: string;

    @Column('TIMESTAMP', { default: () => new Date() })
    created_at: Date;

    @Column('TIMESTAMP', { default: () => new Date() })
    updated_at: Date;

    @Column('TIMESTAMP')
    deleted_at: Date | null;
}
```

### 5. Setup the DataSource 🛢
This is where the magic happens:

```typescript
import { DataSource } from 'scyllorm';

const dataSource = new DataSource({
    contactPoints: ['localhost'], // Change this if your setup is fancier
    localDataCenter: 'datacenter1',
    keyspace: 'test_keyspace',
    credentials: {
        username: 'cassandra',
        password: 'cassandra',
    },
    protocolOptions: { port: 9042 },
});
```

### 6. Use the Repository 🛠
Now, let’s put this thing to work:

```typescript
 async function run() {
    try {
        await dataSource.initialize();

        const repository = dataSource.getRepository(Employee);

        const employee = new Employee();
        employee.id = 1;
        employee.first_name = 'John';
        employee.last_name = 'Doe';
        employee.age = 30;
        employee.city = 'New York';

        const employee2 = new Employee();
        employee2.id = 2;
        employee2.first_name = 'Jane';
        employee2.last_name = 'Doe';
        employee2.age = 25;
        employee2.city = 'Los Angeles';

        await repository.save(employee);
        console.log('Employee 1 saved successfully!');

        await repository.save(employee2);
        console.log('Employee 2 saved successfully!');

        const employeeId = 1;

        const findOneById = await repository.findOneBy({ id: employeeId });
        console.log('Found by ID:', findOneById);

        const findById = await repository.findBy({ id: employeeId });
        console.log('Found by findBy:', findById);

        const findEmployee = await repository.find({ where: { id: employeeId } });
        console.log('Found by find:', findEmployee);

        const allEmployees = await repository.find();
        console.log('All Employees:', allEmployees);

        const limitedEmployees = await repository.find({ limit: 5 });
        console.log('Limited Employees:', limitedEmployees);

        const orderedEmployees = await repository.find({
            where: { id: employeeId },
            orderBy: { first_name: 'ASC' },
            limit: 10,
        });
        console.log('Ordered Employees:', orderedEmployees);

        // https://www.scylladb.com/2018/08/16/upcoming-enhancements-filtering-implementation/
        const allowFiltering = true;
        const findEmployeeWithAge30And25 = await repository.find({ where: { age: In([25, 30]) } }, allowFiltering);
        console.log('Found Employees with age 30 and 25:', findEmployeeWithAge30And25);

        const findEmployeeWithAgeAbove25 = await repository.find({ where: { age: GreaterThan(25) } }, allowFiltering);
        console.log('Found Employees with age above 25:', findEmployeeWithAgeAbove25);

        const findEmployeeWithAgeAboveOrEqualTo25 = await repository.find(
            { where: { age: GreaterThanOrEqual(25) } },
            allowFiltering
        );
        console.log('Found Employees with age equal to 25 or above:', findEmployeeWithAgeAboveOrEqualTo25);

        const findEmployeeWithAgeLessThan30 = await repository.find({ where: { age: LessThan(30) } }, allowFiltering);
        console.log('Found Employees with age less than 30:', findEmployeeWithAgeLessThan30);

        const findEmployeeWithAgeLessThanOrEqual30 = await repository.find(
            { where: { age: LessThanOrEqual(30) } },
            allowFiltering
        );
        console.log(findEmployeeWithAgeLessThanOrEqual30);

        const findEmployeeWithRawQuery = await repository.runRawQuery(
            `SELECT * FROM employees WHERE id = :employee_id`,
            { employee_id: 1 }
        );
        console.log(findEmployeeWithRawQuery);
    } catch (error) {
        console.error('Error:', error);
    } finally {
        await dataSource.shutdown(); // Don’t forget to shut it down, or it might haunt you later.
    }
}
run();
```

#### Write without reading first ✍️

`update()` changes columns in place — no need to load and re-`save()` the whole
entity. Conditions must identify rows by primary key, and like every CQL write
it is an upsert. Pass `null` to delete a cell; `undefined` throws, because in
JavaScript it is almost always an accident.

```typescript
await repository.update({ id: 1 }, { city: 'Berlin', age: 31 });
await repository.update({ id: 1 }, { city: null }); // deletes the cell

// COUNTER columns move relative to themselves — update() rejects them:
await repository.increment({ id: 'home' }, 'views');      // +1
await repository.increment({ id: 'home' }, 'views', 5);   // +5
await repository.decrement({ id: 'home' }, 'views', 2);   // -2

await repository.clear(); // TRUNCATE — empties the table
```

#### Counts, existence and factories 🔢

```typescript
const total = await repository.count();
const adults = await repository.countBy({ age: GreaterThanOrEqual(18) }, true);

const anyRows = await repository.exists();
const hasJohn = await repository.existsBy({ first_name: 'John' }, true);

// Build an entity from a plain object — only declared columns are copied,
// so a request body can't mass-assign anything you didn't model:
const employee = repository.create({ id: 3, first_name: 'Ana', role: 'admin' }); // `role` ignored
await repository.save(employee);

// Like findOneBy(), but absence is an error (EntityNotFoundError):
const found = await repository.findOneOrFail({ id: 3 });
```

#### Range and collection operators 🎯

```typescript
import { Between, Contains, ContainsKey } from 'scyllorm';

// Inclusive range, emitted as `age >= ? AND age <= ?`:
await repository.find({ where: { age: Between(25, 30) } }, true);

// LIST/SET/MAP membership — needs an index on the collection or ALLOW FILTERING:
await repository.find({ where: { tags: Contains('typescript') } }, true);
await repository.find({ where: { metadata: ContainsKey('team') } }, true);
```

#### Select only the columns you need 📑

`find()`, `findPaged()` and `stream()` take a `select` projection — property names
declared on the entity, whitelisted like every other identifier. Unselected
properties keep their constructor defaults (or stay `undefined`); an empty array
throws `InvalidQueryError`.

```typescript
const names = await repository.find({ select: ['first_name', 'last_name'], where: { id: 1 } });
```

### 7. Handle Large Result Sets 📄

ScyllaDB returns results one page at a time (5000 rows by default). `find()`
reads every page for you, so it always returns the complete result set — but for
a big table that means holding all of it in memory. When a query can match a lot
of rows, reach for one of these instead.

**Cursor-based pagination** — read one page at a time and hand the cursor back to
your caller (an HTTP client, say):

```typescript
const firstPage = await repository.findPaged({ fetchSize: 100 });
console.log(firstPage.rows, firstPage.hasMore);

if (firstPage.hasMore) {
    const nextPage = await repository.findPaged({ fetchSize: 100, pageState: firstPage.pageState });
    console.log(nextPage.rows);
}
```

`pageState` is `undefined` on the last page, which is what `hasMore` reflects.

**Streaming** — iterate row by row, fetching pages lazily, so only a single page
is ever in memory. This is the way to scan a table larger than your process:

```typescript
for await (const employee of repository.stream({ where: { city: 'New York' } }, true)) {
    console.log(employee.first_name);
}
```

Both accept the same options as `find()` — `where`, `orderBy`, `limit` and the
`allowFiltering` flag — plus `fetchSize` to control the page size.

### 8. Raw CQL, When the ORM Is in the Way 🔓

Column names in `where`, `orderBy` and `delete` are checked against your entity —
CQL cannot parameterize an identifier, so anything not declared with `@Column()`
is rejected instead of concatenated. That rules out a few legitimate idioms:
`token(id)` ranges, quoted identifiers, collection access like `metadata['key']`,
functions and aggregates. `runRawQuery()` is the escape hatch for all of them:

```typescript
const rows = await repository.runRawQuery(`SELECT * FROM employees WHERE id = :employee_id`, { employee_id: 1 });
```

Values are bound, never concatenated — every `:name` becomes a `?`, and colons
inside string literals, quoted identifiers and comments are left alone. The query
string itself is sent as written, so **never build it from user input**; that is
exactly the injection the rest of the API prevents.

Rows are mapped onto the entity by default. For anything the entity cannot
represent — an aggregate, a projection, another table — pass `raw: true` and the
driver's rows come back untouched:

```typescript
const [{ count }] = await repository.runRawQuery<{ count: number }>(
    `SELECT COUNT(*) AS count FROM employees WHERE city = :city`,
    { city: 'New York' },
    { raw: true, allowFiltering: true }
);
```

`runRawQuery()` reads the whole result set into memory. For a large scan — which
is what a `token()` range is usually for — the paging pair from §7 has raw
counterparts taking the same options plus `fetchSize` and `pageState`:

```typescript
for await (const employee of repository.streamRawQuery(
    `SELECT * FROM employees WHERE token(id) > token(:after)`,
    { after: 1 },
    { fetchSize: 500 }
)) {
    console.log(employee.first_name);
}

const page = await repository.runRawQueryPaged(`SELECT * FROM employees`, {}, { fetchSize: 100 });
console.log(page.rows, page.hasMore, page.pageState);
```

A missing `:name` throws `InvalidQueryError` before anything is sent; a query the
server rejects throws `QueryFailedError`, with the driver's own error on `.cause`
and the CQL on `.query`.

### 9. Error Handling ⚠️

Every error Scyllorm raises extends `ScyllormError`, so `instanceof ScyllormError`
catches all of them — switch on `.code` rather than the message, since codes are
stable and messages are not.

```typescript
import {
    ScyllormError,
    UnknownColumnError,
    InvalidQueryError,
    QueryFailedError,
    EntityNotFoundError,
} from 'scyllorm';

try {
    await repository.find({ where: { nope: 1 } });
} catch (error) {
    if (error instanceof UnknownColumnError) {
        // A column not declared on the entity was used in a query — CQL can't
        // parameterize identifiers, so unknown ones are rejected, not escaped.
        console.error(error.column, error.entity, error.knownColumns);
    } else if (error instanceof InvalidQueryError) {
        // The query was malformed before it was ever sent to the server —
        // an unusable sort direction, an empty clause, or a `limit` that is
        // not an integer from 1 to 2147483647.
    } else if (error instanceof QueryFailedError) {
        // The server rejected the query; the driver's error is on error.cause.
    } else if (error instanceof EntityNotFoundError) {
        // findOneOrFail() found nothing. Carries the condition columns on
        // .criteriaColumns — never their values, which are routinely sensitive.
    } else if (error instanceof ScyllormError) {
        // Any other Scyllorm-raised error.
    }
}
```

### 10. Schema Synchronization 🏗

Your entities already describe the schema, so Scyllorm can write the DDL for you:
`dataSource.synchronize()` runs one `CREATE TABLE IF NOT EXISTS` per entity, then
one `CREATE INDEX IF NOT EXISTS` per `@Index`. It is an explicit opt-in call —
never automatic on `initialize()`, and it never `ALTER`s or `DROP`s anything, so
an existing table is left exactly as it was.

Collection columns declare their element type with `of`, and clustering keys can
pick a direction with `order` (rendered as `WITH CLUSTERING ORDER BY`). To keep
the generated table honest, every `@PrimaryKeyColumn()` must be marked with
exactly one of `{ partitionKey: true }` or `{ clusteringKey: true }` — anything
else throws locally before a single statement reaches the server:

```typescript
import { BaseModel, Column, Entity, Index, PrimaryKeyColumn } from 'scyllorm';

@Entity('posts')
@Index('posts_author_idx', 'author')
export class Post extends BaseModel {
    @PrimaryKeyColumn('UUID', { partitionKey: true })
    id: string;

    @PrimaryKeyColumn('TIMEUUID', { clusteringKey: true, order: 'DESC' })
    created_at: string;

    @Column('TEXT')
    author: string;

    @Column('LIST', { of: 'TEXT' })
    tags: string[];

    @Column('MAP', { of: ['TEXT', 'INT'] })
    reactions: Record<string, number>;
}

await dataSource.initialize();
await dataSource.synchronize([Post]);
```

That generates — and runs, in order:

```cql
CREATE TABLE IF NOT EXISTS posts (id uuid, created_at timeuuid, author text, tags list<text>, reactions map<text, int>, PRIMARY KEY (id, created_at)) WITH CLUSTERING ORDER BY (created_at DESC)
CREATE INDEX IF NOT EXISTS posts_author_idx ON posts (author)
```

Unrenderable metadata fails fast, locally: a collection without `of`, a table
without a partition key, or a `TUPLE`/`FROZEN` column (create those tables
yourself) all throw before anything reaches the server. Prefer to look before
you leap? The builders are exported too — `buildSchema(Post)` returns the DDL
strings without needing a connection at all (also `buildCreateTable` and
`buildCreateIndexes` individually).

### 11. Lifecycle Hooks 🪝

Entities can opt into lifecycle hooks — no decorators, no registration, just
declare the method and Scyllorm awaits it. `save()` and `insertIfNotExists()`
call the *instance* hooks; `update()`/`updateIfExists()` and
`delete()`/`deleteIfExists()` target rows by conditions, so no instance exists —
their hooks are *static* on the entity class. A `before*` hook that throws
aborts the write before anything is sent; an `after*` hook that throws
propagates to the caller (the write already happened).

```typescript
@Entity('employees')
export class Employee extends BaseModel {
    // ... columns from step 4 ...

    async beforeSave(): Promise<void> {
        this.updated_at = new Date(); // runs before the INSERT is even built
    }

    afterSave(): void {
        console.log('saved!');
    }

    static beforeUpdate(conditions: Record<string, unknown>, values: Record<string, unknown>): void {
        if ('id' in values) {
            throw new Error('nope'); // throwing aborts the UPDATE
        }
    }

    static afterDelete(conditions: Record<string, unknown>): void {
        console.log('deleted rows matching', Object.keys(conditions));
    }
}
```

The full set: instance `beforeSave()`/`afterSave()`, static
`beforeUpdate(conditions, values)`/`afterUpdate(conditions, values)` and
`beforeDelete(conditions)`/`afterDelete(conditions)`. The statement builders
(§13), `increment()`/`decrement()`, `clear()` and the raw-query family run **no
hooks**.

### 12. TTL and Conditional Writes ⏳

Writes take a `ttl` in seconds, so rows (or the updated cells) expire on their
own — no cleanup cron required. It renders as `USING TTL ?` with the value
bound, and anything that is not an integer from 1 to 2147483647 throws
`InvalidQueryError` locally:

```typescript
await repository.save(employee, { ttl: 3600 });
await repository.update({ id: 1 }, { city: 'Berlin' }, { ttl: 60 });
```

When “every write is an upsert” is exactly what you *don’t* want, the
conditional variants use a lightweight transaction and report whether the
server applied the write:

```typescript
const inserted = await repository.insertIfNotExists(employee); // false — the row already existed
const updated = await repository.updateIfExists({ id: 1 }, { city: 'Berlin' }); // false — no such row
const deleted = await repository.deleteIfExists({ id: 1, first_name: 'John' }); // false — nothing there
```

The server takes a Paxos round to decide, which costs more than a plain write —
reach for these only where the race (or the upsert) is the bug. They run the
same lifecycle hooks as their plain counterparts, and `insertIfNotExists()` and
`updateIfExists()` accept the same options (`ttl` included).

### 13. Batch Writes 📦

Every write has a statement-builder twin — `saveStatement()`,
`updateStatement()`, `deleteStatement()` — that builds the exact CQL and bound
values the plain call would run, without running it. Hand the statements to
`dataSource.executeBatch()` and they execute as a single CQL logged batch:
atomic, so either every statement applies or none does.

```typescript
const repository = dataSource.getRepository(Employee);

await dataSource.executeBatch([
    repository.saveStatement(employee),
    repository.updateStatement({ id: 2, first_name: 'Jane' }, { city: 'Porto' }),
    repository.deleteStatement({ id: 3, first_name: 'Bob' }),
]);
```

The builders go through the same column whitelist, write-time validation and
local rejections as their executing counterparts — a bad statement throws while
you build it, before the batch even exists — and they accept the same
`WriteOptions` (`ttl` included). They run **no lifecycle hooks**: nothing
executes until the batch is passed to `executeBatch()`, which retries on
`NoHostAvailableError`/`DriverInternalError` like every other query and throws
`InvalidQueryError` on an empty batch.

### 14. Write-Time Validation 🛡

Every value going through `save()`/`update()` — and their statement and LWT
variants — is checked against its column’s declared CQL type before the round
trip: an `INT` must be integer-like, a `BOOLEAN` a boolean, a `TIMESTAMP` a
`Date` (or another shape the driver can encode), and so on. The checks are
deliberately permissive — they reject only values no accepted shape of the type
could carry — so the failure happens locally, naming the column, instead of as
a driver encoding error a round trip later.

Columns can add their own rule with `validate`, run after the type check and
only on non-null values. Return `true` to accept, `false` for a generic
rejection, or a string to use as the reason:

```typescript
@Entity('employees')
export class Employee extends BaseModel {
    @PrimaryKeyColumn('INT', { partitionKey: true })
    id: number;

    @Column('INT', { validate: (value) => (value as number) >= 0 || 'must not be negative' })
    age: number;
}
```

A rejection throws `ColumnValidationError` (code `SCYLLORM_COLUMN_VALIDATION`),
carrying `.column`, `.entity`, `.expected` and the value’s `.receivedType` — and
deliberately never the value itself, because written cells are routinely
sensitive and errors are routinely logged.

### Supported Column Types
Scyllorm supports the following CQL column types:

`ASCII` · `BIGINT` · `BLOB` · `BOOLEAN` · `COUNTER` · `DATE` · `DECIMAL` · `DOUBLE` · `DURATION` · `FLOAT` · `FROZEN` · `INET` · `INT` · `LIST` · `MAP` · `SET` · `SMALLINT` · `TINYINT` · `TIME` · `TIMESTAMP` · `TIMEUUID` · `TEXT` · `TUPLE` · `UUID` · `VARINT` · `VARCHAR`

And that’s it! If you followed along and didn’t encounter any errors, you’re officially ready to start messing with ScyllaDB using TypeScript in Node.js. Congratulations! 🎉🌊🦑💻

## Testing 🧪
The suite runs on [Vitest](https://vitest.dev/) — no live ScyllaDB required, the driver is mocked.

```bash
npm test              # run the suite once
npm run test:watch    # re-run on file changes
npm run test:coverage # run with coverage, report written to coverage/
npm run test:e2e      # end-to-end: boots ScyllaDB in Docker, runs e2e/, tears it down
```

Open `coverage/index.html` for a browsable, file-by-file breakdown. CI runs
`test:coverage` on every PR and fails the build if coverage drops below the
thresholds configured in `vitest.config.ts`.

The coverage badge at the top of this file is line coverage, floored to a whole
percent. It is not maintained by hand — regenerate it from the last run with:

```bash
npm run test:coverage   # writes coverage/coverage-summary.json
npm run coverage:badge  # rewrites the badge from it
```

CI runs the same script in check mode and fails the build if the badge does not
match what the suite measured, so it cannot quietly drift out of date.

## Contributing
Found a bug? Want to add a feature?  We welcome all contributions! Just open a PR and we'll review it as fas as humanly possible (or not)

Start with [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the test commands and what a reviewable PR looks like. Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Examples
You can find examples in Typescript and Javascript inside the folder [src/examples](https://github.com/tfmf/scyllorm/tree/main/src/example)

## License
MIT License


