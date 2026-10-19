# Changelog

All notable changes to this project are documented here.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Breaking changes increment the major version.

## [0.9.0] - 2026-10-19

### Added

- **User-defined types.** `@Column('UDT', { udt })`, where `udt` is a `UserDefinedType`
  object (`{ name, fields }`) or the name of a type managed elsewhere. LIST/SET/MAP columns
  take `of: 'UDT'` (elements always frozen). Columns are `frozen<...>` unless
  `frozen: false`. `synchronize()`, `buildSchema()` and the new `buildCreateTypes()` emit
  `CREATE TYPE IF NOT EXISTS` before the table, nested types first, qualified with the
  table's keyspace. Field names must be lowercase, since the driver silently drops object
  keys that do not match a folded field name. Writing a non-null key that is not a
  declared field throws `ColumnValidationError`. A type defined twice with different
  fields, a recursive type, a type without fields, a `COUNTER` field, a field named
  `constructor` or `operator`, or a non-frozen column whose type has a collection field throws
  `InvalidQueryError` before any DDL. Plain objects are accepted as condition values
  against UDT columns (and as `Contains()` operands on collections of UDTs). `In()`, `Contains()`
  and `ContainsKey()` accept them in their (widened) type parameter. A MAP keyed by a UDT needs `encoding: { map: Map }` in the client
  options.
- **`synchronize(entities, { alter: true })`.** Opt-in. Reads tables and types back from
  `system_schema` and adds missing columns (`STATIC` included) and UDT fields with
  `ALTER TABLE/TYPE ... ADD`, then creates indexes. It never drops or changes anything:
  type, key, static and undeclared-column differences are logged through `logger.warn`.
  `ALTER` statements are never retried. An unqualified table on a connection without a
  keyspace throws `InvalidQueryError`.
- **`Repository.scan(options)`.** Token-range parallel full-table scan as an async
  iterator: `concurrency` (16), `splits` (`concurrency * 4`), `fetchSize`, `select`,
  `consistency`. No order guarantee; memory bounded by about `concurrency` pages; assumes
  the Murmur3 partitioner. New `ScanOptions` type.
- **`Repository.sum/avg/min/max(column, conditions, allowFiltering?)`.** Partition
  aggregates. `sum`/`avg` take numeric columns only and return the driver's value for the
  type (a number, or `Long`/`Integer`/`BigDecimal`). `min`/`max` convert like a read of
  the column and return `null` when nothing matched.
- New exports: `buildCreateTypes`, `ScanOptions`, `SynchronizeOptions`,
  `UserDefinedType`, `UserDefinedTypeField`.

### Changed

- `synchronize()` creates a type shared by several entities once per call.
- Compatibility notes. These are type-level only; nothing changes at runtime for callers
  who use none of the above (same CQL, same behaviour):
    - `ColumnType` gains `'UDT'`. A `Record<ColumnType, ...>` map, or a `switch` over
      `ColumnType` checked for exhaustiveness, needs a `'UDT'` case.
    - `Repository` gains `scan`, `sum`, `avg`, `min` and `max`. A `Repository` subclass that
      already has a member with one of these names must match the new signature or rename
      its own. At runtime the subclass's member shadows the new one, as before.
      The same holds for the new private helpers `runAggregate`, `numericAggregate` and
      `extremum` on `Repository`, and `keyspaceOf` and `applyDiff` on `DataSource`.
    - `DataSource.synchronize()` gains an optional second parameter `options?: SynchronizeOptions`.
      A `DataSource` subclass that overrides `synchronize` with a second parameter of its own
      must accept `SynchronizeOptions` there, or move its parameter.

## [0.8.0] - 2026-10-11

### Added

- **Column `name` option.** `@Column('TEXT', { name: 'first_name' }) firstName` maps a
  camelCase property onto a snake_case column. Every API keeps taking the property name;
  the CQL uses the column name, including `synchronize()` (column list, `PRIMARY KEY`,
  `CLUSTERING ORDER BY`, `CREATE INDEX`). The name must be an unquoted identifier
  (`InvalidQueryError` otherwise), and names that clash once case-folded are rejected.
