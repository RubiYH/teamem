<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# harnesses

## Purpose

Test harness utilities and helper modules used by other integration test suites. Currently empty; may grow to include shared setup functions, mock servers, or test database factories.

## Key Files

None yet. This directory is reserved for shared test infrastructure as the integration suite expands.

## For AI Agents

### Working In This Directory

- Add helpers here if multiple test suites need the same setup (e.g., multi-principal server, fixture loaders).
- Prefer exporting named functions over default exports for clarity.
- Document any shared test patterns in this AGENTS.md.

### Testing Requirements

- Any helper must be tested by the suites that use it (no separate harness tests).

### Common Patterns

- Test database setup and seeding (e.g., `setupTestDb()`, `seedSpace(db, ...)`).
- Mock HTTP clients or MCP servers.
- Fixture loading and validation.

## Dependencies

### Internal

- None yet.

### External

- Depends on what harnesses are added.

<!-- MANUAL: -->
