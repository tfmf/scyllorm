# Contributing to Scyllorm

Thanks for taking the time — pull requests, bug reports and doc fixes are all welcome.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting started

```bash
git clone https://github.com/tfmf/scyllorm.git
cd scyllorm
npm install
npm run build
npm test
```

Node.js LTS is what CI runs on; anything older is untested.

## Development commands

| Command | What it does |
| --- | --- |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm test` | Run the unit suite once (vitest, driver mocked) |
| `npm run test:watch` | Re-run on file changes |
| `npm run test:coverage` | Run with coverage; thresholds live in `vitest.config.ts` |
| `npm run test:e2e` | Boot a throwaway ScyllaDB container and run `e2e/` against it (needs Docker) |
| `npm run coverage:badge` | Refresh the README coverage badge |
| `npx eslint src/` | Lint |
| `npx prettier --write src/` | Format |

The unit tests mock `cassandra-driver`, so no database is needed for the normal loop. Only
`npm run test:e2e` talks to a real Scylla, and it tears the container down when it finishes.

## Where things live

```
src/decorators/    @Entity, @Column, @PrimaryKeyColumn, @Index — write static metadata onto the class
src/model/         BaseModel, which every entity extends
src/repository/    Repository (CRUD), query operators, named parameters, type validation
src/schema/        SchemaBuilder — CREATE TABLE / schema sync
src/data-source/   DataSource — connection handling on top of cassandra-driver
```

Tests sit next to the code they cover, in `src/**/__tests__/*.test.ts`.

## Code style

- 4-space indent, single quotes, 120-column lines, trailing commas, semicolons — `.prettierrc.json` is the source of truth, so run Prettier rather than hand-formatting.
- PascalCase filenames for classes, a barrel `index.ts` per module directory.
- Entity properties use snake_case, matching the database column names.
- Every generated statement is plain CQL 3 — no Scylla-only extensions, because Apache Cassandra is a supported target too.
- Never interpolate user input into a CQL string. Column and table names are validated against the entity metadata; values go in as positional `?` parameters.
- Comments explain *why*, not *what*. If the code needs a comment to say what it does, the code is the thing to fix.

## Pull requests

1. Branch off `main` (`feat/…`, `fix/…`, `docs/…`).
2. Add tests. New behaviour without a test will be asked for one; coverage thresholds are enforced in CI.
3. Run `npm run build`, `npm test` and `npx eslint src/` before pushing.
4. If the change is user-visible, add a line to the `Unreleased` section of `CHANGELOG.md`.
5. Write commit messages in the imperative mood, describing the effect: `Validate and parameterize LIMIT, enforce test coverage`.
6. Open the PR against `main` and describe what changed and why. CI runs build, tests, coverage and the badge check on every PR.

Small, focused PRs get reviewed faster than large ones. If you are planning something big — a new
pattern, a new dependency, an API change — open an issue first so we can agree on the shape before
you spend the evening on it.

## Reporting bugs

Open an issue with the Scyllorm version, the Node.js version, whether you are on ScyllaDB or
Cassandra, a minimal entity and query that reproduces it, and what you expected instead. The
generated CQL (or the driver error) helps a lot.

## Security

Do not open a public issue for a vulnerability. Use GitHub's private
[security advisory](https://github.com/tfmf/scyllorm/security/advisories/new) form instead.

## Licence

Contributions are made under the [MIT Licence](LICENSE) that covers the project.
