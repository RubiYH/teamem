<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# setup

## Purpose

Setup entry point dispatcher (plan-named, phase 3). Routes subcommands to the appropriate CLI handler: `bun run setup` or `bun run setup [subcommand]` delegates to `src/cli/setup.ts` for create/join flows, or to `src/cli/space.ts` for management commands (leave, kick, disband, rotate-code, list). Handles flag parsing and non-interactive (`--json`) vs. interactive flows.

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Main dispatcher; parses subcommand and flags; spawns `src/cli/setup.ts` or `src/cli/space.ts` via `spawn('bun', ['run', script, ...args])`; handles no-TTY mode validation for non-interactive flows |
| `credentials.ts` | (Legacy — can be removed in cleanup) Credential management utilities |

## Subdirectories

None.

## For AI Agents

### Working In This Directory

- **Subcommand routing**:
  - No subcommand or empty string → interactive setup (delegate to `src/cli/setup.ts`)
  - `create`, `join` → flag parsing and optional `--json` delegation
  - `leave`, `kick`, `disband`, `rotate-code`, `list` → delegate to `src/cli/space.ts`
  - `--json` or `--check` → pass through to `src/cli/setup.ts`
- **Flag parsing**: simple positional and `--key value` extraction; `parseFlags()` returns an object with `positional` and `flags` keys.
- **Non-TTY validation**: when stdin is not a TTY (CI, automation), require all mandatory flags (e.g., `create` requires `--member-name` and `--server-url`); reject with clear error if missing.
- **Spawn delegation**: use `spawn('bun', ['run', script, ...args], { stdio: 'inherit', cwd: REPO_ROOT })` so the child inherits stdio and outputs directly to the terminal; exit with the child's code.
- **No process.exit in child handlers**: fallthrough from interactive create/join to `src/cli/setup.ts` so a single implementation handles both `bun run setup` and E2E test spawns.

### Testing Requirements

- Unit tests in `tests/unit/cli/` cover flag parsing and subcommand routing.
- E2E tests in `tests/e2e/` spawn this dispatcher with `--json` args and verify subcommand delegation.
- Test non-TTY validation (set `stdin.isTTY = false` and verify required flags are enforced).
- Test create/join flag delegation (passing `--member-name`, `--server-url`, `--code` etc. should delegate to `src/cli/setup.ts` with `--json`).

### Common Patterns

- **Execscript pattern**: returns `never` (kills the process), so all paths from it are unreachable. Type-safe way to express "this function always exits".
- **TTY detection**: `process.stdin.isTTY` determines if we can prompt interactively.
- **REPO_ROOT resolution**: use `import.meta.url` + `fileURLToPath` + `dirname` to locate the project root (ESM).

## Dependencies

### Internal

None — this is a pure router.

### External

- `node:child_process` — `spawn()` for subcommand delegation
- `node:path`, `node:url` — path resolution

<!-- MANUAL: -->
