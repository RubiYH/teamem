# Claude Code Plugin

Teamem ships as a Claude Code plugin plus an npm bootstrapper. The npm package
installs and updates the plugin; the plugin is the runtime used by Claude Code.

## Install

Install Bun first, because the Teamem bootstrapper runs on Bun:

```bash
curl -fsSL https://bun.sh/install | bash
```

Then install Teamem and prepare the opt-in Claude launcher:

```bash
npm install -g @rubiyh05/teamem
teamem init
teamem claude install
```

`teamem init` checks prerequisites, installs `teamem@teamem-alpha`, runs setup,
and can install git hooks. `teamem claude install` installs the Teamem-owned
`claude` shim. It prints the PATH line to add, but does not edit shell startup
files by default:

```bash
export PATH="$HOME/.teamem/bin:$PATH"
```

Teamem is not affiliated with Anthropic. The shim does not handle Claude
credentials or proxy Claude requests; it prompts whether to launch Claude Code
with Teamem plugin activation or as pure Claude Code, then execs the real Claude
Code binary. Remove it with `teamem claude uninstall`.

Once the shim directory is first on PATH, launch Claude Code as usual with
`claude`. Interactive `claude` prompts on every launch. Use `claude --teamem` or
`claude --pure` for explicit launch choices; non-interactive `claude` defaults
pure. A Teamem launch blocks before opening Claude Code when setup,
credentials, plugin install, or runtime Space readiness is missing, and prints
the repair command to run next.

When you choose Teamem in the launcher, or pass `claude --teamem`, the shim
passes activation intent and the selected Space into Claude Code. On
SessionStart, the Teamem plugin stores that activation in plugin-owned session
state, so the current session starts active without a separate slash command.

`teamem cc` is now a compatibility error only. It does not launch Claude Code;
it points existing users toward the launcher migration.

## Activate in a repo

Start Claude Code through the Teamem launcher and choose Teamem, or pass
`claude --teamem ...` for an explicit Teamem launch. The deprecated `/teamem-on`
activation command is no longer shipped; restart an already-open pure session
through the launcher when you need hooks and monitor delivery.

Use `/teamem-off` to turn it off for the current session.

## Common commands

| Command | Purpose |
| --- | --- |
| `/teamem-briefing` | Read the current plan, claims, decisions, risks, and progress. |
| `/teamem-status` | Check activation state, monitor health, and recent notifications. |
| `/teamem-decide` | Record a durable decision. |
| `/teamem-gotcha` | Share a persistent lesson or warning. |
| `/teamem-discuss` | Send a direct or broadcast team message. |
| `/teamem-sprint` | Create, join, leave, list, inspect history, archive, or reopen a Sprint. |
| `/teamem-space` | Manage membership actions. |

## Space mode, Sprint mode, and messages

Space mode is the default operating mode when you are not joined to a Sprint.
Sprint mode starts when you join a Sprint with `/teamem-sprint join` or create
one with `/teamem-sprint create <name> -- <goal>`. A Sprint narrows live
monitoring, briefing/status context, and claim conflicts to a work goal inside
the Space. It is not a privacy boundary: Space membership remains the trust
boundary, and Space members can explicitly use `/teamem-sprint list` and
`/teamem-sprint history <slug-or-id>` to inspect Sprint metadata and non-private
Sprint lifecycle history.

The Sprint command surface is:

```text
/teamem-sprint create <name> -- <goal>
/teamem-sprint join <slug-or-id>
/teamem-sprint leave
/teamem-sprint list
/teamem-sprint history <slug-or-id> [--limit N]
/teamem-sprint archive <slug-or-id>
/teamem-sprint reopen <slug-or-id>
```

Direct `/teamem-discuss <principal> -- <message>` messages reach the named
teammate regardless of their current Sprint. The `*` marker in
`/teamem-discuss * -- <message>` broadcasts to the current Sprint in Sprint mode
and to the Space in Space mode. The `**` marker in
`/teamem-discuss ** -- <message>` is an explicit Space-wide escalation,
including teammates currently working in Sprints.

`teamem.get_updates`, `/teamem-status`, and SessionStart briefings follow the
same boundary. In Space mode they show Space-mode updates, direct-to-me
messages, and explicit Space-wide messages; Space mode is not an all-Sprints
feed. In Sprint mode they show the current Sprint, direct-to-me messages, and
explicit Space-wide messages; ordinary other-Sprint and ordinary Space-mode
activity is left out of the live/current surface.

## Experimental Channels

Teamem currently uses Claude Code's experimental Channels feature for live
delivery. If Channels are unavailable, use `/teamem-briefing`,
`/teamem-status`, and unread notifications as the fallback.
