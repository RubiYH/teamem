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

Once the shim directory is first on PATH, launch Claude Code as usual with
`claude`. Interactive `claude` prompts on every launch. Use `claude --teamem` or
`claude --pure` for explicit launch choices; non-interactive `claude` defaults
pure. A Teamem launch blocks before opening Claude Code when setup,
credentials, plugin install, or runtime Space readiness is missing, and prints
the repair command to run next.

When you choose Teamem in the launcher, or pass `claude --teamem`, the shim
passes activation intent and the selected Space into Claude Code. On
SessionStart, the Teamem plugin stores that activation in plugin-owned session
state, so the current session starts active without a separate `/teamem-on`
step.

`teamem cc` is now a compatibility error only. It does not launch Claude Code;
it points existing users toward the launcher migration.

## Activate in a repo

```text
/teamem-on
/teamem-on --persist
```

`/teamem-on` remains the manual fallback for sessions launched without the
Teamem launcher path, or for repairing activation state in an already-open
session. `/teamem-on --persist` makes Teamem default to on for future Claude
Code sessions in this repository.

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
