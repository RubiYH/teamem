<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-01 | Updated: 2026-05-13 -->

# tests

## Purpose

Bun test suite organized by scope: `unit/` for pure logic, `integration/` for tool + DB behavior, `scenario/` for multi-agent simulations, plus e2e, perf, plugin, migration, security, smoke, load, chaos, helpers, and fixtures.

Run all suites with `bun test` or `bun run test`. Test files import from `bun:test`.

## Key Files

None at this level — all tests live in the subdirectories below.

## Subdirectories

| Directory      | Purpose                                                               |
| -------------- | --------------------------------------------------------------------- |
| `unit/`        | Deterministic unit tests for pure logic — see `unit/AGENTS.md`        |
| `integration/` | Tool + DB + server integration tests — see `integration/AGENTS.md`    |
| `e2e/`         | Cross-process/runtime roundtrips — see `e2e/AGENTS.md`                |
| `scenario/`    | Multi-agent workflow simulations — see `scenario/AGENTS.md`           |
| `perf/`        | Latency benchmarks and long-poll saturation checks — see `perf/AGENTS.md` |
| `plugin/`      | Claude plugin bundle/script behavior tests — see `plugin/AGENTS.md`   |
| `migration/`   | SQLite migration compatibility tests — see `migration/AGENTS.md`      |
| `security/`    | Auth, JWT, and access-control tests — see `security/AGENTS.md`        |
| `smoke/`       | Manual and automated smoke coverage — see `smoke/AGENTS.md`           |
| `load/`        | Load-oriented tests — see `load/AGENTS.md`                            |
| `chaos/`       | Failure-injection tests — see `chaos/AGENTS.md`                       |
| `helpers/`     | Shared test helpers — see `helpers/AGENTS.md`                         |
| `fixtures/`    | JSON event fixtures (valid + invalid) — see `fixtures/AGENTS.md`      |

## For AI Agents

### Working In This Directory

- Tests import `describe`/`it`/`expect` explicitly from `bun:test`; follow that style.
- Database-backed tests follow the same setup pattern: `createSqliteClient(':memory:')` → `runMigration(db, '<repo>/src/infra/db/migrations/001_init.sql')` → `new SqliteEventStore(db)` → `createTeamemTools({ db, store })`.
- Migration paths are resolved with `join(process.cwd(), 'src/infra/db/migrations/001_init.sql')` — tests assume the repo root is the working dir.

### Testing Requirements

- Mirror the source tree: a file at `src/foo/bar.ts` typically has a test at `tests/unit/foo/bar.test.ts`.
- Prefer in-memory SQLite over mocking for store-level tests.
- Scenario tests double as smoke perf checks (`scenario/team-workflow.test.ts` asserts < 100 ms).

### Common Patterns

- Helper `setup()` per test file builds a fresh `{ db, store, tools }` triple.
- Event factories like `sampleEvent(overrides)` and `event(overrides)` keep envelope boilerplate out of test bodies.
- Fixtures are loaded with `JSON.parse(readFileSync(...))` from `tests/fixtures/`.

## Dependencies

### Internal

- `src/` — every layer is exercised somewhere here.

### External

- `bun:test`
- `node:fs`, `node:path`

<!-- MANUAL: -->
