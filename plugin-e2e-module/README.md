# Claude Plugin E2E Module PoC

`plugin-e2e-module` is an in-repo Teamem proving ground for a future reusable
TypeScript package. It is written with package-like boundaries, but v1 is not an
npm package, not a separate repository, and not a stable public dependency.

The reusable module stays generic. It must not import Teamem code, hardcode
Teamem commands, or assume Teamem environment contracts. Teamem-specific live
tests are consumers under `tests/plugin/`.

## Current Status

The PoC is implemented as a local, reusable-looking module with Teamem as its
first real consumer. The delivered branch history is:

- `6e530c0` established the generic module foundation: Claude boot checks,
  source-plugin validation, copied-plugin instrumentation, headless and
  interactive backends, hook and MCP proxies, redacted artifacts, fake-plugin
  self-tests, and the first Teamem live smokes.
- `678a199` aligned headless print mode with Claude Code 2.1.158 by adding
  `--verbose` whenever `--output-format stream-json` is used, and preserved
  failed live-smoke artifacts for diagnosis.
- `e0becd6` locked Teamem live smokes to Claude Code's observed local-plugin
  naming: namespaced slash commands such as `/teamem:whoami` and
  plugin-scoped MCP tools such as `mcp__plugin_teamem_teamem__teamem_whoami`.
- `3585344` proved the interactive TTY path against real Teamem by routing
  Bun through a Node `@lydell/node-pty` bridge, submitting carriage-return
  enters, writing live MCP partial traces, and asserting `tools/call` evidence
  instead of assistant UI prose.
- `6180126` made the interactive Teamem smoke permission mode configurable with
  `TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_PERMISSION_MODE`, while keeping `auto` as
  the default and failing fast for unsupported modes.

The current live Teamem coverage includes plugin load, runtime
`/teamem:whoami`, interactive `/teamem:whoami`, an interactive
permission-mode override smoke, multi-profile durable Teamem flows, and a
focused opt-in Channels live slice in the Teamem consumer tests. Broader command
flows such as reporters, custom matchers, package publishing, and
`assistantReport` remain deferred.

## Public API

The module entrypoint is `plugin-e2e-module/src/index.ts`.

```ts
const tester = createClaudePluginTester({
  pluginDir: '/path/to/source/plugin',
  cwd: '/path/to/test/worktree',
  artifactsDir: '/path/to/artifacts',
  mcp: { include: ['server-name'], mode: 'disable-non-included' }
});

await tester.boot();
const commandPrompt = await tester.slashCommandPrompt('my-command', 'args');
const result = await tester.prompt(commandPrompt, { maxTurns: 3 });
result.expectText(/expected output/);
result.expectHook('SessionStart');
result.expectMcpMethod('tools/call');

const session = await tester.launchInteractive();
await session.submit('/my-plugin:hello');
await session.waitFor(/expected terminal text/);
await session.close();
```

`createClaudePluginTester(...)` owns Claude boot checks, source-plugin
validation, instrumentation, run execution, artifact handling, and cleanup. Its
main methods are:

- `boot()` checks the Claude command, version/features, authentication, source
  plugin structure, and instrumented-plugin readiness.
- `slashCommands()` reads the source plugin slash-command inventory.
- `slashCommandPrompt(commandName, args?)` formats command text for a prompt or
  interactive submission.
- `validatePlugin({ target })` explicitly runs Claude plugin validation against
  the source plugin or instrumented plugin.
- `prompt(prompt, options?)` runs a headless Claude Code print-mode invocation
  with `--plugin-dir <instrumented-plugin> -p --output-format stream-json
  --verbose --include-hook-events --permission-mode auto` by default.
- `launchInteractive(options?)` starts real interactive Claude Code in a TTY and
  returns controls for `type`, `press`, `submit`, `waitFor`, transcripts,
  synthetic events, and `close`.

