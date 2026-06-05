import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('/teamem-sprint command contract', () => {
  it('exposes lifecycle commands without use/off aliases', () => {
    const command = readFileSync(
      join(process.cwd(), 'plugin/commands/teamem-sprint.md'),
      'utf-8'
    );
    const manifest = JSON.parse(
      readFileSync(
        join(process.cwd(), 'plugin/.claude-plugin/plugin.json'),
        'utf-8'
      )
    ) as { commands: string[] };

    expect(manifest.commands).toContain('./commands/teamem-sprint.md');
    expect(command).toContain('mcp__teamem__create_sprint');
    expect(command).toContain('mcp__teamem__join_sprint');
    expect(command).toContain('mcp__teamem__leave_sprint');
    expect(command).toContain('mcp__teamem__get_current_sprint');
    expect(command).toContain('mcp__teamem__list_sprints');
    expect(command).toContain('mcp__teamem__archive_sprint');
    expect(command).toContain('mcp__teamem__reopen_sprint');
    expect(command).toContain('mcp__teamem__get_sprint_history');
    expect(command).not.toContain('/teamem-sprint use');
    expect(command).not.toContain('/teamem-sprint off');
    expect(command).not.toContain('mcp__teamem__use_sprint');
    expect(command).not.toContain('mcp__teamem__off_sprint');
  });
});
