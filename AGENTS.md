<!-- Updated: 2026-06-08 -->

# teamem

Teamem is an MCP-based team memory and coordination system. The repo contains
the Bun/Hono/SQLite runtime, the Claude Code marketplace plugin, the npm
bootstrapper CLI, Teamem Cloud web control plane, public docs, internal design
notes, and tests.

This top-level file is the repo-wide Codex contract. Detailed implementation
rules belong in the nearest child `AGENTS.md`; read that file before changing
anything under a child directory.

## Repo Map

| Path | Owner surface |
| --- | --- |
| `src/` | Runtime source: domain, infra, server tools, bridge, channel, CLI, setup, hooks |
| `plugin/` | Claude Code marketplace plugin, commands, hooks, scripts, bundled runtime |
| `packages/bootstrapper-cli/` | npm package `@rubiyh05/teamem` and the `teamem` binary |
| `apps/web/` | Teamem Cloud Next.js control plane |
| `tests/` | Unit, integration, scenario, plugin, smoke, migration, security, perf, load, chaos |
| `docs/` | Public user/operator docs |
| `.docs/` | Internal plans, ADRs, operations notes, and architecture notes |
| `data/` | Local SQLite/runtime data; generated DBs are not normal source |
| `.github/` | CI and ownership metadata |

## Must Follow

- Use Bun for repo scripts. The runtime imports `bun:sqlite`; plain Node cannot
  run the server/test surface correctly.
- Use `bun run <script>` for package scripts. Important root scripts include
  `test`, `typecheck`, `lint`, `format`, `format:check`, `build`,
  `build:plugin`, `server`, `bridge`, `channel`, `setup`, and `teamem`.
- Keep NodeNext ESM imports explicit: local relative imports in TypeScript must
  use `.js` extensions.
- Keep diffs small, reviewable, and scoped to the requested change. Prefer
  deletion, existing utilities, and existing patterns before adding new layers.
- Do not add dependencies unless explicitly requested or clearly justified by
  the existing design.
- Do not commit real `.env` files, credentials, generated runtime databases, or
  local `.teamem/`, `.omc/`, `.omx/`, `dist/`, cache, or build artifacts unless
  the relevant child `AGENTS.md` says that artifact is committed.
- If a change affects user-facing commands, setup, deployment, env vars, plugin
  behavior, or operator workflows, update the relevant docs/env examples in the
  same change or record the known docs gap.
- Respect the product boundary: Teamem Cloud is the web control plane; the
  Teamem runtime/plugin remain the runtime identity and coordination surfaces.

## Development

- Read the nearest child `AGENTS.md` first. Deeper files override this file for
  their subtree.
- Source architecture is layered: pure domain logic stays under `src/domain/`;
  SQLite/projection side effects stay under `src/infra/`; MCP/tool wiring stays
  under `src/server/` and `src/bridge/`.
- Event-sourced state changes must preserve the append-plus-projection contract:
  emit validated events, append them through the store, and keep projection
  rebuild behavior in sync with inline projection updates.
- Bridge `responseSchema` entries are documentation-only. When tool output
  shapes change, update the bridge schema by hand and add/adjust tests because
  runtime validation will not catch schema drift.
- Plugin runtime code is distributed through committed bundles under
  `plugin/lib/`. Changes to `src/bridge/`, `src/channel/`, or `src/cli/setup.ts`
  require `bun run build:plugin` and committed fresh bundles.

## Deploy And Release

- Root runtime deploy changes must keep `.env.example`, Docker/deploy docs, and
  quickstart docs aligned.
- Teamem Cloud web changes must keep `apps/web/.env.example`,
  `docs/deploy/teamem-cloud.md`, public README references, and i18n strings in
  sync when the user/operator contract changes.
- Plugin marketplace changes must follow `plugin/AGENTS.md`: bump the mirrored
  plugin and marketplace versions when marketplace users need a new artifact.
- Bootstrapper CLI changes must follow `packages/bootstrapper-cli/AGENTS.md`:
  preserve plugin ownership of MCP JSON, pinned marketplace identifiers, scoped
  installs, dry-run behavior, and first-class uninstall cleanup.
- Do not edit Claude Code installed plugin cache files directly. Change source,
  bump the plugin version when needed, clear/reinstall cache only as an explicit
  local validation step, and never commit cache artifacts.

