# Teamem Quickstart

This guide is the shortest path from a fresh machine to a Claude Code session
using Teamem.

## 1. Start or choose a Teamem server

Teamem requires a shared server. The shortest path is Teamem Cloud: open
[teamem.cc](https://teamem.cc), sign in, create a free managed Space, and copy
the hosted setup command from the dashboard.

If your team already runs a server, get the server URL and onboarding code from
your team lead.

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

## 2. Install the bootstrapper

Install Bun first if it is not already on this machine:

```bash
curl -fsSL https://bun.sh/install | bash
```

```bash
npm install -g @rubiyh05/teamem
teamem init
```

`teamem init` installs the Claude Code plugin, runs create/join setup, and can
install Teamem git hooks.

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

Normal onboarding starts Claude Code through the PATH shim: run `claude` and
choose Teamem, or use `claude --teamem ...`. If an already-running session was
launched without Teamem activation, use the manual fallback:

```text
/teamem-on
/teamem-on --persist
/teamem-briefing
```

Use `/teamem-on --persist` only when Teamem should default to on for future
Claude Code sessions in this repository.

## 4. Work normally

Teamem hooks claim files before edits, release normal claims on commit, and
surface team context through `/teamem-briefing` and `/teamem-status`.
