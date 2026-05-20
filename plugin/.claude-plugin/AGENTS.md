<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# .claude-plugin

## Purpose

Plugin manifest and metadata for the Claude Code marketplace. Contains the single source-of-truth plugin definition (`plugin.json`) that declares the plugin name, version, description, skills path, and MCP server configuration.

## Key Files

| File | Description |
|------|-------------|
| `plugin.json` | Marketplace manifest: name `teamem`, version `0.3.18`, skills directory path, MCP servers declaration |

## For AI Agents

### Working In This Directory

- **Version bumping** (critical): Every change to any bundled artifact in `lib/` or source code that affects plugin behavior MUST bump the version in `plugin.json`. Claude Code's cache integrity check silently rejects plugins with mismatched versions.
- **Manifest structure**: The `plugin.json` is a JSON document with fields `name`, `version`, `description`, `author`, `homepage`, `license`, `keywords`, `skills` (directory path), and `mcpServers` (path to MCP config). Adding unknown fields or malformed entries silently disables ALL hooks for the plugin — if a hook stops firing, bisect by stripping the manifest to minimal fields.
- **MCP servers config**: The `mcpServers` field points to `../.mcp.json` (one level up in plugin root). This configures custom MCP servers like `teamem-channel` for the Channels POC.

### Common Patterns

- **Relock after rebuild**: After running `bun build` for any source changes, always:
  1. Increment the patch version in `plugin.json` (e.g., `0.3.1` → `0.3.2`)
  2. Clear the Claude Code plugin cache: `rm -rf ~/.claude/plugins/cache/teamem` (or whatever the plugin slug is)
  3. Reinstall or reload the plugin in Claude Code

## Dependencies

### External

- Claude Code marketplace plugin format specification (schema for `plugin.json` structure)

<!-- MANUAL: -->
