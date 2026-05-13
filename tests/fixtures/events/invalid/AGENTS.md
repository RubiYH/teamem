<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-01 | Updated: 2026-05-01 -->

# invalid (event fixtures)

## Purpose

Event envelopes that MUST fail `validateEvent` with a specific, deterministic `ValidationIssue`. Each filename names the violation it demonstrates.

## Key Files

| File                              | Description                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| `missing-event-type.json`         | Same as a valid envelope but with `event_type` deleted — produces `{ path: '$.event_type', code: 'missing' }` |

## For AI Agents

### Working In This Directory

- Filename should describe the failure: `missing-<field>.json`, `invalid-type-<field>.json`, `invalid-value-<field>.json`.
- Each fixture's failure should be unambiguous — a single rule violation. Multi-failure fixtures make assertions brittle.
- The matching test should assert both the `path` and the `code` of the first issue.

### Testing Requirements

- A new fixture here needs a corresponding test case in `tests/unit/events/validate.test.ts`.

### Common Patterns

- Mirror the valid fixture as closely as possible — only the broken field differs — so the diff tells the story.

## Dependencies

### Internal

- Tested by `tests/unit/events/validate.test.ts`.

### External

- None.

<!-- MANUAL: -->
