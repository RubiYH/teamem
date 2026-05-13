<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# bridge

## Purpose

Unit tests for the bridge's core components: credential file loading/saving, JWT expiry validation, CLI argument parsing, and setup/join flow logic. Tests here use `:memory:` SQLite and mock file I/O where possible.

## Key Files

| File | Description |
|------|-------------|
| `credentials.test.ts` | `loadCredentials()`, `saveCredentials()`, `pickEntry()`, `pruneEntry()` — credential file CRUD and JWT expiry checks |
| `credentials-pick-by-label.test.ts` | Picking a credential entry by space label (interactive selection if ambiguous) |
| `setup-name-default.test.ts` | Default member name logic — environment variable, git config, or interactive prompt |

## For AI Agents

### Working In This Directory

- Bridge unit tests focus on pure logic and file I/O, not HTTP or MCP protocol.
- Use `mkdtemp()` for temporary credential files; clean up with `rm()` in afterEach.
- Mock the bridge's credentials file structure as JSON — read/parse/verify shape.
- JWT expiry validation uses `Math.floor(Date.now() / 1000)` for comparison; mock time with explicit timestamps.

### Testing Requirements

- Every credential CRUD operation must be tested: create, read, pick, prune, append.
- Verify that expired credentials are marked as stale via `checkJwtExp()`.
- Test both success and error paths (missing file, parse error, expired token).

### Common Patterns

- **Credential structure**: `CredentialEntry` has `space_id`, `label`, `member_name`, `jwt`, `jwt_exp`, `server_url`.
- **File I/O**: use `writeFile()`, `readFile()` on a temp directory, then `loadCredentials()` to parse.
- **Expiry check**: `checkJwtExp(jwt_exp)` returns `'active'` if not expired, else throws `SessionExpiredError`.
- **Pick by label**: `pickEntry(entries, label)` returns matching entry or throws `UnknownSpaceError`.

## Dependencies

### Internal

- `src/bridge/credentials.js` — credential file handling

### External

- `bun:test` — test runner
- `node:fs/promises` — async file operations
- `node:os` — `tmpdir()`

<!-- MANUAL: -->
