<!-- Parent: ../AGENTS.md -->
<!-- Created: 2026-06-01 | Updated: 2026-06-02 -->

# plugin-e2e-module

## Purpose

In-repo proof of concept for a future reusable TypeScript testing module for
Claude Code plugins. The module is shaped like a package, but v1 remains a
Teamem proving ground and is not published to npm or extracted to a separate
repository.

This directory must stay generic. It may know about Claude Code plugin
structure, Claude CLI launch behavior, hook and MCP proxying, PTYs, artifacts,
and redaction. It must not import Teamem runtime code, hardcode Teamem command
names, or assume Teamem-specific environment contracts. Teamem live consumer
tests belong under `tests/plugin/`.

## Key Files

| File | Description |
|------|-------------|
| `README.md` | Current PoC status, public API sketch, live gates, unsupported surfaces, extraction criteria |
| `src/index.ts` | Public module exports |
| `src/tester.ts` | `createClaudePluginTester(...)`, boot checks, headless prompt execution, run result assembly |
| `src/interactive.ts` | Real TTY interactive execution, session controls, transcripts, close behavior |
| `src/instrumentation.ts` | Source-plugin copy and hook/MCP config rewriting |
| `src/hook-proxy-runner.cjs` | Hook tracing proxy launched by rewritten hook commands |
| `src/mcp-proxy-runner.cjs` | stdio JSON-RPC MCP tracing proxy |
| `src/node-pty-bridge.cjs` | Node bridge for running `@lydell/node-pty` from Bun tests/runtime |
| `src/artifacts.ts` | Artifact directory layout, curated env capture, cleanup, redaction helpers |
| `src/mcp-traces.ts` / `src/hook-traces.ts` | Trace readers and assertion helpers |
| `fixtures/fake-plugin/` | Generic fake Claude plugin fixture used by module self-tests |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `src/` | Generic module implementation; keep Teamem-specific knowledge out |
| `tests/` | Module self-tests using the fake plugin fixture and controlled process/PTY runners |
| `fixtures/` | Generic fixtures for module behavior; fixtures should not depend on Teamem runtime state |

## For AI Agents

### Working In This Directory

- Preserve the source-plugin vs instrumented-plugin boundary. The source plugin
  is caller-owned and must not be mutated; instrumentation happens only on a
  copied workspace managed by the tester.
- Keep runtime launch paths structured, not shell-string based. Claude commands,
  hook shell configuration, MCP child commands, and PTY launches should remain
  explicit command/argument arrays where the local design supports it.
- Keep `channels` and `developmentChannels` generic. The module may accept
  Channel server names, render Claude launch flags, proxy selected Channel MCP
  servers, and capture raw `notifications/claude/channel` traces, but
  product-specific routing semantics, recipient assertions, credential shapes,
  and readiness policy belong in consumer tests such as `tests/plugin/`.
- Keep headless mode aligned with the verified Claude Code print contract:
  `claude -p --output-format stream-json --verbose --include-hook-events`, with
  the prompt passed as a CLI argument.
- Keep interactive mode as a real TTY surface using `@lydell/node-pty`. Under
  Bun, the default adapter routes through `src/node-pty-bridge.cjs`.
- Send interactive enter as carriage return (`\r`). Prior live Claude evidence
  showed newline submission was not reliable for the TTY path.
- Treat MCP and hook proxy traces as the v1 correctness base. Assistant text and
  terminal prose can be useful debugging evidence, but should not be the only
  proof that a plugin command ran.
- MCP instrumentation is generic. Use `McpInstrumentationOptions.include`,
  `exclude`, `mode`, and caller-supplied `envPassthroughKeys`; do not bake
  product-specific environment names such as Teamem credential or Space keys
  into this module.
- `mode: "disable-non-included"` should leave non-included MCP servers disabled
  in the per-run config while proxied included servers preserve structured
  command/argument/env data. Keep config materialization structural rather than
  shell-string based.
- Keep `readMcpTraces(...)` strict by default. Use transient-tolerant reads only
  for live polling while a proxy may be writing partial artifacts.
- Keep redaction safe by default. `redaction.mode: "off"` must require
  `CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED=1`, and artifacts must not dump the full
  process environment.
- Do not set `CLAUDE_PLUGIN_DATA` by default. The module should observe Claude
  Code's plugin runtime metadata, not fabricate it.
- Do not add npm packaging, generated Claude settings files, custom reporters,
  custom test-runner matchers, `assistantReport`, marketplace-installed plugin
  targets, or multi-plugin support without a new design decision.
- When Claude Code CLI behavior, flags, permission modes, or plugin docs are in
  question, check official Claude Code documentation before changing contracts.

### Testing Requirements

- For module changes, run the focused self-test first:

```bash
bun test plugin-e2e-module/tests
```

- For interactive/PTY changes, include:

```bash
bun test plugin-e2e-module/tests/interactive-pty.test.ts
node --check plugin-e2e-module/src/node-pty-bridge.cjs
```

- For MCP proxy or trace-reader changes, include:

```bash
bun test plugin-e2e-module/tests/mcp-instrumentation.test.ts
node --check plugin-e2e-module/src/mcp-proxy-runner.cjs
```

- For public API, README, or TypeScript changes, also run:

```bash
bun run typecheck
bun run lint
```

- Live Teamem consumer smokes are outside this directory and stay opt-in under
  `tests/plugin/`. Do not make module self-tests require authenticated Claude,
  Teamem runtime credentials, or live model budget.

### Common Patterns

- Module self-tests use fake Claude runners, fake PTY adapters, and the generic
  fake plugin fixture to prove behavior without Teamem runtime state.
- Teamem-specific assertions, environment gates, and live runtime prerequisites
  are consumers of this module and should remain under `tests/plugin/`.
- Channel assertions follow the same boundary: module tests should prove
  structured Channel launch options and raw MCP notification capture with fake
  plugins; Teamem Channels delivery matrices and transcript expectations stay in
  Teamem consumer tests.
- Consumer suites that need product env in proxied MCP children should define
  their own `envPassthroughKeys` constants beside their tests. The module should
  only provide the generic mechanism and safe default process keys.
- Assertion helpers should be runner-neutral methods or plain functions, not
  Vitest/Bun/Jest custom matcher integrations in v1.
- Artifact paths should be included in typed errors and assertion failures so
  failed live runs can be inspected directly.

## Dependencies

### Internal

- `plugin/` as the first real Teamem consumer target, loaded through
  `--plugin-dir` from `tests/plugin/`.
- `tests/plugin/teamem-*-smoke.test.ts` for Teamem live smoke consumers and
  Teamem-specific helper code.
- `.scratch/plugin-e2e-module/PRD.md` and related issue files for local planning
  context. `.scratch/` is ignored by git; do not assume changes there will be
  committed.

### External

- `claude` CLI with authenticated Claude Code for live runs and plugin
  validation when explicitly requested.
- `@lydell/node-pty` for real interactive TTY execution.
- `bun:test` for module self-tests.
- Node.js for the CJS hook/MCP/PTY bridge scripts.

<!-- MANUAL: -->
