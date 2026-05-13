<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# cli

## Purpose

CLI entry points and subcommand dispatchers. `teamem.ts` routes to `install-git-hooks`, `setup.ts` handles interactive and non-interactive space create/join flows, `space.ts` implements leave/kick/disband/rotate-code/list operations, and `identity-default.ts` suggests member names from git config or OS identity. All commands use the bridge HTTP client for authentication and server communication.

## Key Files

| File | Description |
|------|-------------|
| `teamem.ts` | Main dispatcher; routes to `install-git-hooks` subcommand with `--repo` override and `--uninstall` flag |
| `setup.ts` | Interactive and non-interactive space creation/joining; uses @clack/prompts for UX; handles JWT parsing, credential persistence, coordination preference setup, and multi-space disambiguation |
| `space.ts` | Space management subcommands (leave, kick, disband, rotate-code, list); implements label-confirmation safety gate for destructive operations (disband/wipe) |
| `install-git-hooks.ts` | Git hook installer; resolves `bridge_dir`, installs/uninstalls teamem-managed hooks in `.git/hooks/` or `core.hooksPath`; uses `# teamem-managed-hook` marker for idempotent re-install |
| `identity-default.ts` | Probes `git config user.name`, `$USER`, and OS username; filters out generic shared-host names (root, ubuntu, admin, user, nobody) and suggests a sensible default for the member-name prompt |
| `reset.ts` | Clears local state (credentials, bridge path, git hooks) — used for development/testing cleanup |

## Subdirectories

None.

## For AI Agents

### Working In This Directory

- **Subcommand routing**: `bun run setup` and `bun run teamem` are dispatchers defined in `src/setup/index.ts` and delegate to files in this directory via `spawn('bun', ['run', '<script>', ...args])`.
- **Non-interactive setup** (`--json`): accept a JSON object with `flow` (create|join), `serverUrl`, `memberName`, `roomCode`, `spaceLabel`, and `credPath`; used by E2E tests and automation.
- **Interactive setup**: use @clack/prompts for human-friendly UX; prefill member name with `suggestMemberNameDefault()`; keep the current queue-first coordination default (`auto-skip`) and do not reintroduce `auto-discuss` without restoring a real plugin runtime for it.
- **Space label handling**: server is the source of truth for space label (security review P2#3); fallback to local label, then ULID, only if the server omits it.
- **Coordination preference**: non-fatal to fail application (user can always re-set via `/teamem-coord-pref`); the current setup flow keeps `auto-skip` and skips the POST because that is the DB default.
- **Git hook installer** (issue #2): resolve `bridge_dir` from credentials.json or `TEAMEM_BRIDGE_DIR` env; install via `core.hooksPath` (respects worktrees); use `.teamem-backup` marker on first install; abort with clear error if backup exists and incumbent file is non-teamem.
- **Bridge dir assumption**: F5 design decision — marketplace installs have no source-tree path to resolve; the plugin owns hook lifecycle in v1; do not enforce a local bridge_dir for fresh installs.

### Testing Requirements

- Unit tests in `tests/unit/cli/` cover credential loading, space resolution, and flag parsing.
- E2E tests in `tests/e2e/setup-create.test.ts` and `tests/e2e/setup-join.test.ts` spawn `src/cli/setup.ts` with `--json` args and verify credentials are persisted.
- Test non-interactive flows with `--json` (used by E2E and CI).
- Test interactive flows with mocked @clack/prompts (or manually with TTY).
- Test ambiguous space labels (issue #20 — Codex F11) by creating multiple credentials with the same label and verifying `pickEntry` throws the right error.
- Test git hook installation with worktrees (`.git` is a file, not a directory; use `git config core.hooksPath`).

### Common Patterns

- **Credential persistence**: use `appendEntry()` from `src/bridge/credentials.js`; atomic write with `.tmp` + `sync()` + `rename()`.
- **JWT expiry**: decode `payload.exp` from the JWT (split on `.`, base64url-decode part [1]); convert to seconds since epoch.
- **Flag parsing**: simple `indexOf()` and slice logic (see `parseRepoFlag`, `parseNonInteractive`, `parseFlags`).
- **Process exit codes**: 0 = success, 1 = fatal error, 2 = check mode failure.

## Dependencies

### Internal

- `src/bridge/credentials.js` (credential loading, persistence, space resolution)
- `src/bridge/http-client.js` (HTTP client for remote space creation/join)
- `src/bridge/tool-bindings.js` (tool binding contracts)

### External

- `@clack/prompts` ^0.1 — interactive CLI UX (select, text, intro, outro, note)
- `node:fs`, `node:path`, `node:os`, `node:child_process` — file and process utilities

<!-- MANUAL: -->
