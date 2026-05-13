<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# perf

## Purpose

Performance benchmarks that measure latency of critical operations and assert p50 latency budgets. Tests here are named `*.bench.ts` and serve as regression detectors for slow code paths (briefing generation, claim scope evaluation, conflict detection, long-poll saturation).

## Key Files

| File | Description |
|------|-------------|
| `briefing.bench.ts` | Measures `buildBriefing()` p50 latency with varying dataset sizes; asserts budget < 50ms |
| `claim-scope-contention.bench.ts` | Concurrent `claimScope` calls on same space; measures p50 latency under contention |
| `get-updates.bench.ts` | `getUpdates()` retrieval latency; asserts sub-millisecond performance |
| `path-match.bench.ts` | `matchPath()` logic latency for single and multi-path claim matching |
| `long-poll-saturation.test.ts` | Long-poll behavior under high concurrent subscriber count; measures message delivery latency |
| `detect-conflicts.bench.ts` | Conflict detection latency; currently empty (placeholder for future benchmarking) |

## For AI Agents

### Working In This Directory

- Name all performance test files `*.bench.ts` (or `*.test.ts` for integration tests like long-poll-saturation).
- Each benchmark measures a critical operation in isolation — do not mix unrelated operations in one test.
- Record individual operation latencies in a `number[]` array, then compute percentile (p50, p99, etc.).
- Assert both p50 and p99 latencies are within budget; p99 helps catch tail-latency regressions.
- Document the budget assumption and which AC (acceptance criteria) the benchmark addresses.

### Testing Requirements

- Benchmarks run as part of the full `bun test` suite, not separately.
- Each benchmark should populate realistic data scale (e.g., 100+ events, 50+ members) to reflect production behavior.
- Include warm-up iterations to stabilize timing measurements (avoid JIT cold-start artifacts).
- Do NOT use `setTimeout` or `Date.now()` for timing — use `performance.now()` for microsecond precision.

### Common Patterns

- **Timing loop**: Record `const start = performance.now()` before operation, `const elapsed = performance.now() - start` after.
- **Warm-up**: execute operation 10+ times before starting measurement.
- **Percentile computation**: `const p50 = percentile(timings.sort((a, b) => a - b), 50)`.
- **Budget assertion**: `expect(p50).toBeLessThan(50)` for 50ms budget.
- **Tagging**: add comments with budget and AC reference (e.g., `// AC-19: p50 < 50ms`).

## Dependencies

### Internal

- `src/infra/db/sqlite-client.js`, `src/infra/db/sqlite-event-store.js` — DB
- `src/server/tools/briefing.js` — `buildBriefing` (for briefing.bench.ts)
- `src/domain/path-matching.js` — path matching logic (for path-match.bench.ts)
- `tests/helpers/migrations.js` — database setup

### External

- `bun:test` — test runner
- `node:path` — path utilities
- `performance` API (built-in Node.js global)

<!-- MANUAL: -->
