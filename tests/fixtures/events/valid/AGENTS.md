<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-01 | Updated: 2026-05-05 -->

# valid (event fixtures)

## Purpose

Event envelopes that MUST pass `validateEvent`. Each file represents a canonical, well-formed example of one `event_type`.

## Key Files

| File                    | Description                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `task-started.json`     | Minimal valid `task_started` event including optional `refs.branch` and `confidence: 0.9`  |

## For AI Agents

### Working In This Directory

- Add one fixture per `event_type` you want documented as the canonical happy-path payload.
- Include the optional fields (`refs`, `confidence`) at least once across the corpus so `validateEvent`'s optional-field branches stay covered.
- Keep `event_id` distinct across fixtures (the validator allows duplicates, but readability suffers in logs).

### Testing Requirements

- A new fixture here should be referenced by at least one test in `tests/unit/events/`.

### Common Patterns

- 2-space JSON indentation (Prettier formats these too).
- ISO-8601 UTC timestamps.

## Dependencies

### Internal

- Tested by `tests/unit/events/validate.test.ts`.

### External

- None.

<!-- MANUAL: -->

## Update 2026-05-05 — claim-lifecycle v2 fixtures

The Key Files table is incomplete. The fixture set has grown substantially. Lifecycle v2 added at minimum:

| File                                | Description                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| `claim-paused.json`                 | Branch-switch pause annotation.                                                      |
| `claim-resumed.json`                | Branch-return resume.                                                                |
| `claim-force-released.json`         | Escape-hatch force-release event.                                                    |
| `claim-expired.json`                | TTL expiry transition (only fires for `auto_release_mode='ttl'`).                    |
| `scope-released-via-git.json`       | Post-commit-driven release with git evidence (commit SHA, paths_with_status).        |

### Required sibling test

Every fixture here is exercised by `tests/unit/events/validate.test.ts` — the test enumerates `EVENT_TYPES` and asserts a valid fixture exists for each. Adding to `EVENT_TYPES` without adding a fixture here will fail that test.

### Schema enum parity

A valid fixture only validates if the matching `event_type` is in `event-envelope.schema.json`'s `event_type.enum`. We hit this exact bug with `claim_expired` (fixture existed, enum missing → silent schema-validation failure for any consumer). When adding a fixture, grep the schema enum first.
