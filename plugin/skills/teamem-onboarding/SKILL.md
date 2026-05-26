---
name: teamem-onboarding
description: Walk a first-time user through Teamem setup — create or join a space, write credentials, verify the bridge resolves. Use when the user has just installed the plugin and has no `~/.teamem/credentials.json` yet, or when `/teamem-setup` is invoked.
---

# Teamem Onboarding

You are guiding a first-time user through Teamem onboarding. The whole flow runs against the bundled setup CLI shipped with the plugin (`${CLAUDE_PLUGIN_ROOT}/lib/setup.js`) — no source-tree dependency.

## Preconditions to verify

1. `bun` is on the user's PATH. If not, link them to https://bun.sh and stop.
2. `~/.teamem/credentials.json` does NOT yet exist (or the user explicitly wants to add another space).
3. `${CLAUDE_PLUGIN_ROOT}/lib/setup.js` exists. If missing, the plugin install is broken — instruct the user to run `teamem update` or `teamem init` to reinstall the current marketplace plugin. Source-checkout developers should run `bun run build:plugin` and load the checkout with `claude --plugin-dir /absolute/path/to/teamem/plugin`.

## Flow

### Path A — first-time, creating a brand-new space

1. Confirm the user wants to create a new space (vs joining an existing one).
2. Ask for a **space label** (human-readable, e.g. "team-alpha", "kernel-rewrite"). It is NOT secret — it appears in the briefing.
3. Ask for the **member name** the user wants to be known by inside the space (their `principal`). The bundled CLI pre-fills the default from `git config --global user.name` (falling back to `$USER`); the user can override.
4. Ask for the **server URL** (defaults to `http://localhost:3000` for local Docker or local Bun; production deployments use a custom HTTPS URL).
5. Run the bundled setup CLI interactively:
   ```bash
   bun run "${CLAUDE_PLUGIN_ROOT}/lib/setup.js"
   ```
   Forward all prompts to the user verbatim and pass their answers through. If the CLI explains the coordination default, keep it on `auto-skip`; negotiator automation is postponed in this plugin build.
6. After setup completes, the CLI prints a **room code** the user can share with teammates. Surface this prominently — it expires (default 24h).

### Path B — joining an existing space

1. Ask the user for the **room code** their teammate gave them.
2. Ask for the member name they want.
3. Ask for the server URL their team uses (must match the creator's server).
4. Run `bun run "${CLAUDE_PLUGIN_ROOT}/lib/setup.js"` and paste the room code at the prompt.

## After successful setup

- Tell the user the credentials live at `~/.teamem/credentials.json` (mode 0600).
- Tell them the normal launcher path is to start Claude Code with `claude` and choose Teamem, or to run `claude --teamem ...` for explicit activation.
- Explain that the deprecated `/teamem-on` activation command is no longer shipped. Already-running pure sessions should be restarted through the Teamem-aware launcher when hooks and monitor delivery are needed.
- Tell them the first thing the plugin will do on activation is fetch a briefing — no claims yet.

## Common failure modes

- **server unreachable**: ask the user to verify the server URL with `curl <url>/health`. If they're running local-docker, suggest `docker compose up -d` from a Teamem source checkout.
- **invalid_code / code_expired**: room code is wrong or older than 24h. Ask the creator to run `/teamem-space rotate-code` and resend.
- **bridge_bundle_missing**: the plugin's `lib/setup.js` or `lib/bridge.js` is absent. Run `teamem update` or `teamem init` to reinstall the current marketplace plugin; source-checkout developers should run `bun run build:plugin` and load with `claude --plugin-dir /absolute/path/to/teamem/plugin`.
- **setup mid-flight failure**: tell the user to delete `~/.teamem/credentials.json` and retry.
