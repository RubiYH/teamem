# Claude Plugin E2E Module PoC

`plugin-e2e-module` is an in-repo Teamem proving ground for a future reusable
TypeScript package. It is written with package-like boundaries, but v1 is not an
npm package, not a separate repository, and not a stable public dependency.

The reusable module stays generic. It must not import Teamem code, hardcode
Teamem commands, or assume Teamem environment contracts. Teamem-specific live
tests are consumers under `tests/plugin/`.

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
redaction, launch pass-through options, and boot/headless/interactive timeouts.
Permission mode, allowed/disallowed tools, setting sources, prompts, model,
turns, and budget are pass-throughs to Claude Code.

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

Current Teamem consumer tiers under `tests/plugin/` prove:

- Headless plugin-load smoke: Claude Code can load the real local Teamem plugin,
  instrument the core `teamem` MCP server, observe `SessionStart`, avoid forcing
  `CLAUDE_PLUGIN_DATA`, and avoid `teamem-channel` noise without requiring a
  Teamem Space.
- Runtime `/teamem:teamem-whoami` smoke: when credentials and a runtime Space
  are available, a small Teamem command flow can invoke the core Teamem MCP path
  and return identity-oriented output.
- Interactive live tests: reserved for terminal-dependent behavior and gated
  separately from headless tests.

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
- Teamem Channels rendering as a first PoC target.
- Multi-persona Teamem scenarios.

`assistantReport` is a v2 supplemental path only. If added later, it may help
debug or summarize a run from inside the assistant session, but it must not be a
v1 assertion source. V1 correctness comes from process output, terminal
transcripts, hook traces, MCP traces, command inventory, and artifacts.

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
