<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-01 | Updated: 2026-05-13 -->

# src

## Purpose

Runtime source for Teamem. Core layers are pure domain logic (`domain/`), I/O adapters (`infra/`), server tool surface (`server/`), local MCP bridge (`bridge/`), Claude Code channel runtime (`channel/`), setup/CLI entry points (`setup/`, `cli/`), and Claude Code hook adapters (`hooks/`). The split enforces a one-way dependency rule: `domain` knows nothing about SQLite, HTTP, MCP, or hooks; `infra` knows nothing about MCP; `server` is the layer that wires domain + infra together for tool calls.

## Key Files

| File        | Description                                                       |
| ----------- | ----------------------------------------------------------------- |
| `index.ts`  | `bootstrap()` entrypoint that returns `{ status, config }`        |
| `config.ts` | `loadConfig(env)` reads `NODE_ENV`, `TEAMEM_*` vars with defaults |

## Subdirectories

| Directory  | Purpose                                                                 |
| ---------- | ----------------------------------------------------------------------- |
| `domain/`  | Event types, validation, conflict scoring, IDs, git/path helpers (pure) — see `domain/AGENTS.md` |
| `infra/`   | SQLite client, event store, migrations, projections — see `infra/AGENTS.md` |
| `server/`  | Hono HTTP server, tool registry, and `teamem.*` tool handlers — see `server/AGENTS.md` |
| `bridge/`  | Local stdio MCP bridge and CLI fallback to the server — see `bridge/AGENTS.md` |
| `channel/` | Claude Code Channels runtime for realtime notification delivery — see `channel/AGENTS.md` |
| `cli/`     | Setup, hooks, reset, and operational CLI implementations — see `cli/AGENTS.md` |
| `setup/`   | `bun run setup` dispatcher for create/join/space management flows — see `setup/AGENTS.md` |
| `hooks/`   | Claude Code hook adapter + retry queue — see `hooks/AGENTS.md`          |

## For AI Agents

### Working In This Directory

- Respect layering: a file in `domain/` should never import from `infra/`, `server/`, or `hooks/`.
- Local relative imports MUST use `.js` extensions (NodeNext ESM); e.g. `import { ... } from './config.js'`.
- The default `repo_id` is `teamem-poc`; the default `dbUrl` is `file:./data/teamem.db`.
- The string keys for env overrides live in `config.ts` and `domain/conflicts/config.ts` — keep `TEAMEM_*` naming consistent.

### Testing Requirements

- Unit tests under `tests/unit/` mirror this directory's tree.
- New domain logic should ship with a deterministic unit test (no DB, no I/O).
- New infra/server code should have an integration test that exercises a real in-memory SQLite.

### Common Patterns

- **Pure functions** in `domain/` (e.g. `evaluateConflict`, `validateEvent`).
- **Factory functions** for stateful services (`createTeamemTools`, `createClaudeHookAdapter`).
- **Result types**: `ToolResponse<T> = { ok: true, data: T } | { ok: false, error: {...} }` — see `server/types.ts`.

## Dependencies

### Internal

None outside `src/` — this directory is the source-of-truth library.

### External

- `bun:sqlite` (used inside `infra/db/`)
- Node built-ins (`node:fs`, `node:path`)

<!-- MANUAL: -->
