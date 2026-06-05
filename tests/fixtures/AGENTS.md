<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-01 | Updated: 2026-05-01 -->

# fixtures

## Purpose

Static test data. Event-envelope JSON fixtures support validator unit tests, and
the demo repository template supports plugin smoke workspace tests.

## Subdirectories

| Directory  | Purpose                                                                  |
| ---------- | ------------------------------------------------------------------------ |
| `events/`  | Valid + invalid event envelope fixtures — see `events/AGENTS.md`         |
| `demo-repository-template/` | Static demo app/docs repository copied into plugin smoke temp workspaces |

## For AI Agents

### Working In This Directory

- Fixtures are pure data — do not put executable test helpers here.
- Reference fixtures by basename in tests (the loader appends `.json`).

### Testing Requirements

- N/A — fixtures support tests elsewhere.

### Common Patterns

- One subdirectory per fixture domain. Event fixtures use a `valid/` and
  `invalid/` split; file-tree fixtures should keep stable relative paths for
  copy-based tests.

## Dependencies

### Internal

- Read by `tests/unit/events/validate.test.ts`.
- Copied by plugin smoke workspace helpers.

### External

- None.

<!-- MANUAL: -->
