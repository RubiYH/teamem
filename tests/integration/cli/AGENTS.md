<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# cli

## Purpose

Tests for CLI command handling: the dispatcher (`bun run teamem <subcommand>`), git hook installation, and CLI tool bindings. Verifies end-to-end flows like installing git hooks in a fresh repo and routing subcommand arguments.

## Key Files

| File | Description |
|------|-------------|
| `install-git-hooks.test.ts` | Git hook installer — idempotent templates, backup/restore, hook ordering, worktree support |
| `teamem-cli.test.ts` | CLI dispatcher routing and subcommand execution |

## For AI Agents

### Working In This Directory

- Tests use `spawnSync('bun', ['run', CLI_PATH, ...args], { cwd, env, ... })` to invoke the CLI.
- Git tests spawn real git in temp directories via `spawnSync('git', args, { cwd, ... })`.
- Hook installer reads/writes actual shell scripts to `.git/hooks/` (or `core.hooksPath`).
- PWD environment variable must match cwd for install-git-hooks.ts's pwd-based heuristics to work.

### Testing Requirements

- Verify installer is idempotent: running twice does NOT create duplicate backups.
- Confirm hooks are executable (`chmod +x`), contain teamem markers, and preserve user edits.
- Test git worktree edge case: resolve `core.hooksPath` first before falling back to `.git/hooks/`.
- Verify CLI subcommand routing: `install-git-hooks` paths to the right handler.

### Common Patterns

- Helper `runBun(cwd, args)` wraps spawnSync with proper PWD and git env vars.
- Helper `gitInit(cwd)` initializes a test repo.
- `mkdtempSync` + `rmSync` manage test directories; on cleanup, verify no stale files.
- Hook content is read via `readFileSync` and checked for marker strings (e.g., `# teamem-managed-hook`).

## Dependencies

### Internal

- `src/cli/teamem.ts` (CLI dispatcher)
- `src/cli/install-git-hooks.ts` (hook installation logic)

### External

- `bun:test`
- `node:fs`, `node:path`, `node:os` (file + dir ops)
- `node:child_process` (spawnSync)

<!-- MANUAL: -->
