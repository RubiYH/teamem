# Teamem Demo Workspace

This fixture is copied into temporary repositories for live Teamem Claude plugin
smoke tests. It is intentionally small, stable, and realistic enough to support
briefings, scope claims, git handoffs, decisions, gotchas, discussions, and
space-rule prompts.

## Work Targets

- App entrypoint: `src/app.ts`
- Feature module: `src/features/collaboration-board.ts`
- Product note: `features/collaboration-board.md`
- Operator docs: `docs/operator-runbook.md`
- Teamem guidance: `TEAMEM.md`

## Smoke Story

The demo app models a lightweight collaboration board. Future interactive
smokes can ask Claude Code to inspect the app, claim a scoped path, edit a
feature target, discuss handoff notes, and update docs without touching the
Teamem source checkout.