Run and session objects expose runner-neutral helpers rather than custom test
runner integrations: `expectText(...)`, `expectHook(...)`,
`findHook(...)`, `findMcpMessages(...)`, `expectMcpMethod(...)`,
`rawTranscript()`, `normalizedTranscript()`, and `events()`.

Key options include structured `claudeCommand`, `claudeBin`, `cwd`,
`minClaudeVersion`, `hookShell`, MCP include/exclude filters, artifact cleanup,
redaction, launch pass-through options, generic `channels` /
`developmentChannels`, and
boot/headless/interactive timeouts. Permission mode, allowed/disallowed tools,
setting sources, prompts, model, turns, and budget are pass-throughs to Claude
Code.

`channels` is the generic launch hook for approved Claude Code Channel servers.
Each entry is rendered as structured Claude CLI arguments such as
`--channels plugin:<name>@<marketplace>` while preserving command/argument
arrays for inspection. `developmentChannels` is the launch hook for local
development Channel server sources that require
`--dangerously-load-development-channels server:<name>`; during the Claude Code
Channels research preview, local non-allowlisted `server:` entries use that
development flag instead of a matching `--channels server:<name>` entry. The
module treats Channel servers like launch mechanics and traceable MCP traffic:
it can start Claude with a requested Channel server, proxy the selected Channel
MCP server, and capture raw `notifications/claude/channel` evidence in
artifacts. It does not interpret Teamem principals, Teamem discussion commands,
Space or Sprint routing, or recipient semantics.

## Test Author Workflow

1. Create one tester for one local source plugin directory.
2. Call `boot()` when the test needs explicit setup proof, or let `prompt(...)`
   and `launchInteractive(...)` boot automatically.
3. Use `slashCommandPrompt(...)` to exercise plugin commands as normal Claude
   input, not through a direct slash-command proxy.
4. Assert observable evidence from Claude output, terminal transcripts, hook
   traces, MCP traces, command inventory, and artifact paths.
5. Keep project-specific scheduling and gates outside the module. v1 does not
   own serial/parallel test policy.
6. Preserve artifacts only when needed for debugging; safe redaction is the
   default and unredacted artifacts require
   `CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED=1`.

For Channels consumers, keep the same split: the module can launch Claude with
generic `channels` / `developmentChannels` and preserve raw Channel/MCP traces,
while the consumer test owns domain-specific launch planning, readiness waits,
routing assertions, and failure classification.

## Plugin Boundaries

The `source-plugin` is the caller-provided plugin directory. The module validates
its structure and reads command inventory from it, but does not mutate it.

The `instrumented-plugin` is a copied workspace managed by the tester. Hook
commands and selected MCP server commands are rewritten only in that copy so the
module can trace hook execution and MCP JSON-RPC traffic. The installed Claude
plugin cache is left untouched.

In v1, each tester supports exactly one local source plugin. Marketplace-
installed targets and multiple plugins in one tester are deferred.

## Live Test Gates

Live Claude tests are opt-in because they require local Claude Code
installation, authentication, and may spend model budget.

- `TEAMEM_CLAUDE_PLUGIN_E2E=1` enables headless Teamem live tests.
- `TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E=1` is the additional gate for
  interactive Teamem live tests.
- `TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_PERMISSION_MODE=<mode>` optionally selects
  the Claude Code permission mode for the interactive Teamem live smoke. It
  defaults to `auto` and accepts `default`, `acceptEdits`, `plan`, `auto`,
  `dontAsk`, and `bypassPermissions`.

Run the default interactive permission mode:

```bash
TEAMEM_CLAUDE_PLUGIN_E2E=1 TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E=1 bun test tests/plugin/teamem-interactive-whoami-smoke.test.ts
```

Run an overridden interactive permission mode:

```bash
TEAMEM_CLAUDE_PLUGIN_E2E=1 TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_E2E=1 TEAMEM_CLAUDE_PLUGIN_INTERACTIVE_PERMISSION_MODE=bypassPermissions bun test tests/plugin/teamem-interactive-whoami-smoke.test.ts
```

