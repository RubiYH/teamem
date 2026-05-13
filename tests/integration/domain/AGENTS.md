<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# domain

## Purpose

Tests for cross-cutting domain logic: claim identity probing (repo_id canonicalization, symlink handling, branch detection). These are lightweight integration tests that exercise filesystem and git operations without the full server stack.

## Key Files

| File | Description |
|------|-------------|
| `claim-identity-probe.test.ts` | Repo-relative path + branch detection from git working dir, symlink support |

## For AI Agents

### Working In This Directory

- Tests use `probeClaimIdentity(filepath)` from `src/domain/claim-identity-probe.js`.
- Spawn real git via `spawnSync('git', args, { cwd, env })` to initialize test repos.
- Create test files and symlinks in temp dirs, then probe their git identity.
- Assert returned `repo_id`, `path`, `branch`, `head_sha`.

### Testing Requirements

- Verify repo_id is extracted from `.git/config origin.url` and canonicalized (github.com/org/repo format).
- Verify path is repo-relative (not absolute).
- Verify branch name comes from `git rev-parse --abbrev-ref HEAD`.
- Verify symlinks are dereferenced and resolved correctly within tree.
- Verify head_sha is 40 lowercase hex chars.

### Common Patterns

- Helper `git(cwd, args)` wraps spawnSync with proper env setup.
- Use `mkdtemp` + `rm` for temp repo lifecycle.
- Write test files and commit them before probing.
- Test edge case: symlinks pointing to tracked files in the same repo.

## Dependencies

### Internal

- `src/domain/claim-identity-probe.ts` (main logic)

### External

- `bun:test`
- `node:fs/promises` (file I/O)
- `node:child_process` (spawnSync for git)
- `node:path`

<!-- MANUAL: -->
