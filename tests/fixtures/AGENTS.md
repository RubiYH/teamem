<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-01 | Updated: 2026-05-01 -->

# fixtures

## Purpose

Static JSON test data. Currently only event-envelope fixtures (valid + invalid) used by the validator unit tests.

## Subdirectories

| Directory  | Purpose                                                                  |
| ---------- | ------------------------------------------------------------------------ |
| `events/`  | Valid + invalid event envelope fixtures — see `events/AGENTS.md`         |

## For AI Agents

### Working In This Directory

- Fixtures are pure data — no JS/TS files here.
- Reference fixtures by basename in tests (the loader appends `.json`).

### Testing Requirements

- N/A — fixtures support tests elsewhere.

### Common Patterns

- One subdirectory per fixture domain; within each, a `valid/` and `invalid/` split mirroring the test pattern.

## Dependencies

### Internal

- Read by `tests/unit/events/validate.test.ts`.

### External

- None.

<!-- MANUAL: -->