Current Teamem consumer tiers under `tests/plugin/` prove:

- Headless plugin-load smoke: Claude Code can load the real local Teamem plugin,
  instrument the core `teamem` MCP server, observe `SessionStart`, avoid forcing
  `CLAUDE_PLUGIN_DATA`, and avoid `teamem-channel` noise without requiring a
  Teamem Space.
- Runtime `/teamem:whoami` smoke: when credentials and a runtime Space
  are available, a small Teamem command flow can invoke the core Teamem MCP path
  and return identity-oriented output.
- Interactive `/teamem:whoami` smoke: when credentials and a runtime
  Space are available, real Claude Code can start in a TTY, accept a typed
  slash command, emit terminal transcript evidence, and produce MCP trace
  evidence through the core Teamem proxy. This is gated separately from
  headless tests.
- L5 Channels live smoke: when Alice, Bob, and Carol profile credentials are
  available and every live gate is explicitly enabled, real Claude Code sessions
  launch with the `teamem-channel` development Channel server. The Teamem
  consumer asserts direct-to-Bob, `*` no-Sprint Space broadcast, and `**`
  explicit Space-wide broadcast behavior from channel MCP trace notifications,
  recipient notification logs, and rendered TTY transcript markers. It also
  proves queue-first file-claim conflicts remain Channel-quiet, and that real
  decision and gotcha slash commands render to passive online teammates through
  Channels without Alice sender echo. Durable `read_thread` visibility remains
  separate fallback/runtime-history coverage.

Module self-tests use the generic fake plugin fixture in
`plugin-e2e-module/fixtures/`. They prove module behavior without Teamem runtime
dependencies.

## Unsupported V1 Surfaces

The following are intentionally unsupported in v1:

- npm packaging.
- Separate repository extraction.
- Marketplace-installed target plugins.
- Multiple plugins in one tester.
- Claude Agent SDK as the primary proof backend.
- Direct slash-command proxying.
- Skills/agents inventory helpers.
- Custom reporter or custom Vitest, Bun test, or Jest matchers.
- Generated Claude settings files.
- Full environment dumps.
- Full MCP semantic model.
- `assistantReport` as an assertion source.
- Terminal cell-grid rendering with an xterm emulator.
- Screenshots or browser-style visual testing.
- Product-specific Channels semantics inside the module.

`assistantReport` is a v2 supplemental path only. If added later, it may help
debug or summarize a run from inside the assistant session, but it must not be a
v1 assertion source. V1 correctness comes from process output, terminal
transcripts, hook traces, MCP traces, command inventory, raw Channel
notifications, and artifacts.

Fixture helper abstractions also remain deferred. Add them only after repeated
Teamem consumer tests prove a concrete need that direct `cwd`, `pluginDir`, and
artifact options cannot cover cleanly.

## Extraction Criteria

Move this PoC to a real Node.js package only after the in-repo evidence shows:

- The generic module API is stable across multiple Teamem consumer tests.
- Teamem-specific behavior remains outside `plugin-e2e-module/`.
- Source-plugin and instrumented-plugin boundaries remain reliable.
- Headless and interactive backends have focused self-tests and at least one
  useful live consumer path.
- Artifact redaction and cleanup behavior is safe enough for local and CI use.
- Public options are documented from implemented behavior, not planned APIs.
- Unsupported surfaces above are either still explicitly deferred or promoted
  through a new design decision with tests.

Until then, v1 remains an in-repo PoC optimized for trustworthy Claude Code
plugin evidence over breadth.

## Claude Version Guard

The PoC default `DEFAULT_MIN_CLAUDE_VERSION` is `2.1.158`, the first locally
verified Claude Code runtime used to ground this module. Consumers can set
`minClaudeVersion: false` when intentionally testing another compatible runtime.
