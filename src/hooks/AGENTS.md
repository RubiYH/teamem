<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-01 | Updated: 2026-05-01 -->

# hooks

## Purpose

Lifecycle adapter that wires `teamem.*` tools into Claude Code hook events. The adapter uses `core.ts` for retry-with-defer semantics so a transient publish failure becomes a queued retry rather than a lost event.

## Key Files

| File        | Description                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| `core.ts`   | `HookContext`, `DeferredQueue`, `publishWithRetry`, `flushDeferred` — shared retry kernel            |
| `claude.ts` | `createClaudeHookAdapter(tools, queue?)` — maps `onSessionStart`, `onPreCommit`, `onPostAction`, `onPrePr` |

## For AI Agents

### Working In This Directory

- The adapter is a factory function returning a plain object of lifecycle methods. Don't introduce classes; the closure-based pattern is intentional for testability.
- `publishWithRetry` retries up to **2 times** (3 total attempts) before deferring; change this default cautiously — it affects hook latency.
- A `DeferredQueue` is in-memory and process-local. Persistence across process restarts is **not** implemented and is out of scope for v1.

### Testing Requirements

- Unit tests at `tests/unit/hooks/hook-adapters.test.ts` cover the adapter and the deferred-retry path.
- Use `setup()` to build a real in-memory store rather than mocking `tools` — failure modes are easier to verify against the real implementation.

### Common Patterns

- The adapter has a `flushDeferred()` method that returns `{ flushed: number }` for observability.
- Lifecycle methods take a `HookContext` (`repo_id`, `principal`, `actor`, `delegation`) and forward identity into tool calls.

## Dependencies

### Internal

- `../server/tools/index.ts` (type-only `TeamemTools`)

### External

- None.

<!-- MANUAL: -->
