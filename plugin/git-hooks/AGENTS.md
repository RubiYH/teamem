<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# git-hooks

## Purpose

Git lifecycle hooks that integrate Teamem's claim lifecycle with Git operations. Two hooks implement automatic claim management: `post-commit` releases claimed scopes after commits, and `post-checkout` pauses/resumes claims when switching branches (supporting worktree workflows).

## Key Files

| File | Description |
|------|-------------|
| `post-commit` | Fires after every git commit; parses modified paths and calls `teamem.release_scope_via_git` to release auto-release-on-commit claims |
| `post-checkout` | Fires after branch/ref changes; pauses claims on the old branch and resumes claims on the new branch |

## For AI Agents

### Working In This Directory

- **Installation**: Hooks are not committed to `.git/hooks/`. Instead, they are installed by `bun run teamem install-git-hooks` which runs `src/cli/install-git-hooks.ts`. The installer:
  1. Resolves the git hooks directory via `git config core.hooksPath` (fallback to `.git/hooks`)
  2. Uses template substitution to replace `__TEAMEM_PLUGIN_ROOT__` with the absolute plugin path
  3. Marks installed hooks with `# teamem-managed-hook` on line 2 (idempotency marker)
  4. Creates `.teamem-backup` on first install (abort if backup exists and incumbent file is non-teamem)
- **Bash interpreter requirement**: Hooks MUST use `bash "/absolute/path/scripts/X.sh"`, NOT shebang execution. Claude Code's hook runtime fails silently on shebang exec. See root AGENTS.md Gotchas.
- **Repo_id canonicalization**: Both hooks call `canonicalizeRepoId()` to compute the source-of-truth repo ID. This logic MUST stay byte-equivalent with `src/domain/claim-identity-core.ts`. Any drift produces cross-machine claim invisibility.

### Common Patterns

- **post-commit flow**:
  1. Collect git evidence via `git diff-tree` (flags: `-r`, `-M50%`, `--root` for first commit)
  2. Parse modified paths from the diff
  3. Call `teamem.release_scope_via_git` with the commit SHA, branch, and paths
  4. Exits 0 on success or when Teamem is inactive; never blocks the commit
- **post-checkout flow**:
  1. On branch switch, pause all active claims on the old branch
  2. Resume all paused claims on the new branch
  3. Used by worktree workflows where the same repo has multiple working directories
- **Silent failure model**: Both hooks fail silently (Tier-W). If Bun is missing, plugin root unavailable, or bridge bundle not found, the hook logs a warning to stderr but exits 0. The user's git command always completes.

## Dependencies

### Internal

- `../scripts/_common.sh` (shared utilities: `teamem_bridge_js`, `teamem_resolve_repo_id`, `canonicalizeRepoId`)
- `src/domain/claim-identity-core.ts` (canonical repo_id computation; bash equivalents MUST stay in lockstep)
- `src/domain/git-evidence.ts` (SHA validation, release evaluation)
- `src/cli/install-git-hooks.ts` (installer that templates these hooks at install time)

### External

- `git` command (for branch detection, diff-tree parsing, worktree support)
- `bun` CLI (runs the bridge in argv mode)

<!-- MANUAL: -->
