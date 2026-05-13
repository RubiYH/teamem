<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-01 | Updated: 2026-05-13 -->

# hooks (tests)

## Purpose

Unit tests for the Claude Code hook adapter and the `DeferredQueue` retry behavior in `src/hooks/`.

## Key Files

| File                       | Description                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `hook-adapters.test.ts`    | Verifies Claude `onSessionStart`/`onPreCommit` and that failed publishes land in the deferred queue                                       |

## For AI Agents

### Working In This Directory

- Tests build a real in-memory tools instance via `setup()` rather than mocking `TeamemTools` — that exercises the real validation path on every adapter call.
- The deferred-queue test uses a deliberately-broken payload (`{ broken: true }`) to drive `publishWithRetry` into the defer branch; do NOT rely on this exact shape if you tighten validation — re-pick a payload that still fails.
- A constant `ctx` literal at the top of the file documents the canonical `HookContext` shape (`repo_id`, `principal`, `actor`, `delegation`).

### Testing Requirements

- New adapter lifecycle methods need both a happy-path test AND, where applicable, a deferred-retry test.

### Common Patterns

- `as const` on the `ctx` object so TypeScript narrows the field types.
- Direct `expect(adapter.method(...).ok).toBe(true)` style — minimal nesting.

## Dependencies

### Internal

- `src/hooks/{claude,core}.ts`
- `src/server/tools/index.ts`
- `src/infra/db/{sqlite-client,sqlite-event-store}.ts`

### External

- `bun:test`, `node:path`

<!-- MANUAL: -->
