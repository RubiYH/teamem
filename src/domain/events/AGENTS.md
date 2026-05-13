<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-01 | Updated: 2026-05-01 -->

# events

## Purpose

The canonical event contract for Teamem: a frozen list of `EVENT_TYPES`, the `TeamemEvent` envelope shape, schema-version helpers, and a runtime validator. Every state-changing operation in the system flows through `validateEvent`.

## Key Files

| File                  | Description                                                                            |
| --------------------- | -------------------------------------------------------------------------------------- |
| `types.ts`            | `EVENT_TYPES` tuple, `EventType`, `EventScope`, `EventRefs`, `TeamemEvent` envelope    |
| `validate.ts`         | `validateEvent(input)` runtime guard; collects all issues then throws `EventValidationError` |
| `errors.ts`           | `EventValidationError` + `ValidationIssue` (`missing` / `invalid_type` / `invalid_value`) |
| `schema-version.ts`   | `EVENT_SCHEMA_VERSION = '1.0'` + `isSupportedSchemaVersion(version)`                   |

## Subdirectories

| Directory   | Purpose                                                                  |
| ----------- | ------------------------------------------------------------------------ |
| `schemas/`  | JSON Schema files for the event envelope — see `schemas/AGENTS.md`       |

## For AI Agents

### Working In This Directory

- Adding a new event type requires updating **three** places in lock-step:
  1. `types.ts` — append to the `EVENT_TYPES` tuple.
  2. `schemas/event-envelope.schema.json` — append to `event_type.enum`.
  3. `tests/fixtures/events/valid/` — add at least one valid fixture.
- The validator's `requiredStringFields` list is the source of truth for required envelope fields; do not validate those fields ad-hoc elsewhere.
- `confidence` is optional but bounded — the validator enforces `0 <= confidence <= 1`.
- The current validator does **not** validate the `timestamp` ISO-8601 format (the JSON Schema does, but `validate.ts` skips it). If you add format validation, mirror it in both files.

### Testing Requirements

- `tests/unit/events/validate.test.ts` covers a valid + invalid fixture pair.
- Use `tests/fixtures/events/{valid,invalid}/*.json` — don't inline event JSON in test files.

### Common Patterns

- Validator collects all issues (`issues.push(...)`) then throws a single `EventValidationError` containing the array — surfaces every problem at once.
- The envelope uses `schema_version: '1.0'` as a literal type for compile-time pinning.

## Dependencies

### Internal

None — leaf of the dependency graph.

### External

None.

<!-- MANUAL: -->
