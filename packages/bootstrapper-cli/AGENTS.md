<!-- Parent: ../../AGENTS.md -->
<!-- Created: 2026-05-13 -->

# bootstrapper-cli

## Purpose

Publishable npm package for the `teamem` CLI. This package is the first-run bootstrapper users install with `npm install -g @rubiyh05/teamem`; it prepares Claude Code marketplace/plugin state, delegates to Teamem setup, installs optional git hooks, updates or uninstalls the plugin, and owns the real machine-local install/status/uninstall lifecycle for the opt-in Teamem-aware Claude launcher.

## Key Files

| File | Description |
|------|-------------|
| `package.json` | npm package metadata; published package name is `@rubiyh05/teamem`, bin points at `dist/bin/teamem.js` |
| `src/bin/teamem.ts` | executable entry point; must keep the Bun shebang |
| `src/cli.ts` | command parser and command orchestration for `init`, `update`, `uninstall`, `claude`, and `cc` compatibility errors |
| `src/plugin-installer.ts` | marketplace add/update/install flow, plugin scope resolution, scope memory |
| `src/claude-plugin-list.ts` | source of truth for parsing `claude plugin list --json` |
| `src/setup-delegation.ts` | delegates create/join setup to the installed Teamem plugin setup bundle |
| `src/git-hooks.ts` | optional post-setup git hook installer/uninstaller prompt and execution |
| `src/uninstall-executor.ts` | first-class uninstall cleanup path for plugin, marketplace, hooks, local state, and credentials |
| `src/runtime-prompt.ts` | Bun-backed interactive prompt wrapper used by every CLI prompt |
| `tests/package-artifact.test.ts` | packed npm artifact/install smoke coverage |

## For AI Agents

### Working In This Directory

- This package targets **Bun as the runtime**, even though it is distributed through npm. Keep `src/bin/teamem.ts` as `#!/usr/bin/env bun`.
- Do not add a second setup implementation. `teamem init` must run prerequisite/plugin install steps first, then delegate to the same create/join setup behavior used by the plugin setup bundle.
- `teamem init` must not write MCP JSON. Claude Code plugin installation owns MCP server declarations.
- Keep marketplace defaults pinned to `https://github.com/RubiYH/teamem`, `teamem-alpha`, and `teamem@teamem-alpha`.
- Preserve `--scope project|user|local` flags and `.teamem/bootstrapper.json` scope memory. Commands should prefer explicit flags, then remembered scope, then safe prompting/defaults.
- Keep `--dry-run` useful: it should show planned external commands without mutating Claude Code, git hooks, credentials, or scope memory.
- Keep `teamem uninstall` comprehensive: uninstall the plugin, remove the marketplace source, uninstall Teamem-managed git hooks, remove bootstrapper scope memory, clear local run/cache/plugin data, and remove credentials unless `--keep-credentials` is set. Continue local cleanup after non-fatal Claude command failures.
- Keep dist/package behavior in mind. Source changes are not enough; `bun run build` updates `dist/`, and package artifact tests should catch broken bin metadata.

### Runtime and Prompt Gotchas

- Use `runtime-prompt.ts` for interactive input. Do not reintroduce raw `node:fs.readSync` stdin readers; they produced `EAGAIN` under npm-installed CLI smoke on macOS.
- Do not broadly replace `node:path`, `node:fs`, or `node:child_process` with Bun APIs. The proven improvement was Bun-backed prompts plus a Bun shebang. Node stdlib path/file/process utilities remain fine inside Bun.
- Test prompts by injecting prompt functions through the existing environment seams. Avoid tests that depend on a real TTY.
- Non-interactive paths must be deterministic: use explicit flags, remembered scope, or documented defaults rather than hanging for input.

### Claude Code Marketplace Contracts

- Use `claude plugin list --json` and `src/claude-plugin-list.ts` for installed plugin detection. Do not parse human table output.
- Avoid `claude plugin list --scope ...` probes; scope comes from parsed list rows, explicit flags, and bootstrapper memory.
- `teamem init` may run:
  - `claude plugin marketplace add https://github.com/RubiYH/teamem`
  - `claude plugin marketplace update teamem-alpha`
  - `claude plugin install teamem@teamem-alpha --scope <scope>`
- `teamem update` should refresh marketplace metadata before updating the plugin.
- `teamem claude install`, `teamem claude status`, and `teamem claude uninstall` are the Teamem-aware Claude launcher lifecycle command family.
- `teamem cc` is a compatibility error only. It must not launch Claude Code; it should point users toward `teamem claude install` and the prompt-based `claude` shim.

### Git Hook Contracts

- Hook installation is optional after setup, unless a non-interactive flag explicitly requests install/skip.
- Installed hooks must be the plugin-managed `post-commit` and `post-checkout` hooks with the `# teamem-managed-hook` marker and executable mode.
- Hook uninstall must remove only Teamem-managed hooks, restore `.teamem-backup` files when present, and preserve user-owned hooks.
- Hook installer code must respect `core.hooksPath` / worktree behavior. Do not hardcode `.git/hooks/` in new logic.
- A hook smoke should include a first commit; the first commit path needs `git diff-tree --root` coverage in the installed hook.

### Testing Requirements

Run the package gates from `packages/bootstrapper-cli/` before declaring
bootstrapper work complete:

```bash
bun test ./tests
bun run typecheck
bun run build
```

For packaging or bin/runtime changes, also run a temporary-prefix smoke:

```bash
npm pack
npm install -g --prefix /tmp/teamem-prefix ./rubiyh05-teamem-*.tgz
PATH="/tmp/teamem-prefix/bin:$PATH" teamem init --dry-run --scope project
PATH="/tmp/teamem-prefix/bin:$PATH" teamem update --dry-run --scope project
PATH="/tmp/teamem-prefix/bin:$PATH" teamem claude status --dry-run
```

Do not include `teamem cc --dry-run` in the successful launch smoke. `teamem cc` intentionally exits non-zero as a compatibility migration message; cover it only with focused tests or manual checks that assert both the non-zero status and migration text.

For uninstall/reset changes, also run or update focused tests that cover `teamem uninstall --dry-run`, command-failure continuation, credential preservation with `--keep-credentials`, plugin data slug cleanup, and hook uninstall under `core.hooksPath`.

Do not use the developer's real `~/.teamem/credentials.json` or long-lived Claude plugin data in automated tests unless the test is explicitly a manual smoke.

## Dependencies

### Internal

- `plugin/.claude-plugin/plugin.json` for Teamem plugin identity/version expectations
- `plugin/lib/setup.js` for setup delegation once the plugin is installed
- `plugin/git-hooks/` for installed hook templates and behavior
- `plugin/AGENTS.md` for plugin ownership of MCP JSON, marketplace versioning, and install/update boundaries
- root `AGENTS.md` for repo-wide commit, verification, and release rules

### External

- `bun` runtime
- `npm` for packaging/global install smoke
- `claude` CLI for plugin marketplace/list/install/update and launch
- `git` for repo checks and hook installation

<!-- MANUAL: -->
