<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# plugin

## Purpose

Unit tests for plugin metadata and agent configuration. Tests here verify agent frontmatter (YAML), tool allowlists, and plugin command definitions without requiring a full Claude Code environment.

## Key Files

| File | Description |
|------|-------------|
| `*.test.ts` | Verifies plugin prompt/metadata contracts that do not require a Claude Code harness |

## For AI Agents

### Working In This Directory

- Plugin unit tests are light — they read markdown files and verify frontmatter structure.
- Each test documents a constraint on agent behavior.
- Do not test Claude Code's interpretation of frontmatter; test only that the files are well-formed.

### Testing Requirements

- Every state-mutating agent markdown file in `plugin/agents/` should have a corresponding frontmatter test.
- Verify that `disallowedTools` lists all state-mutating operations (claim, release, post_message, record_decision).
- Verify that `tools` field lists appropriate tools (no unnecessary tools, no Bash for security).

### Common Patterns

- **Frontmatter parsing**: regex match `^---\n([\s\S]*?)\n---` to extract YAML, then parse line-by-line.
- **Field verification**: `fm['tools']`, `fm['disallowedTools']`, `fm['model']` — check presence and content.
- **Constraint tests**: `expect(fm['tools']).not.toMatch(/\bBash\b/)` to ensure Bash is not allowed.

## Dependencies

### Internal

- `plugin/agents/` — agent definitions being tested

### External

- `bun:test` — test runner
- `node:fs` — read agent markdown files

<!-- MANUAL: When adding a new agent, create a corresponding frontmatter test immediately. Agents that mutate state must have claim_scope and release_scope in disallowedTools unless that is their explicit responsibility. -->