- **Column `transformer`.** `{ to(value), from(value) }` on `@Column` and `@PrimaryKeyColumn`.
  `to` runs on non-null written values and on compared `where`/condition values; type check
  and `validate` see the transformed value. `from` runs on non-null read values after the
  built-in conversion. Neither is ever called with `null`/`undefined`.
- **Static columns.** `static: true` renders `STATIC` in `synchronize()`; an entity without a
  clustering key throws `InvalidQueryError`.
- **`afterLoad()` hook.** Awaited for every entity mapped from a row, by `find()` and its
  siblings and by the raw-query family unless `raw: true`. An entity that already declares
  a method named `afterLoad` will now have it called on every read.
- **Collection updates.** `Append`, `Prepend`, `Remove`, `PutKeys` and `RemoveKeys` (and the
  `CollectionUpdate` class) as values in `update()`, `updateIfExists()` and
  `updateStatement()`, rendering `c = c + ?`, `c = ? + c` and `c = c - ?`. A wrong column type
  or a `null` operand throws `InvalidQueryError`. List `Append`/`Prepend` are not idempotent,
  so they are never retried.
- README recipes for created-at, updated-at and generated UUID/TIMEUUID keys.

### Changed

- `BatchStatement` gained an optional `isIdempotent?: boolean` marker; `false` is set by
  `updateStatement()` for list append/prepend. `executeBatch()` defaults to non-idempotent
  when any statement carries `isIdempotent: false` (`options.isIdempotent` still wins) and
  strips it before calling the driver; `executeConcurrent()` never retries such a statement.
  Absent for every other built statement, so they are unchanged; a hand-built statement that
  already carried `isIdempotent: false` now gets that treatment too.
- `synchronize()` and the schema builders now reject table, column and index names that
  start with an underscore; the `Repository` already rejected such column names. CQL never
  accepted them unquoted, so such DDL already failed on the server.
- The `values` parameter of `update()`, `updateIfExists()` and `updateStatement()` is now
  typed `UpdateValues<T>`, a supertype of `Partial<T>`: existing calls still compile.
- `BaseModel` declares the new optional `afterLoad?(): unknown`. An entity that already has an
  `afterLoad` member that takes required parameters or is not a method no longer compiles;
  rename it (it would now be called on every read anyway).
- Nothing else changes for callers who use none of the above: same CQL, same behaviour.

## [0.7.0] - 2026-10-08

### Added

- **`isIdempotent` forwarded to the driver.** Every statement now tells the driver whether it
  is safe to repeat, which is what lets speculative execution (configured through
  `ClientOptions`) kick in. Reads and plain upserts/deletes are idempotent; `increment()`,
  `decrement()` and the conditional writes are not. `RawQueryOptions.isIdempotent` overrides
  the inference (a statement is inferred idempotent only when it starts with `SELECT`).
- **`DataSource.executeConcurrent(statements, { concurrency, ...queryOptions })`** runs many
  statements with a bounded number in flight (default 100) and returns the rows per statement,
  in order. On the first failure it starts nothing new, waits for in-flight statements, then
  throws that error. An invalid `concurrency` throws `InvalidQueryError`.
- **`Repository.saveMany(entities, { concurrency, ...writeOptions })`** saves entities
  concurrently, running hooks per entity, and returns the entities.
- `ConcurrencyOptions` and `DeleteOptions` are now exported types.
- **`executeBatch()` handles `logged` and counters.** `{ logged: false }` sends an unlogged
  batch. `Repository.incrementStatement()` and `decrementStatement()` build counter
  statements, and a batch made only of those is sent as a counter batch automatically.
  Mixing counter and non-counter statements throws `InvalidQueryError` before any driver call.
- **Write timestamps.** `WriteOptions.timestamp` (microseconds, safe integer or `types.Long`)
  renders `USING TIMESTAMP ?`, combined with `ttl` as `USING TTL ? AND TIMESTAMP ?`, and is
  always bound as a `Long` so it encodes as `bigint` even with `prepare: false`.
  `delete()` and `deleteStatement()` take `{ timestamp }` through the new `DeleteOptions`.
  The conditional writes reject a timestamp locally, because a lightweight transaction cannot
  carry one. Without a timestamp the CQL is unchanged.
