<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# smoke

## Purpose

Smoke tests and end-to-end walkthroughs that verify complete user journeys and document manual test procedures. This directory contains both markdown runbooks (human-readable manual tests) and automated test files that serve as sanity checks for the full claim-lifecycle feature.

## Key Files

| File | Description |
|------|-------------|
| `claim-lifecycle-v2.md` | Reproducible 8-story manual smoke walkthrough for claim-lifecycle v2 — covers acquire, release, pause/resume, branch switch, and conflict handling; slash command shapes must stay in lockstep with `plugin/commands/*.md` |

## For AI Agents

### Working In This Directory

- Smoke tests are sanity checks; they verify that basic happy-path workflows function.
- Markdown walkthroughs (`.md` files) are human-readable; they document expected hook, MCP, and slash-command behavior.
- Keep markdown walkthroughs up-to-date with the actual plugin commands and MCP-first flows.
- Automated tests in this directory (if any) should be straightforward assertions, not complex logic.

### Testing Requirements

- Markdown walkthroughs are documentation, not runnable tests — they guide manual QA before releases.
- Verify that all slash commands referenced in the walkthrough exist in `plugin/commands/`; MCP tool references such as `teamem.list_claims` must exist in `src/server/tool-registry.ts` and `src/bridge/tool-bindings.ts`.
- Each story in the walkthrough should have a clear "Expected:" section that describes the UX.

### Common Patterns

- **Story structure**: setup → action → expected output → next story.
- **Slash command reference**: `/teamem:<name>` maps to `plugin/commands/<name>.md`.
- **Claim state verification**: use `teamem.list_claims` output to assert claim lifecycle state (active, paused, released).
- **Branch context**: document which branch or environment each story uses.

## Dependencies

### Internal

- `plugin/commands/*.md` — slash command definitions (referenced in walkthroughs)
- `src/domain/claim-lifecycle*.ts` — claim lifecycle implementation
- `src/cli/teamem.ts` — CLI command dispatcher

### External

- None (markdown files are static documentation)

<!-- MANUAL: Walkthroughs in this directory MUST stay in sync with plugin/commands/ slash command definitions. When a new slash command is added, update claim-lifecycle-v2.md or create a new walkthrough. -->
