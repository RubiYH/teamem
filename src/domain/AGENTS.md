<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-01 | Updated: 2026-05-05 -->

# domain

## Purpose

Pure domain logic with **no I/O dependencies**. Holds the canonical event taxonomy + envelope contract (`events/`) and the conflict scoring engine that maps weighted signals to a `policy_mode` band (`conflicts/`).

Anything in this directory should be deterministic and unit-testable without a database.

## Key Files

None at this level — see subdirectories.

## Subdirectories

| Directory    | Purpose                                                                         |
| ------------ | ------------------------------------------------------------------------------- |
| `events/`    | Event types, validator, JSON Schema, schema-version helpers — see `events/AGENTS.md` |
| `conflicts/` | Conflict signal types, weights config, `evaluateConflict()` engine — see `conflicts/AGENTS.md` |

## For AI Agents

### Working In This Directory

- **Do not import from `../infra/`, `../server/`, or `../hooks/`.** This directory is the leaf of the dependency graph.
- Add new event types in two places: `events/types.ts` (the `EVENT_TYPES` tuple) AND `events/schemas/event-envelope.schema.json` (the `event_type.enum`). Keep them in lock-step.
- Conflict thresholds are configured by env (see `conflicts/config.ts`) — don't hard-code thresholds in callers.

### Testing Requirements

- Tests live under `tests/unit/events/` and `tests/unit/conflicts/`.
- Validator tests should cover at least one valid and one invalid fixture (see `tests/fixtures/events/`).
- Conflict engine tests should pin advisory / soft_gate / hard_gate transitions.

### Common Patterns

- Plain `type` aliases (no classes) for value shapes; classes only for errors (`EventValidationError`).
- Validators accumulate `ValidationIssue[]` and throw a single error containing all issues — useful for surfacing all problems at once instead of fail-fast.

## Dependencies

### Internal

None.

### External

None — pure TypeScript.

<!-- MANUAL: -->

## Update 2026-05-05 — pure modules added for claim-lifecycle v2

The "events + conflicts" subdirectory list is incomplete. PRD #27 added the following deep modules — all pure, all leaf in the dependency graph:

| File                          | Description                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `claim-identity-core.ts`      | `canonicalizeRepoId(remoteUrl)` and `canonicalizePath(absPath, repoToplevel)`. THIS IS THE CANONICAL implementation — bash equivalents in `plugin/scripts/gate-claim.sh`, `plugin/git-hooks/post-commit`, `plugin/git-hooks/post-checkout` MUST stay byte-equivalent (each carries a `MUST stay in lockstep` comment). Drift = different `repo_id` between server and client. |
| `claim-identity-probe.ts`     | I/O wrapper around `claim-identity-core.ts` — realpath + git rev-parse + submodule + no-remote fallback.     |
| `git-evidence.ts`             | `evaluateRelease(claim, observedHeadSha, observedPorcelainDirty, observedBranch, commitStatus?)` returns `release` / `still_held` / `branch_mismatch`. Includes SHA shape gate (`/^[0-9a-f]{40}$/` — rejects garbage). |
| `claim-lifecycle.ts`          | Pure state machine: active ↔ paused ↔ released, plus `ttl_expired → released`. Table-driven, no I/O.         |
| `git-diff-tree-parser.ts`     | Parses `git diff-tree --name-status -M50% -r HEAD` into structured `{ status, path, old_path? }` entries.   |
| `ids.ts`                      | ULID-backed `newEventId`, `newClaimId`, `newIdempotencyKey`. Use these — not raw `Date.now()`.              |

### Five-place update rule for new event types

When you add a new `event_type`, ALL of these must update or rebuild silently corrupts state:

1. `events/types.ts` — `EVENT_TYPES` tuple
2. `events/schemas/event-envelope.schema.json` — `event_type.enum` array
3. `tests/fixtures/events/valid/<event-type>.json` — canonical happy-path fixture
4. `tests/fixtures/events/invalid/<event-type>-<failure>.json` — at least one schema-rejection fixture
5. `src/infra/projections/apply-event.ts` — handler that mirrors any inline UPDATE done by the emitting tool

Skipping #5 is the silent failure: live operation works (tools UPDATE projections inline) but `rebuildProjections` replays through `applyProjectionUpdate` and silently drops events with no handler → claims table inconsistent after a rebuild.

### Pure-module discipline still applies

These additions remain side-effect-free. `claim-identity-probe.ts` is the I/O boundary — it uses `child_process.spawnSync` for `git rev-parse` etc. and is the only domain file that touches the filesystem. Keep new logic in `*-core.ts` style files; gate I/O behind probes.
