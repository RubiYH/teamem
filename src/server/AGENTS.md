<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-01 | Updated: 2026-05-13 -->

# server

## Purpose

The server-side `teamem.*` tool surface that agents call to publish events, read updates, claim/release scope, record decisions, coordinate discussions, manage space memory, and summarize state. This layer is the **only** place where `domain/` and `infra/` are wired together.

HTTP transport is implemented in `src/server/index.ts`; the local MCP stdio bridge in `src/bridge/` forwards tool calls to those HTTP endpoints.

## Key Files

| File               | Description                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `tool-registry.ts` | `TOOL_NAMES` tuple + `createToolRegistry(tools)` mapping public `teamem.*` names to handler functions |
| `index.ts`         | Hono HTTP server exposing `/tools/:name`, health, and migration-backed SQLite startup              |
| `errors.ts`        | `toolError(code, message, details?)` helper that returns a `ToolError`                            |
| `types.ts`         | `ToolResult<T>`, `ToolError`, `ToolResponse<T>` discriminated-union types                         |

## Subdirectories

| Directory | Purpose                                                                              |
| --------- | ------------------------------------------------------------------------------------ |
| `tools/`  | `createTeamemTools({ db, store })` factory containing the tool handlers — see `tools/AGENTS.md` |

## For AI Agents

### Working In This Directory

- All tool handlers return `ToolResponse<T>` — never throw. Wrap exceptions with `toolError(code, message, { reason })`.
- New tools must be added in three places: the handler in `tools/index.ts`, an entry in `TOOL_NAMES` in `tool-registry.ts`, and the registry mapping below it.
- The tool name format is `teamem.<snake_case>` — keep this convention for bridge and slash-command compatibility.
- Handlers receive typed input after validation at the bridge/API boundary. `publishEvent` still validates event envelopes itself because it accepts externally supplied event records.

### Testing Requirements

- Integration tests at `tests/integration/tools/` exercise the full publish → projection → read cycle.
- Add an edge-case test for any new error code (see `teamem-tools-edge-cases.test.ts` for the pattern).

### Common Patterns

- `createTeamemTools` returns an object literal whose keys are camelCase versions of the tool names (`publishEvent`, `getUpdates`, etc.).
- Use ULID-backed helpers from `src/domain/ids.ts` for generated event IDs, claim IDs, and idempotency keys. Do not add new `Date.now()` ID generation.

### Gotchas Learned From Real Runs

- **Always await `/tools/:name` handlers**: `createToolRegistry` mixes sync and async handlers. Hono route adapters must `await handler(body)` before calling `c.json(result)`. Returning an unresolved Promise serializes as `{}`, which made `request_edit_permission` appear blank to the bridge while the async side effects still created/granted the request in SQLite. The symptom is especially confusing: the incumbent sees and grants the request, DB rows show `status='granted'`, but the requester hook logs `request_action:""` and eventually denies. Keep an HTTP integration assertion for async tools that checks the actual response body, not only side effects.

## Dependencies

### Internal

- `../domain/events/` (validation, types)
- `../domain/conflicts/` (engine + weights config)
- `../infra/db/sqlite-event-store.ts`
- `../infra/projections/apply-event.ts`

### External

- `bun:sqlite` (for the `Database` type used in `ToolDeps`)

<!-- MANUAL: -->
