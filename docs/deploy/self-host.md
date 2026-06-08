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
teamem claude install
```

`teamem init` checks prerequisites, adds or refreshes the `teamem-alpha` Claude
Code marketplace, installs the `teamem@teamem-alpha` plugin, runs the space
create or join setup flow, can install Teamem git hooks, and offers the opt-in
Teamem Claude statusline in interactive setup. `teamem claude install` installs
the Teamem-owned `claude` shim and prints the PATH line to add, but does not
edit shell startup files by default:

```bash
export PATH="$HOME/.teamem/bin:$PATH"
```

Once the shim directory is first on PATH, launch Claude Code as usual with
`claude`. Interactive `claude` prompts on every launch. Use `claude --teamem` or
`claude --pure` for explicit launch choices; non-interactive `claude` defaults
pure. `teamem cc` is a compatibility error for older instructions and does not
launch Claude Code. A Teamem launch blocks before opening Claude Code when
setup, credentials, plugin install, or runtime Space readiness is missing, and
prints the repair command to run next.

To enable or inspect the optional Teamem Claude statusline after setup, use:

```bash
teamem claude statusline install
teamem claude statusline status
teamem claude statusline uninstall
```

Non-interactive `teamem init` skips the statusline unless
`--install-claude-statusline` is passed. Teamem refuses to overwrite non-Teamem
statuslines; backup/restore behavior and `--force` are out of scope for this
slice.
