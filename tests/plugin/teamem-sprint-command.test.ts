import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('/teamem:sprint command contract', () => {
  it('exposes lifecycle commands without use/off aliases', () => {
    const command = readFileSync(
      join(process.cwd(), 'plugin/commands/sprint.md'),
      'utf-8'
    );
    const manifest = JSON.parse(
      readFileSync(
        join(process.cwd(), 'plugin/.claude-plugin/plugin.json'),
        'utf-8'
      )
    ) as { commands: string[] };

    expect(manifest.commands).toContain('./commands/sprint.md');
    expect(command).toContain('mcp__teamem__teamem_create_sprint');
    expect(command).toContain('mcp__teamem__teamem_join_sprint');
    expect(command).toContain('mcp__teamem__teamem_leave_sprint');
    expect(command).toContain('mcp__teamem__teamem_get_current_sprint');
    expect(command).toContain('mcp__teamem__teamem_list_sprints');
    expect(command).toContain('mcp__teamem__teamem_archive_sprint');
    expect(command).toContain('mcp__teamem__teamem_reopen_sprint');
    expect(command).toContain('mcp__teamem__teamem_get_sprint_history');
    expect(command).toContain(
      'mcp__plugin_teamem_teamem__teamem_create_sprint'
    );
    expect(command).toContain(
      'do not use ToolSearch, Bash, `/mcp`, or any discovery/probing command'
    );
    expect(
      command.indexOf('mcp__plugin_teamem_teamem__teamem_create_sprint')
    ).toBeLessThan(command.indexOf('mcp__teamem__teamem_create_sprint'));
    expect(command).not.toContain('/teamem:sprint use');
    expect(command).not.toContain('/teamem:sprint off');
    expect(command).not.toContain('mcp__teamem__create_sprint');
    expect(command).not.toContain('mcp__teamem__teamem_use_sprint');
    expect(command).not.toContain('mcp__teamem__teamem_off_sprint');
  });
});
