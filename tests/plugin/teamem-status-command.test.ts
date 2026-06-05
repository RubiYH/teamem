import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('/teamem-status command contract', () => {
  it('renders current mode through routed MCP reads without listing archived Sprints', () => {
    const command = readFileSync(
      join(process.cwd(), 'plugin/commands/teamem-status.md'),
      'utf-8'
    );

    expect(command).toContain('${CLAUDE_PLUGIN_ROOT}/bin/teamem-flag status');
    expect(command).toContain('mcp__teamem__teamem_whoami');
    expect(command).toContain('mcp__teamem__teamem_get_current_sprint');
    expect(command).toContain('Space label and id');
    expect(command).toContain('display name, slug, and `current_members`');
    expect(command).toContain('scope="self", view="current"');
    expect(command).toContain('scope="self", view="outside_current_context"');
    expect(command).not.toContain('mcp__teamem__teamem_get_updates');
    expect(command).toContain('recent_notifications');
    expect(command).toContain('recent routed notifications');
    expect(command).toContain('routing_reason');
    expect(command).toContain(
      'meta.cross_context_overlap_awareness.overlapping_claims'
    );
    expect(command).toContain('Do not render full overlap detail');
    expect(command).toContain('Do not call `mcp__teamem__teamem_list_sprints`');
    expect(command).toContain(
      'archived Sprint inventory belongs in `/teamem-sprint list`'
    );
    expect(command).not.toContain('notifications.log');
    expect(command).not.toContain('tail -n 5');
  });
});
