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
| `teamem cc` | Launch Claude Code with Teamem enabled. |
| `teamem uninstall` | Remove the Claude Code plugin, Teamem-managed git hooks, and local Teamem state. |

`teamem cc` can prompt to update first. Use `teamem cc --update`,
`teamem cc --no-update`, or `teamem cc -- <claude args>` to control launch
behavior.

## Boundaries

- The npm package is only the bootstrapper CLI.
- The Claude Code plugin is the runtime bundle.
- The plugin manifest remains the MCP configuration authority.
- Teamem server setup is a separate operator task; run or choose a Teamem server
  before onboarding teammates.
