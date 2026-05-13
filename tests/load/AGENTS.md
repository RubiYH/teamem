<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# load

## Purpose

Load and throughput benchmarks that measure performance under concurrent request volume. Tests here populate large datasets (e.g., 1000 members in a space) and assert p50 latency budgets to catch performance regressions.

## Key Files

| File | Description |
|------|-------------|
| `auth-overhead.bench.ts` | AC22 — 1000 members in a space; measures p50 latency delta of JWT auth vs. unauth baseline; asserts < 5ms overhead |

## For AI Agents

### Working In This Directory

- Load tests use `bun:test` but are explicitly named `*.bench.ts` to signal they measure performance, not just correctness.
- Populate the database with realistic scale (e.g., 1000 members) to measure auth overhead accurately.
- Record all request latencies, sort them, and compute `percentile(sorted, 50)` to get p50.
- Assert that the measured latency delta is within budget (e.g., `< 5ms`); fail the test if exceeded.

### Testing Requirements

- Each test measures a specific performance dimension (e.g., auth overhead, claim throughput, briefing latency).
- Baselines and deltas must be computed from the same test run; do not compare against prior runs.
- Use `it.skip()` or `.skip` to disable load tests during normal test runs if they are slow (not currently done; all run together).
- Document the budget assumption in a comment (AC reference, expected max latency).

### Common Patterns

- **Percentile helper**: `percentile(sorted: number[], p: number)` — returns the p-th percentile value.
- **Timing**: wrap request loop with `performance.now()` calls; accumulate deltas in a `number[]` array.
- **Sort and slice**: `timings.sort((a, b) => a - b)` then `percentile(timings, 50)` for p50.
- **Budget assertion**: `expect(p50Delta).toBeLessThan(5)` for 5ms budget.

## Dependencies

### Internal

- `src/infra/db/sqlite-client.js`, `src/infra/db/sqlite-event-store.js` — DB setup
- `src/server/tools/index.js`, `src/server/routes.js`, `src/server/auth.js` — HTTP server
- `tests/helpers/migrations.js` — database migration runner

### External

- `bun:test` — test runner
- `hono` — HTTP server framework

<!-- MANUAL: -->
