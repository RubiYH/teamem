<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-01 | Updated: 2026-05-13 -->

# events (tests)

## Purpose

Unit tests for the event envelope runtime validator (`src/domain/events/validate.ts`). Drives both the success and structured-failure paths using JSON fixtures.

## Key Files

| File                   | Description                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `validate.test.ts`     | Loads valid + invalid fixtures from `tests/fixtures/events/` and asserts envelope acceptance / `EventValidationError` issue path |

## For AI Agents

### Working In This Directory

- Use `readFixture('valid' | 'invalid', name)` to load from `tests/fixtures/events/<kind>/<name>.json` — do NOT inline event JSON in test bodies.
- When asserting on `EventValidationError`, both `path` and `code` should be checked (e.g. `'$.event_type'` + `'missing'`) so the issue catalog stays stable.
- Add a fresh fixture pair when introducing a new validation rule rather than parameterizing existing ones.

### Testing Requirements

- Fixtures are referenced by file basename (no extension) — keep the `.json` suffix on disk.

### Common Patterns

- Try/catch instead of `.toThrow()` matchers when the test needs to inspect the thrown error's `issues` array.

## Dependencies

### Internal

- `src/domain/events/validate.ts`
- `src/domain/events/errors.ts`
- `tests/fixtures/events/`

### External

- `bun:test`, `node:fs`, `node:path`

<!-- MANUAL: -->
