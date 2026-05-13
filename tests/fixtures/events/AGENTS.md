<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-01 | Updated: 2026-05-01 -->

# events (fixtures)

## Purpose

JSON event-envelope fixtures used by `tests/unit/events/validate.test.ts`. The `valid/` and `invalid/` split makes the test intent obvious.

## Subdirectories

| Directory   | Purpose                                                                              |
| ----------- | ------------------------------------------------------------------------------------ |
| `valid/`    | Envelopes that MUST pass `validateEvent` — see `valid/AGENTS.md`                     |
| `invalid/`  | Envelopes that MUST fail `validateEvent` with a specific `ValidationIssue` — see `invalid/AGENTS.md` |

## For AI Agents

### Working In This Directory

- Each new event type added to `EVENT_TYPES` should ship at least one valid fixture here and ideally one invalid counterpart.
- Filenames use kebab-case derived from the `event_type` (e.g. `task-started.json`).

### Testing Requirements

- Fixtures are loaded by `readFileSync` + `JSON.parse` — keep them syntactically valid JSON regardless of category.

### Common Patterns

- Stable event IDs prefixed `01JTEST...` for ULID-shaped readability.
- Standard `principal: "alice"`, `actor: "codex-cli/session-1"`, `delegation: "alice->codex"` triple across fixtures.

## Dependencies

### Internal

- Loaded by `tests/unit/events/validate.test.ts`.

### External

- None.

<!-- MANUAL: -->
