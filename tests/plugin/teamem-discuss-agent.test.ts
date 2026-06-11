import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../..');

describe('/teamem:discuss direct send contract', () => {
  it('uses only direct post_message and documents malformed-input stop cases', () => {
    const command = readFileSync(
      join(REPO_ROOT, 'plugin/commands/discuss.md'),
      'utf-8'
    );

    expect(command).toContain(
      'allowed-tools: mcp__teamem__teamem_post_message'
    );
    expect(command).not.toContain('mcp__teamem__teamem_read_thread');
    expect(command).not.toContain('mcp__teamem__teamem_get_briefing');
    expect(command).not.toContain('teamem-negotiator');
    expect(command).not.toContain('teamem-call');
    expect(command).toContain('If `--` is missing');
    expect(command).toContain('recipient token before `--` is empty');
    expect(command).toContain('topic after `--` is empty or whitespace-only');
  });

  it('documents broadcast input without string-null ambiguity', () => {
    const command = readFileSync(
      join(REPO_ROOT, 'plugin/commands/discuss.md'),
      'utf-8'
    );

    expect(command).toContain(
      'If the recipient token is `*`, this is a broadcast. Omit `recipient_principal`'
    );
    expect(command).toContain('Never pass `"null"` as a string');
    expect(command).toContain('For broadcasts, call');
    expect(command).toContain('For direct sends, call');
  });

  it('does not route discuss through the postponed negotiator helper', () => {
    const hooks = readFileSync(
      join(REPO_ROOT, 'plugin/hooks/hooks.json'),
      'utf-8'
    );

    expect(
      existsSync(join(REPO_ROOT, 'plugin/agents/teamem-negotiator.md'))
    ).toBe(false);
    expect(hooks).not.toContain('teamem-negotiator subagent');
    expect(hooks).not.toContain('teamem_reply');
  });
});