- **`FindOptions.perPartitionLimit`** renders `PER PARTITION LIMIT ?` (after `ORDER BY`,
  before `LIMIT`) to get the first N rows of every partition.

### Changed

- **Retries only apply to idempotent statements.** Now that statements are marked, the driver
  moves a timed-out idempotent statement on to the next host and can end with
  `NoHostAvailableError` after the write was already applied, so retrying everything would
  risk applying a write twice. `increment()`, `decrement()` and the conditional writes are
  attempted once, and so are writes sent directly through `DataSource.executeQuery()` and raw
  writes, unless you pass `isIdempotent: true`.
- **Retries back off exponentially with jitter** (about 50, 100 and 200ms) instead of
  retrying immediately.
- **The driver's own retry policy now sees idempotent statements.** Before, no statement was
  marked, so the driver treated all of them as non-idempotent. Now reads, `save()`,
  `update()`, `delete()` and plain batches are marked idempotent, and the driver's default
  `RetryPolicy` moves them on to the next host of the query plan after a client timeout,
  socket error or overloaded response (and retries a logged batch after a batch-log write
  timeout). Set `policies.retry` in the client options to change that.
- For reads, raw queries and direct `DataSource.executeQuery()`/`executeConcurrent()` calls,
  idempotence is resolved from
  the per-call `isIdempotent`, then the client's `queryOptions.isIdempotent`, then whether the
  query starts with `SELECT`. A client-wide `queryOptions: { isIdempotent: false }` therefore
  also stops reads from being retried. Repository writes and counter statements always set
  the flag themselves.

### Fixed

- **`executeBatch()` prepares statements by default even when options are passed.** Passing
  any options used to drop `prepare: true`, so `{ logged: false }` sent an unprepared batch.
  An explicit `prepare: false` still wins.

### Hygiene

- `cassandra-driver` is now `^4.10.0`; the `adm-zip` override is removed because the driver
  pins the patched line itself.
- The e2e suite runs in CI.

## [0.6.0] - 2026-10-07

### Added

- **Per-query consistency.** `FindOptions`, `WriteOptions` and `RawQueryOptions` gain
  `consistency`, which overrides the client default for that one query. `delete()` and
  `deleteIfExists()` gain an optional second argument, `{ consistency }`. The driver's levels
  are re-exported as `consistencies`, so `consistencies.localQuorum` needs no direct
  `cassandra-driver` import. An unknown level throws `InvalidQueryError` locally. The
  statement builders ignore it, because a batch takes its consistency from
  `executeBatch()`'s options.
- **`logger` connection option.** Connection events and failed queries go to the given
  logger instead of `console`. Anything with `info`, `warn` and `error` works, including
  pino and winston. Pass no-op methods to silence Scyllorm. The default is still `console`,
  and the option is not passed on to the driver.
- `ConnectionOptions`, `Logger` and `ConsistencyOptions` are now exported types.

### Changed

- The "Reconnecting to ScyllaDB..." message is logged at `info` instead of through
  `console.log`. Node prints both to stdout, so default output is unchanged.

## [0.5.1] - 2026-10-07

### Fixed

Every fix below is covered by a unit test and by a new end-to-end case in
`e2e/fixes-0.5.1.e2e.test.ts`. The unit suite mocks the driver, which is how these bugs
got past it.

- **camelCase properties read back as `undefined`.** CQL folds unquoted identifiers to
  lowercase, so the server returns `firstname` for a column declared as `firstName`. Rows
  are now mapped through the lowercased name when the exact name is absent. Writes were
  unaffected; reads silently lost the value.
- **`Date`, `bigint` and driver value types are accepted in `where` conditions.**
  `GreaterThan(new Date())` on a TIMESTAMP key, `Between()` over `Long`s, `In([uuid])` and
  the like threw `InvalidQueryError`. Equality lookups through `findOneBy()` and `delete()`
  already accepted them. Plain objects and arrays are still rejected. `SimpleConditionValue`
  widens to match. This is a widening, so existing code is unaffected.
- **`synchronize()` accepts keyspace-qualified table names** (`@Entity('app.users')`), the
  multi-keyspace pattern. Column and index names still allow no dot.
