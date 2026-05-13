<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# bridge

## Purpose

Tests for the stdio MCP bridge credential handling: file I/O, space selection priority (flag > env > default), and multi-principal credential store lifecycle. The bridge is the per-teammate local entry point that talks to the shared server; these tests verify it picks the correct space credentials.

## Key Files

| File | Description |
|------|-------------|
| `credentials-pick.test.ts` | AC12 — priority resolution (--space flag > TEAMEM_SPACE env > default_space_id) |

## For AI Agents

### Working In This Directory

- Tests use `loadCredentials()`, `pickEntry()`, `saveCredentials()` from `src/bridge/credentials.js`.
- Credentials are stored in `~/.teamem/credentials.json` (real) or temp dir during tests via `mkdtemp`.
- Each entry carries `space_id`, `label`, `member_name`, `jwt`, `jwt_exp`, `server_url`.
- Tests use file I/O assertions (`existsSync`, `readFileSync`) and JSON parse/stringify.

### Testing Requirements

- Verify credential file versioning and schema (`version: 1`).
- Test priority order: --space flag always wins, then TEAMEM_SPACE env, then default_space_id.
- Ensure pruned entries are removed; saved credentials maintain JSON integrity.
- Handle missing space_id gracefully (throw `UnknownSpaceError`).

### Common Patterns

- Helper `BASE_ENTRY` and `ENTRY_B` are reusable credential templates.
- `beforeEach` / `afterEach` use `mkdtemp` + `rm` for temp dir lifecycle.
- Pass override object `{ flag?, env?, creds }` to `pickEntry()` to test priority.

## Dependencies

### Internal

- `src/bridge/credentials.js` (credential management)

### External

- `bun:test`
- `node:fs/promises` (file I/O)
- `node:path`

<!-- MANUAL: -->
