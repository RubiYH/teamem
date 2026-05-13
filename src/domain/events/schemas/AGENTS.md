<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-01 | Updated: 2026-05-13 -->

# schemas

## Purpose

JSON Schema (Draft 2020-12) definitions for the Teamem event envelope. These schemas are the language-agnostic contract for any external producer/consumer; the TypeScript validator in `../validate.ts` is the runtime enforcer.

## Key Files

| File                            | Description                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `event-envelope.schema.json`    | Draft 2020-12 schema with `$id` `https://teamem.dev/schemas/event-envelope.schema.json`; pins `schema_version: "1.0"` and the `event_type` enum |

## For AI Agents

### Working In This Directory

- The schema currently has `additionalProperties: true` — payload-specific constraints are not fully enforced at schema level. Per-event-type payload schemas are tracked in internal planning docs under `.docs/`.
- The `event_type.enum` array MUST exactly match `EVENT_TYPES` in `../types.ts` — the runtime validator and the JSON Schema must agree.
- The schema declares `timestamp` as `format: date-time`, but `../validate.ts` does not currently enforce this — be aware of the gap if you rely on the schema alone.
- The `$id` URL is the canonical identifier; do not change it without coordinating downstream consumers.

### Testing Requirements

- No tests live here; schema usage is covered by `tests/unit/events/validate.test.ts` indirectly (via fixtures).
- If you add a per-payload schema, add a fixture pair under `tests/fixtures/events/`.

### Common Patterns

- Single-file schema per envelope/payload type.
- `$schema` references the Draft 2020-12 metaschema URL.

## Dependencies

### Internal

- Mirrored by `../types.ts` (`EVENT_TYPES`, required field list).

### External

- JSON Schema Draft 2020-12 spec.

<!-- MANUAL: -->

## Update 2026-05-05 — schema-vs-types-vs-fixtures parity

The `event_type.enum` in `event-envelope.schema.json` is one of FIVE places that must update together when adding a new event type. Skipping any one is silent drift — typically caught only by adversarial review:

1. `../types.ts` — `EVENT_TYPES` tuple
2. `event-envelope.schema.json` — `event_type.enum` (THIS file)
3. `tests/fixtures/events/valid/<event-type>.json` — happy path
4. `tests/fixtures/events/invalid/<event-type>-<failure>.json` — at least one schema-rejection case
5. `src/infra/projections/apply-event.ts` — handler mirroring the emitting tool's inline UPDATE

### Real bug we hit (this session)

`claim_expired` was in `EVENT_TYPES` and had a valid fixture, but was missing from this enum. The fixture's schema-validation test would have rejected the event. We caught this only on the third codex review pass. **Always grep this enum against `EVENT_TYPES` before merging changes that touch event types.**

### Per-event payload schemas remain a TODO

The `additionalProperties: true` note above is still accurate. Conditional payload schemas (using `if`/`then` keyed on `event_type`) have been added piecemeal for a few high-leverage events (e.g. `dispute_opened` requires `opened_by + target_principal`). Follow that pattern for new payload contracts; do not rewrite the envelope to a fully-strict schema in one sweep — too much existing data assumes `additionalProperties: true`.
