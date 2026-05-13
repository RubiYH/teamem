# Claude Code Plugin

Teamem ships as a Claude Code plugin plus an npm bootstrapper. The npm package
installs and updates the plugin; the plugin is the runtime used by Claude Code.

## Install

Install Bun first, because the Teamem bootstrapper runs on Bun:

```bash
curl -fsSL https://bun.sh/install | bash
```

Then install and launch Teamem:

```bash
npm install -g teamem
teamem init
teamem cc
```

`teamem init` checks prerequisites, installs `teamem@teamem-alpha`, runs setup,
and can install git hooks. `teamem cc` launches Claude Code with Teamem enabled.

## Activate in a repo

```text
/teamem-on
/teamem-on --persist
```

`/teamem-on` activates Teamem for the current session. `/teamem-on --persist`
makes Teamem default to on for future Claude Code sessions in this repository.

Use `/teamem-off` to turn it off for the current session.

## Common commands

| Command | Purpose |
| --- | --- |
| `/teamem-briefing` | Read the current plan, claims, decisions, risks, and progress. |
| `/teamem-status` | Check activation state, monitor health, and recent notifications. |
| `/teamem-decide` | Record a durable decision. |
| `/teamem-gotcha` | Share a persistent lesson or warning. |
| `/teamem-discuss` | Send a direct or broadcast team message. |
| `/teamem-space` | Manage membership actions. |

## Experimental Channels

Teamem currently uses Claude Code's experimental Channels feature for live
delivery. If Channels are unavailable, use `/teamem-briefing`,
`/teamem-status`, and unread notifications as the fallback.
