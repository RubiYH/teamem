<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-01 | Updated: 2026-05-13 -->

# tools (integration)

## Purpose

End-to-end tests for the `teamem.*` tool surface against a real (in-memory) SQLite store + applied migrations. Covers happy paths, edge cases, claim conflict handling, discussions, findings, permissions, disputes, space rules, and other tool contracts.

## Key Files

| File                                      | Description                                                                                          |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `teamem-tools.test.ts`                    | Registry contains the public tool names; `publishEvent` + `getUpdates` happy path; `claimScope` rejects duplicate active claims with `scope_conflict` |
| `teamem-tools-edge-cases.test.ts`         | Invalid publish payload → `INVALID_EVENT`; duplicate idempotency key is a no-op success; empty contract state returns `[]` |
| `conflict-signals.test.ts`                | Empty placeholder retained from the older conflict-signal integration path; active conflict scoring coverage lives under `tests/unit/conflicts/` and claim lifecycle integration tests |

## For AI Agents

### Working In This Directory

- Each file's `setup()` returns a fresh `{ db, tools }` (or `{ db, tools, registry }`); never share state across tests.
- When adding a new tool, add at minimum: a happy-path test in `teamem-tools.test.ts` AND an edge-case test in `teamem-tools-edge-cases.test.ts`.
- Exact conflict-engine reason strings are covered in `tests/unit/conflicts/`; keep those tests in sync if you rename a reason in `src/domain/conflicts/engine.ts`.

### Testing Requirements

- The `expect(result.ok).toBe(true)` followed by `if (result.ok) { ... }` pattern is the canonical way to narrow a `ToolResponse` discriminated union — keep that style.

### Common Patterns

- Synthetic event IDs prefixed `evt-<purpose>-<n>` and idempotency keys `idem-<purpose>-<n>` for deterministic test data.
- Claim lifecycle tests use overlapping paths to verify `scope_conflict` responses and release behavior.

## Dependencies

### Internal

- `src/server/{tools,tool-registry,errors,types}.ts`
- `src/infra/db/`
- `src/domain/conflicts/`

### External

- `bun:test`, `node:path`

<!-- MANUAL: -->

## Update 2026-05-05 — corrections + claim-lifecycle v2 patterns

### Stale references

- Imports are from `bun:test`; keep new tests on Bun's runner.
- The Key Files table only lists 3 files; the directory now has 20+. Discover with `ls`.

### Lifecycle-v2 test files added (PRD #27, slices #28–#37)

| File                                                  | Covers                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `claim-scope-branch.test.ts`                          | branch-aware claim payload + repo_id canonicalization                   |
| `claim-scope-toctou.test.ts`                          | TOCTOU between read and write inside the txn; idempotent self-overlap   |
| `claim-scope-manual-modes.test.ts`                    | three modes; `lease_seconds` rejection on non-ttl                       |
| `release-scope-via-git-rename-delete.test.ts`         | rename/delete release semantics; multi-path lookup via `json_each`      |
| `pause-resume.test.ts`                                | branch-switch pause/resume with bulk UPDATE                             |
| `force-release.test.ts`                               | escape hatch + concurrent guard                                         |
| `list-claims.test.ts`                                 | paused-as-annotation read-time projection                               |
| `fetch-unread-notifications-race.test.ts`             | concurrent SELECT+UPDATE inside `.immediate()` for exactly-once         |
| `idempotency-collision.test.ts` (sibling, server/)     | fresh-after-terminal recovery for both `ttl` and `on_commit`            |

### Concurrency test pattern

Tools that rely on `db.transaction(...).immediate()` need a regression that fires concurrent calls via `Promise.all`. Pattern: seed identical state, fire two calls in parallel, assert (a) at most one event of the relevant type lands, and (b) projection state matches a single-call invocation.

```ts
const [r1, r2] = await Promise.all([call(args), call(args)]);
const evCount = db.query(
  "SELECT COUNT(*) AS c FROM events WHERE event_type = ?1"
).get(eventType) as { c: number };
expect(evCount.c).toBe(1); // exactly-once
```

### Multi-path claim regression

When a tool filters claims by path (e.g. `releaseScopeViaGit`), regression-test against multi-path claims where the committed file is `paths[1+]`. The `claims.path` column only stores `paths[0]`; queries filtering `path = ?` silently miss multi-path claims. See `release-scope-via-git-rename-delete.test.ts:"OMC review: multi-path claim releases when commit touches paths[1+]"` for the canonical pattern.

### `expires_at` semantics in tests (PRD §150)

Default mode is `on_commit` → `expires_at` IS NULL. Tests that need a non-null `expires_at` (e.g. TTL expiry, refresh-on-self-overlap) MUST pass `auto_release_mode: 'ttl'` explicitly. Tests that pass `lease_seconds` without `auto_release_mode: 'ttl'` will be REJECTED by the server with `INVALID_PAYLOAD`.