## Verification

- Verify with the smallest gate that proves the change, then broaden when the
  touched surface requires it.
- Standard repo gates before declaring broad runtime work complete:

```bash
bun test
bun run typecheck
bun run lint
bun run build:plugin
```

- Run `bun run build:plugin` after any change to plugin bundle sources:
  `src/bridge/`, `src/channel/`, or `src/cli/setup.ts`.
- Run `bun run web:smoke:deploy` for Teamem Cloud deploy/env changes when the
  required env is available; otherwise state the env gap.
- Run package-local gates from the relevant child `AGENTS.md` for
  `packages/bootstrapper-cli/`, `apps/web/`, `plugin/`, and specialized test
  directories.

## Review guidelines

Use this section for Codex GitHub review. Keep findings focused on high-confidence
P0/P1 issues that would block merge or create serious regression risk. Do not
comment on style-only nits, speculative rewrites, low-impact typos, or
preference-level refactors.

- Prioritize correctness, security, and data-safety defects: auth/JWT and room
  code access control, scope claim ownership and release semantics, event
  append/projection parity, idempotency and retry behavior, secrets or PII
  leakage, SQLite migration compatibility, and the Teamem Cloud versus runtime
  identity boundary.
- For plugin and marketplace changes, verify shipped artifact parity. Source
  changes under `src/bridge/`, `src/channel/`, or `src/cli/setup.ts` require
  regenerated `plugin/lib/*.js` bundles. Marketplace-user behavior changes need
  mirrored version bumps in `plugin/.claude-plugin/plugin.json` and
  `.claude-plugin/marketplace.json`.
- For Teamem Cloud web changes, verify the deploy/env contract. Required env
  keys must stay aligned with `apps/web/.env.example` and
  `docs/deploy/teamem-cloud.md`; browser `NEXT_PUBLIC_*` values are build-time
  values; web account identity must not be treated as Teamem runtime member
  identity.
- For tests and CI, flag green-but-weak evidence when the touched surface needs
  a narrower gate. Plugin live smokes must remain opt-in and skip cleanly
  without live env. CI-safe tests must not depend on ignored or generated
  artifacts, local caches, installed Claude plugin state, or production secrets.
- Do not require deploy credentials, live Supabase/PostHog credentials, or live
  Claude plugin smoke gates for ordinary static PR review unless the PR claims
  live/deploy coverage.
- Treat docs typos as P1 only when they change commands, env vars, security
  guidance, setup steps, release behavior, or operator workflow. Otherwise avoid
  typo-only review comments.
- When a finding depends on a child `AGENTS.md`, cite the closest applicable
  file-specific contract in the review comment.

## Commits

- Before committing, run `git status --short`, inspect staged and unstaged
  diffs, and stage only files that belong to the requested change. Leave
  unrelated user or generated changes alone.
- Before committing, review the full candidate diff against the applicable
  AGENTS hierarchy and determine whether repo guidance changed. When commands,
  env vars, release behavior, setup, verification, or agent workflow changed,
  update the nearest relevant `AGENTS.md` files and include those AGENTS updates
  in the same commit as the behavior/docs change they describe.
- Commit messages must use the Lore protocol with an intent line first and
  useful trailers such as `Constraint:`, `Rejected:`, `Confidence:`,
  `Scope-risk:`, `Directive:`, `Tested:`, and `Not-tested:`.
- Every agent-authored commit must include:
  `Co-authored-by: OmX <omx@oh-my-codex.dev>`.
- Use inline `git commit -m ...` message arguments so local hooks can inspect
  the message before commit execution.
- Do not use `--no-verify`, do not push, and do not amend an existing commit
  unless the user explicitly asks.

## Always Avoid

- Do not silently widen scope, rewrite unrelated history, or revert dirty files
  you did not create.
- Do not hardcode `.git/hooks/`; respect `core.hooksPath` and worktrees.
- Do not reintroduce human slash-command surfaces for claim cleanup unless a
  product decision explicitly asks for them; claim cleanup stays MCP/hook-driven.
- Do not blur web account identity with Teamem runtime member identity.
- Do not treat green tests as proof for cross-cutting lifecycle work without at
  least one review pass over contracts, docs, and operator paths.
