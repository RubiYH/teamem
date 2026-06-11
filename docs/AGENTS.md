<!-- Parent: ../AGENTS.md -->
<!-- Created: 2026-05-26 -->

# docs

## Purpose

Public-facing documentation for Teamem users and operators. These files explain
quickstart, setup, Claude Code plugin usage, deployment, troubleshooting, and
runtime behavior. Keep public docs concise and aligned with shipped CLI/plugin
behavior.

## For AI Agents

### Working In This Directory

- Public docs are user/operator guidance, not internal design scratchpads. Put
  private design history, ADRs, and implementation plans under `.docs/`.
- When docs mention a command, verify the command exists in the relevant surface:
  `package.json` scripts, `src/cli/teamem.ts`, `packages/bootstrapper-cli`,
  or `plugin/commands/*.md`.
- When docs mention env vars, keep the matching `.env.example` file aligned:
  root `.env.example` for the runtime, `apps/web/.env.example` for Teamem Cloud.
- Keep Cloud/control-plane wording separate from runtime/plugin identity. Teamem
  Cloud provisions and manages setup; the runtime/plugin own coordination.
- Do not document `~/.claude/plugins/cache/...` edits as a normal workflow.

### Deployment Docs

- Runtime/self-host docs must stay aligned with root `.env.example`,
  Docker/Docker Compose behavior, `TEAMEM_PUBLIC_URL`, and provisioning-token
  requirements.
- Teamem Cloud docs must stay aligned with `apps/web/.env.example`,
  `apps/web/db/migrations/`, `apps/web/scripts/deploy-smoke.ts`, and the
  `bun run web:smoke:deploy` gate.
- If a deploy flow changes ordering, migrations, auth tables, PostHog config,
  OAuth config, or runtime provisioning semantics, update the deploy runbook in
  the same change.

### Verification

- Run `bun run format:check` for docs-only formatting checks when practical.
- For command or deploy docs, prefer a targeted smoke or dry-run from the owning
  surface before claiming the docs are current.

<!-- MANUAL: -->
