# Troubleshooting

## `teamem init` cannot find Claude Code

Make sure the `claude` CLI is installed and available on `PATH`.

## Server does not start

Check `.env`, ensure `TEAMEM_JWT_SECRET` is set to a generated secret, ensure
the data directory exists, and verify that the configured port is not already
in use.

For Bun local development:

```bash
mkdir -p data
bun run server
```

## Plugin commands cannot reach Teamem

Confirm that the Teamem server is running and that the plugin setup used the
correct server URL.

## Claims do not release after commit

Install Teamem git hooks in the repository:

```bash
teamem init --install-git-hooks
```

Source-checkout developers can also run
`bun run teamem install-git-hooks`. If you use a hook manager, make sure it
invokes Teamem's `post-commit` hook.

## Channels do not appear

Claude Code Channels are experimental. If live delivery is unavailable, use
`/teamem-briefing`, `/teamem-status`, and unread notifications.
