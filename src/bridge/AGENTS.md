<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-13 -->

# bridge

## Purpose

Local stdio MCP bridge that translates registered `teamem.*` tool calls into authenticated HTTPS POSTs to the server. The bridge runs as a subprocess in Claude Code (or via CLI `bun run dist/bridge.js call`), loads credentials from `~/.teamem/credentials.json`, and routes tool invocations to the remote server. It handles JWT expiry warnings, space disambiguation, and graceful error handling for disbanding or expired sessions.

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Stdio MCP server entry point; handles `ListTools` and `CallTool` requests; supports both MCP mode and argv CLI fallback (`call <tool> --space <id> --json {...}`) |
| `tool-bindings.ts` | `teamem.*` tool bindings mapping names to Zod input schemas and HTTP POST handlers; **response schemas are documentation-only and not runtime-validated** (see invariants below) |
| `http-client.ts` | HTTP transport layer; handles auth headers, 410 space-disbanded detection, and structured error unwrapping (409 scope_conflict responses are returned verbatim, not as HTTP errors) |
| `credentials.ts` | Credential file I/O and space resolution; accepts space by ULID, label, `--space` flag, or `TEAMEM_SPACE` env; implements Codex F11 ambiguous-label error and SessionExpiredError |

## Subdirectories

None.

## For AI Agents

### Working In This Directory

- **Credential resolution priority**: `--space` flag → `TEAMEM_SPACE` env → `default_space_id` in credentials.json. Unsubstituted placeholders (e.g. `${user_config.space}`) are treated as "not provided".
- **Persona isolation for local E2E**: `TEAMEM_CREDENTIALS` overrides the default credentials path. Use it only for Alice/Bob testing on one machine; on distinct computers, the normal default `~/.teamem/credentials.json` is correct. Without separate paths on one machine, `/teamem-setup` in one Claude Code session overwrites the default persona and the other session silently acts as the wrong member.
- **Space by label** (issue #20 — Codex F11): when the user passes a label that matches multiple entries, throw `AmbiguousSpaceLabelError` listing the ULIDs so the user can disambiguate with `--space <id>`.
- **JWT expiry warning**: emit a 7-day advance warning to stderr if `jwt_exp` is within 7 days; user can re-run setup to refresh.
- **Tool binding contract**: `responseSchema` in `tool-bindings.ts` is documentation-only — it is NOT runtime-validated. The `inputSchema.parse()` enforces shape on input only. When tool output shapes change (e.g., adding a nullable field), update the schema by hand and keep it accurate for downstream SDKs (e.g., Claude Code plugin manifest).
- **409 scope_conflict handling** (AC-NEW-7): the server returns 409 with a structured `{ ok: false, error: { code: "scope_conflict", ... } }` body on conflicts. The HTTP client unwraps this as a successful 200-like response so MCP consumers get the typed error, not a generic HTTP 409.
- **Space disbanding**: on 410 Gone, throw `SpaceDisbandedError` (not process.exit) so the CLI entry point can decide whether to log and exit. Library code must never call `process.exit` directly (breaks testability).

### Testing Requirements

- Unit tests live in `tests/unit/bridge/` (HTTP client, credential loading, space resolution).
- Integration tests in `tests/integration/bridge/` and `tests/e2e/bridge-server-roundtrip.test.ts` exercise real bridge paths and verify tool binding contracts.
- Add new bindings to `TOOL_BINDINGS` alongside their `inputSchema` and `responseSchema` definitions.
- Test credential files with `loadCredentials()` — verify both valid and malformed JSON gracefully handle errors.

### Common Patterns

- **Argv mode vs MCP mode**: detect `process.argv[2] === 'call'` to route to `runArgvMode()` (CLI fallback, see `.docs/integrations/cli-fallback.md`); otherwise `startBridge()` for stdio MCP.
- **Error unwrapping**: `callServer()` unwraps the double envelope (transport response containing tool response) so callers get the server's `{ ok, data }` shape directly.
- **Identity stamping**: `stampIdentity()` defensively strips any `space_id` and `principal` from the request body (server extracts them from the JWT, per plan §2 req 6).

## Dependencies

### Internal

- `src/bridge/credentials.js` (credential loading and space resolution)
- `src/bridge/http-client.js` (authenticated HTTPS POST transport)
- `src/bridge/tool-bindings.js` (tool definitions with Zod schemas)

### External

- `@modelcontextprotocol/sdk` — MCP stdio server and type definitions
- `zod` ^3.23 — input schema validation
- `node:fs/promises`, `node:path`, `node:os` — file and path utilities

<!-- MANUAL: -->
