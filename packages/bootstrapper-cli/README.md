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
plugin setup bundle, prompts for Teamem git hooks, and offers the opt-in Teamem
Claude statusline in interactive setup.

## Commands

| Command | Purpose |
| --- | --- |
| `teamem init` | Install the Claude Code plugin and run create/join setup. |
| `teamem update` | Refresh the marketplace and update the installed plugin. |
| `teamem claude install` | Install or refresh Teamem-owned machine-local launcher state and shim files. |
| `teamem claude status` | Inspect the Teamem-aware Claude launcher lifecycle state. |
| `teamem claude uninstall` | Remove Teamem-owned launcher state and shim files. |
| `teamem claude statusline install` | Install the opt-in Teamem Claude statusline. |
| `teamem claude statusline status` | Inspect selected and effective Teamem Claude statusline state. |
| `teamem claude statusline uninstall` | Remove Teamem-owned Claude statusline settings. |
| `teamem dev claude` | Contributor-only source-checkout Claude Code launcher. |
| `teamem dev status` | Inspect contributor dev profiles and launch boundaries. |
| `teamem dev delete` | Delete one contributor dev profile capsule. |
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

`teamem init` also offers to install the Teamem Claude statusline after setup in
interactive runs. Use `teamem init --install-claude-statusline` to force
statusline installation, or `teamem init --skip-claude-statusline` to skip the
offer. Non-interactive init does not install the statusline unless
`--install-claude-statusline` is provided. If you decline the offer, enable it
later with:

```bash
teamem claude statusline install
```

The statusline install uses the same resolved setup scope by default: project
inside a git repository, user outside one, or an explicit `--scope
project|user|local`. Teamem refuses to overwrite an existing non-Teamem Claude
statusline and leaves it untouched. Backup/restore behavior and `--force` are
out of scope for this slice; uninstall removes only Teamem's exact statusline
setting.

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

## Contributor Source-Checkout Development

Normal Teamem onboarding follows the ADR-0010 flow:

```bash
teamem claude install
claude
```

The `teamem dev` commands are not normal user commands. They are for
contributors who are testing this repository's local plugin source while they
may also have the released marketplace plugin and their everyday Claude Code
state installed on the same machine.

```bash
teamem dev claude --profile alice
teamem dev status --profile alice
teamem dev delete --profile alice
```

`teamem dev claude` requires a Teamem source checkout. Run it from this repo or
pass `--teamem-root /path/to/teamem-poc`. The source root is the Teamem checkout
whose `plugin/` directory is loaded. The launch cwd is where Claude Code opens;
it defaults to the current directory and can be set with `--cwd /path/to/repo`.
Those paths may differ when testing Teamem source against another repository.

Each profile is a durable local capsule under:

```text
~/.teamem/dev-profiles/<profile>/
```

The profile owns:

- `CLAUDE_CONFIG_DIR=<profile>/claude`, so normal `~/.claude` user/global state
  is untouched.
- `CLAUDE_CODE_PLUGIN_CACHE_DIR=<profile>/claude/plugins`, so marketplace plugin
  cache state is isolated.
- `<profile>/credentials.json`, the Teamem credentials for that contributor
  persona.
- `<profile>/mcp.json`, generated from the selected local plugin declaration
  and launched with `--strict-mcp-config`.

The marketplace Teamem plugin identity `teamem@teamem-alpha` is ignored in
local source mode. `teamem dev claude` launches the real Claude Code executable
directly with `--plugin-dir <teamem-root>/plugin`, the generated profile MCP
config, and the local development channel source
`server:teamem-channel`. It does not edit installed Claude plugin cache files
and does not import normal `~/.claude` state.

On first launch for a profile, missing profile credentials trigger Teamem setup
from the selected source checkout with `TEAMEM_CREDENTIALS` pointed at the
profile credentials file. If setup reaches the existing git hook step, the
usual Teamem git hook prompt and `--install-git-hooks` /
`--skip-git-hooks` behavior still apply; hooks remain repo-level state, not
profile state.

Use `--dry-run` to inspect the plan without creating profile state, writing MCP
config, running setup, building bundles, checking server health, or launching
Claude Code. Dry-run output shows the selected profile paths, source root,
launch cwd, generated MCP config path, strict MCP mode, channel source, server
health check that would run, bundle freshness check that would run, and the
fact that the marketplace plugin is ignored.

`teamem dev status` is read-only. Without `--profile`, it lists dev profiles.
With `--profile`, it shows profile paths, credential status, server health when
credentials exist, source checkout, launch cwd, generated MCP config status,
strict MCP mode, channel source, bundle freshness, and marketplace-plugin
ignore status.

`teamem dev delete` removes only the selected profile directory after
confirmation. Non-interactive deletion requires both `--profile` and `--yes`.
Deletion does not touch normal `~/.claude`, default
`~/.teamem/credentials.json`, marketplace plugin cache, git hooks, or launcher
shim state. It refuses to delete when a matching profiled Claude process is
detected unless `--force` is provided, and warns when process detection is
inconclusive.

Plugin bundles are checked before launch. If committed bundles are stale or
missing, interactive launches offer to run `bun run build:plugin`.
Non-interactive launches fail unless `--build-plugin` is passed.
`--build-plugin` runs `bun run build:plugin` from the selected source checkout
and rechecks freshness before launch. After credentials exist, server health is
checked at `<server-url>/health`; if it is unreachable, Claude Code is not
launched.