- **A `DataSource` works again after `shutdown()`.** The driver refuses to reconnect a
  client that has been shut down, so `initialize()` now creates a fresh one. This also fixes
  the implicit connect on the first query when `initialize()` was never called, which failed
  with `Connecting after shutdown is not supported`.
- **The `after*` hooks of the conditional writes run only when the write was applied.**
  `insertIfNotExists()`, `updateIfExists()` and `deleteIfExists()` used to call
  `afterSave()`, `afterUpdate()` or `afterDelete()` even when the server reported
  `[applied] = false`. That contradicted the documented "after it succeeds" behavior.

## [0.5.0] - 2026-08-23

### Added

All additions are validated the same way as the existing query builders: column names are
whitelisted against the entity's metadata, every value is bound to a `?` placeholder, and
bad input throws locally instead of a round trip away.

- **Schema synchronization** — `DataSource.synchronize(entities)` generates and runs the
  schema from entity metadata: one `CREATE TABLE IF NOT EXISTS` per entity (partition keys,
  clustering keys, `WITH CLUSTERING ORDER BY`) plus one `CREATE INDEX IF NOT EXISTS` per
  `@Index`. Explicit opt-in — never automatic, never `ALTER`, never `DROP`. The builders are
  exported (`buildSchema`, `buildCreateTable`, `buildCreateIndexes`) to inspect the DDL
  without a connection. All generated statements are standard CQL 3, so they run on both
  ScyllaDB and Apache Cassandra.
- **Schema metadata** — `ColumnOptions.of` declares collection element types
  (`@Column('LIST', { of: 'TEXT' })` → `list<text>`; MAP takes a `[key, value]` pair);
  `PrimaryKeyColumnOptions.order` declares clustering direction; `PrimaryKeyColumnType`
  widened from `'INT' | 'UUID' | 'TEXT'` to every scalar key type.
- **Batch writes** — `Repository.saveStatement()` / `updateStatement()` /
  `deleteStatement()` build the exact statement the plain call would run, without running
  it; `DataSource.executeBatch(statements)` executes them as one atomic CQL logged batch.
  The builders apply the same whitelist, validation and local rejections but run no
  lifecycle hooks; an empty batch throws `InvalidQueryError`.
- **Lifecycle hooks** — instance `beforeSave()` / `afterSave()` on the entity; static
  `beforeUpdate(conditions, values)` / `afterUpdate(...)` and `beforeDelete(conditions)` /
  `afterDelete(...)` on the entity class, since condition-targeted writes have no instance.
  All hooks are awaited; a `before*` hook that throws aborts the write.
- **`WriteOptions.ttl`** — `save()`, `update()` and their LWT and statement variants render
  `USING TTL ?` with the value bound; anything that is not an integer from 1 to 2147483647
  throws `InvalidQueryError` locally.
- **Conditional writes (LWT)** — `insertIfNotExists(entity)`,
  `updateIfExists(conditions, values)` and `deleteIfExists(conditions)` append
  `IF NOT EXISTS` / `IF EXISTS` and return whether the server applied the write.
- **Write-time validation** — values are checked against the column's declared CQL type
  before the round trip, and `ColumnOptions.validate` adds a custom rule (return `true`,
  `false`, or a string reason). Rejections throw the new `ColumnValidationError` (code
  `SCYLLORM_COLUMN_VALIDATION`) carrying the column, entity, expectation and the value's
  `typeof` — deliberately never the value itself.
- **`FindOptions.select`** — column projection for `find()`, `findPaged()` and `stream()`,
  whitelisted like every other identifier; unselected properties keep their constructor
  defaults. An empty array throws `InvalidQueryError`.

## [0.4.0] - 2026-08-23

### Added

Tier 1 of the roadmap, complete. All additions are validated the same way as the existing
query builders: column names are whitelisted against the entity's metadata, every value is
bound to a `?` placeholder, and bad input throws locally instead of a round trip away.

- **`update(conditions, values)`** — partial `UPDATE ... SET` without loading the entity
  first. `null` deletes a cell (tombstone); `undefined` throws `InvalidQueryError`, since in
  JavaScript it is almost always an accident. Assigning a primary key or COUNTER column
  throws locally with a pointer to the right tool.
