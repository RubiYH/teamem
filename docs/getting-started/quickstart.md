# Teamem Quickstart

This guide is the shortest path from a fresh machine to a Claude Code session
using Teamem.

## 1. Install the Teamem CLI

Install Bun first if it is not already on this machine:

```bash
curl -fsSL https://bun.sh/install | bash
```

Then install the Teamem bootstrapper:

```bash
npm install -g @rubiyh05/teamem
```

## 2. Choose a shared server

Teamem requires a shared server. Choose Teamem Cloud when you want a managed
server, or self-host when your team wants to run the server.

### Option A: Teamem Cloud

Open [teamem.cc](https://teamem.cc), sign in, create a free managed Space, and
copy the hosted server URL, room code, and setup command from the dashboard.
Run that setup command on each teammate machine.

Teamem Cloud is the provisioning and setup control plane. Your team still uses
the Teamem runtime/plugin flow for Claude Code, bridge, git hooks, room codes,
claims, briefings, discussions, and Space Rules.

### Option B: Self-host

Use a server your team already runs, or clone this repository and self-host it.

To self-host locally with Docker Compose:

```bash
git clone https://github.com/RubiYH/teamem.git
cd teamem
cp .env.example .env
# Set TEAMEM_JWT_SECRET in .env. For local testing:
#   openssl rand -hex 32
docker compose up --build -d
```

Or run the server directly with Bun:

```bash
git clone https://github.com/RubiYH/teamem.git
cd teamem
bun install
cp .env.example .env
# Set TEAMEM_JWT_SECRET in .env. For local testing:
#   openssl rand -hex 32
mkdir -p data
bun run server
```

After the server is available, run the generated setup command on each teammate
machine. If you are using the guided local setup flow, run:

```bash
teamem init
```

`teamem init` checks prerequisites, installs or refreshes the Claude Code
plugin, runs create/join setup, can install Teamem git hooks, and offers the
opt-in Teamem Claude statusline in interactive setup. Non-interactive setup
skips the statusline unless you pass `--install-claude-statusline`. If you
decline the offer, enable it later with:

```bash
teamem claude statusline install
```

## 3. Prepare the launcher and start Claude Code

```bash
teamem claude install
```

`teamem cc` is kept only as a compatibility error for older instructions. It
does not launch Claude Code. `teamem claude install` prepares the opt-in
Teamem-aware launcher state and shim. It does not edit shell startup files by
default; add the printed PATH line yourself, usually:

```bash
export PATH="$HOME/.teamem/bin:$PATH"
```

Then start Claude Code as usual:

```bash
claude
```

Interactive `claude` launches prompt for Teamem or pure Claude Code.
Non-interactive launches stay pure by default, and explicit launcher flags such
as `claude --teamem --print hi` or `claude --pure --print hi` select the mode
before forwarding the remaining arguments to Claude Code. A Teamem launch
blocks before opening Claude Code when setup, credentials, plugin install, or
runtime Space readiness is missing, and prints the repair command to run next.

Optional statusline lifecycle commands are:

```bash
teamem claude statusline install
teamem claude statusline status
teamem claude statusline uninstall
```

Inside a git repository, statusline installation defaults to project scope; use
`--scope project|user|local` when you need a specific Claude settings scope.
Teamem refuses to overwrite non-Teamem Claude statuslines and leaves them
untouched. Backup/restore behavior and `--force` are not part of this first
statusline slice.

Normal onboarding starts Claude Code through the PATH shim: run `claude` and
choose Teamem, or use `claude --teamem ...`. If an already-running session was
launched without Teamem activation, restart it through the launcher or use
on-demand read commands:

```text
/teamem-briefing
/teamem-status
```

The deprecated `/teamem-on` activation command is no longer shipped.

## 4. Work normally

Teamem hooks claim files before edits, release normal claims on commit, and
surface team context through `/teamem-briefing` and `/teamem-status`.
