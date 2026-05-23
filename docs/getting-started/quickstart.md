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

## 3. Launch Claude Code

```bash
teamem cc
```

In Claude Code:

```text
/teamem-on
/teamem-on --persist
/teamem-briefing
```

Use `/teamem-on --persist` when Teamem should default to on for future Claude
Code sessions in this repository.

## 4. Work normally

Teamem hooks claim files before edits, release normal claims on commit, and
surface team context through `/teamem-briefing` and `/teamem-status`.
