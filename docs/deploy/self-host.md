# Self-host Teamem

Use this guide when you want to run your own Teamem shared server instead of
using Teamem Cloud.

## Start the server

Use a server your team already runs, or clone this repository and self-host it.

With Docker Compose:

```bash
git clone https://github.com/RubiYH/teamem.git
cd teamem
cp .env.example .env
# Set TEAMEM_JWT_SECRET in .env. For local testing:
#   openssl rand -hex 32
docker compose up --build -d
```

Or directly with Bun:

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

For a production VPS, see [VPS Deployment](./vps.md).

## Set up each teammate

After the server is available, install Bun on each teammate machine if it is
not already available:

```bash
curl -fsSL https://bun.sh/install | bash
```

Then install the bootstrapper CLI and run the guided Claude Code setup:

```bash
npm install -g @rubiyh05/teamem
teamem init
teamem cc
```

`teamem init` checks prerequisites, adds or refreshes the `teamem-alpha` Claude
Code marketplace, installs the `teamem@teamem-alpha` plugin, runs the space
create or join setup flow, and can install Teamem git hooks. `teamem cc`
launches Claude Code with the Teamem development channel enabled.