- **`increment(conditions, column, by = 1)` / `decrement(...)`** — COUNTER column support
  (`SET c = c + ?`). The column must be declared `@Column('COUNTER')`; the delta must be a
  safe integer.
- **`count(conditions?, allowFiltering?)` / `countBy(conditions, allowFiltering?)`** —
  `SELECT COUNT(*)`, returned as a `number`.
- **`exists()` / `existsBy(conditions, allowFiltering?)`** — boolean existence via
  `SELECT ... LIMIT 1`, cheaper than counting.
- **`create(plain?)`** — entity factory. Column defaults apply first, then only _declared_
  columns are copied from the input — an extra key on a request body is ignored, not
  mass-assigned.
- **`findOneOrFail(conditions, allowFiltering?)`** — throws the new `EntityNotFoundError`
  (code `SCYLLORM_ENTITY_NOT_FOUND`) when nothing matches. The error carries the condition
  _columns_ on `.criteriaColumns`, deliberately never their values — lookup keys are
  routinely sensitive and errors are routinely logged.
- **`clear()`** — `TRUNCATE` the table.
- **`Between(from, to)`** — inclusive range, emitted as `col >= ? AND col <= ?` so it runs
  on servers that predate CQL `BETWEEN`.
- **`Contains(value)` / `ContainsKey(key)`** — ScyllaDB collection operators for
  LIST/SET/MAP columns (`CONTAINS` / `CONTAINS KEY`).
- **End-to-end suite** — `npm run test:e2e` boots ScyllaDB in Docker, runs `e2e/` against
  the live server and tears the container down.

### Changed

- `OperatorType` gains `'BETWEEN' | 'CONTAINS' | 'CONTAINS KEY'` — a widening; existing
  code is unaffected. The `unsupportedOperator` message now lists the new operators.

## [0.3.0] - 2026-08-13

### Changed — breaking

- **`limit` is validated instead of silently coerced.** `find()`, `findPaged()` and
  `stream()` now throw `InvalidQueryError` (code `SCYLLORM_INVALID_QUERY`) for a `limit`
  that is not an integer from 1 to 2147483647, or a numeric string of one.

    Previously the value went through `Math.floor()` and straight into the query text, so
    these calls used to succeed or fail somewhere less useful:

    | `limit`            | before                                                 | now                                           |
    | ------------------ | ------------------------------------------------------ | --------------------------------------------- |
    | `0`                | `LIMIT 0` — a legal query returning no rows            | throws                                        |
    | `-1`               | `LIMIT -1` — rejected by the server, a round trip away | throws                                        |
    | `10.5`             | silently truncated to `LIMIT 10`                       | throws                                        |
    | `null`             | `LIMIT 0`                                              | throws                                        |
    | `NaN`              | `LIMIT NaN` — a CQL syntax error from the server       | throws                                        |
    | above `2147483647` | a `RangeError` from inside the driver                  | throws                                        |
    | `'10'`             | `LIMIT 10`                                             | `LIMIT ?` bound to `10` — unchanged behaviour |

    `limit: 0` is the transition most likely to reach real code: it was a working query, and
    a caller computing `limit: items.length` or `limit: pageSize - offset` can produce it. If
    you rely on an empty result for a zero limit, guard before the call. A fractional `limit`
    from arithmetic (`total / pages`) now surfaces instead of being truncated — round it
    yourself if truncation was intended.

    TypeScript consumers were already constrained by `FindOptions.limit: number`, so `null`,
    `true`, `'abc'` and objects were compile errors before this change. Those rejections
    harden the JavaScript and `as any` paths rather than changing typed usage.

- **`LIMIT` is emitted as a bind parameter.** Queries now read `... LIMIT ?` with the value
  bound, rather than interpolated as a literal. This only affects code asserting on
  generated CQL. Since every query runs with `prepare: true`, `LIMIT 10` and `LIMIT 20` now
  share one prepared statement instead of compiling two.

### Added

- Test coverage is measured and enforced. `npm run test:coverage` writes a browsable report
  to `coverage/`, and CI fails a pull request that drops coverage below the thresholds in
  `vitest.config.ts`.
