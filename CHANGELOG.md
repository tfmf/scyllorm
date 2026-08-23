# Changelog

All notable changes to this project are documented here.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Breaking changes increment the major version.

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
- **`create(plain?)`** — entity factory. Column defaults apply first, then only *declared*
  columns are copied from the input — an extra key on a request body is ignored, not
  mass-assigned.
- **`findOneOrFail(conditions, allowFiltering?)`** — throws the new `EntityNotFoundError`
  (code `SCYLLORM_ENTITY_NOT_FOUND`) when nothing matches. The error carries the condition
  *columns* on `.criteriaColumns`, deliberately never their values — lookup keys are
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

  | `limit` | before | now |
  | --- | --- | --- |
  | `0` | `LIMIT 0` — a legal query returning no rows | throws |
  | `-1` | `LIMIT -1` — rejected by the server, a round trip away | throws |
  | `10.5` | silently truncated to `LIMIT 10` | throws |
  | `null` | `LIMIT 0` | throws |
  | `NaN` | `LIMIT NaN` — a CQL syntax error from the server | throws |
  | above `2147483647` | a `RangeError` from inside the driver | throws |
  | `'10'` | `LIMIT 10` | `LIMIT ?` bound to `10` — unchanged behaviour |

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
