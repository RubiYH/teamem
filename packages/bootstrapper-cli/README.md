# Teamem Bootstrapper CLI

The `@rubiyh05/teamem` npm package is a bootstrapper for installing and updating the
Teamem Claude Code plugin. It is not the Teamem runtime server and it does not
own MCP configuration directly; the installed Claude Code plugin does that.

## Install

The published `teamem` binary runs on Bun. Install Bun first if it is not
already available:

```bash
curl -fsSL https://bun.sh/install | bash
```

```bash
npm install -g @rubiyh05/teamem
teamem init
```

`teamem init` diagnoses prerequisites, adds or updates the GitHub-hosted
`teamem-alpha` marketplace, installs `teamem@teamem-alpha`, runs the installed
plugin setup bundle, and prompts for Teamem git hooks.

## Commands

| Command | Purpose |
| --- | --- |
| `teamem init` | Install the Claude Code plugin and run create/join setup. |
| `teamem update` | Refresh the marketplace and update the installed plugin. |
| `teamem claude install` | Install or refresh Teamem-owned machine-local launcher state and shim files. |
| `teamem claude status` | Inspect the Teamem-aware Claude launcher lifecycle state. |
| `teamem claude uninstall` | Remove Teamem-owned launcher state and shim files. |
| `teamem cc` | Compatibility error; points existing users toward the launcher migration. |
| `teamem uninstall` | Remove the Claude Code plugin, Teamem-managed git hooks, Teamem-owned launcher shim/state, and local Teamem state while preserving non-Teamem shim files. |

`teamem cc` no longer launches Claude Code. Run `teamem claude install` to
install or refresh the Teamem-owned machine-local launcher state and shim. The
installer prints the PATH line to add, but does not edit shell startup files by
default:

```bash
export PATH="$HOME/.teamem/bin:$PATH"
```

Teamem is not affiliated with Anthropic. The shim does not handle Claude
credentials or proxy Claude requests; it prompts whether to launch Claude Code
with Teamem plugin activation or as pure Claude Code, then execs the real Claude
Code binary. Remove it with `teamem claude uninstall`.

Then launch Claude Code as usual with `claude`. Interactive shim launches prompt
for Teamem or pure Claude Code every time; non-interactive launches stay pure
unless `claude --teamem ...` is used explicitly. Use `claude --pure ...` to
force the pure path.

`teamem init` offers to install the launcher after setup in interactive runs.
Use `teamem init --install-claude-launcher` to force launcher installation, or
`teamem init --skip-claude-launcher` to skip the offer. Non-interactive init
does not install the launcher unless `--install-claude-launcher` is provided.

Teamem launch readiness is checked before opening Claude Code. If setup,
credentials, plugin install, or runtime Space readiness is missing, the launcher
blocks and prints the next repair command, usually a targeted `teamem init`
rerun.

`teamem uninstall` also cleans up the Teamem-owned Claude launcher state and
shim. It removes only Teamem-owned launcher files; an existing non-Teamem
`claude` shim path is preserved and reported instead of overwritten or deleted.
Use `teamem claude uninstall` when you only want to unwrap `claude` and keep the
Teamem plugin, git hooks, and credentials. The command prints the restored
Claude Code path and the shell cache check to run next.

## Boundaries

- The npm package is only the bootstrapper CLI.
- The Claude Code plugin is the runtime bundle.
- The plugin manifest remains the MCP configuration authority.
- Teamem server setup is a separate operator task; run or choose a Teamem server
  before onboarding teammates.
