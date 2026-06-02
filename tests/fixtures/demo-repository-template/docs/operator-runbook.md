# Operator Runbook

## Run

```bash
bun run check
```

## Smoke Handoff

1. Launch Claude Code from the copied demo workspace root.
2. Keep Teamem source checkout paths separate from demo workspace paths.
3. Preserve the copied workspace on smoke failure for transcript and git
   inspection.

## Known Gotchas

- The fixture has no external dependencies.
- Tests initialize git history after copying the template.
