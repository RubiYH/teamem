<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# domain

## Purpose

Unit tests for domain logic: claim identity canonicalization, git evidence evaluation, git diff parsing, and claim lifecycle pure logic. Tests here are deterministic and have no I/O.

## Key Files

| File | Description |
|------|-------------|
| `claim-identity-core.test.ts` | `canonicalizeRepoId(remoteUrl)` — git remote URL normalization (HTTPS, SSH, trailing slashes) |
| `git-evidence.test.ts` | `evaluateRelease(claim, observedSha, porcelainDirty, branch)` — validates release conditions (HEAD advanced, clean, branch match) |
| `git-diff-tree-parser.test.ts` | `parseGitDiffTree(rawOutput)` — parses `git diff-tree` output into file paths and change types |
| `claim-lifecycle.test.ts` | Pure logic for claim state transitions and duration calculations |

## For AI Agents

### Working In This Directory

- Domain tests are pure functions — no database, no network, no file I/O.
- Each function is tested with multiple inputs covering happy paths, edge cases, and error conditions.
- Git-related tests use mocked git output (strings); do not invoke git binaries.

### Testing Requirements

- Test repo ID canonicalization with various URL formats (trailing slashes, SSH vs HTTPS, capitalization).
- Test release evaluation with all combinations of conditions (HEAD advanced + clean + branch match, etc.).
- Test git diff-tree parsing with various change types (added, modified, renamed, deleted).

### Common Patterns

- **Canonicalization**: `canonicalizeRepoId('https://github.com/Org/Repo/')` should equal `canonicalizeRepoId('git@github.com:org/repo')` (normalized form).
- **Release decision**: `evaluateRelease(claim, sha, dirty, branch)` returns `{ decision: 'release' | 'still_held', reason?: '...' }`.
- **Diff parsing**: `parseGitDiffTree(output)` returns `{ paths: [...], changes: { [path]: 'M' | 'A' | ... } }`.

## Dependencies

### Internal

- `src/domain/claim-identity-core.js` — repo ID canonicalization
- `src/domain/git-evidence.js` — release evaluation
- `src/domain/git-diff-tree-parser.js` — diff parsing
- `src/domain/claim-lifecycle.js` — claim logic

### External

- `bun:test` — test runner

<!-- MANUAL: Domain logic is the foundation for all server behavior. Changes to canonicalization, release logic, or diff parsing require comprehensive test updates. -->
