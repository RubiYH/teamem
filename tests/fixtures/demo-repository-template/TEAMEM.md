# Teamem Workspace Rules

## Space Rules

- Keep app behavior changes scoped to `src/`.
- Keep product intent in `features/`.
- Keep operator-facing setup and troubleshooting in `docs/`.
- Record durable coordination notes in this file only when they affect the
  whole demo workspace.

## Briefing Anchors

- `README.md` explains the smoke story and stable target paths.
- `src/app.ts` wires the application state.
- `src/features/collaboration-board.ts` owns the collaboration board behavior.
- `docs/operator-runbook.md` holds run and handoff steps.

## Scope Claim Targets

- Use `src/features/collaboration-board.ts` for feature edits.
- Use `features/collaboration-board.md` for product-scope claims.
- Use `docs/operator-runbook.md` for documentation claims.
- Use `TEAMEM.md` for Space rule claims.

## Git Handoff Targets

- Use branch `feature/briefing-targets` for briefing and scope-claim handoffs.
- Use branch `handoff/demo-history` for git history and launch-cwd handoffs.
- Keep handoff notes grounded in `docs/operator-runbook.md` and
  `features/collaboration-board.md`.

## Decisions And Gotchas

- Decision: keep fixture state deterministic so tests can initialize identical
  git history every run.
- Gotcha: do not use external services or package installs from this workspace.
- Gotcha: this repository is the smoke launch cwd, not the Teamem source root.

## Discussions

- Discuss cross-file changes before editing both `src/` and `docs/`.
- Mention branch names in handoff notes so multi-profile smokes can verify git
  context.
