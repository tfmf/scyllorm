# Changelog

All notable changes to this project are documented here.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While
the major version is `0`, breaking changes are released under a new minor version.

## [Unreleased]

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
