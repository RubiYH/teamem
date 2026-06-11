/**
 * Codex F9 regression — `plugin/skills/teamem-onboarding/SKILL.md` must
 * not require `CLAUDE_PLUGIN_OPTION_TEAMEM_ROOT` and must instruct the
 * agent to invoke the bundled setup CLI at `${CLAUDE_PLUGIN_ROOT}/lib/setup.js`.
 *
 * Original bug: the skill body said "if `CLAUDE_PLUGIN_OPTION_TEAMEM_ROOT`
 * is unset, stop and instruct the user to set it." Marketplace users
 * without source checkout failed at the skill stage even though the
 * `/teamem:setup` slash command shell was clean post-#18.
 *
 * Fix: the skill body now references `${CLAUDE_PLUGIN_ROOT}/lib/setup.js`
 * directly. No `CLAUDE_PLUGIN_OPTION_TEAMEM_ROOT` precondition. No
 * `bun run setup --check` references. No `bridge_dir` mentions.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SKILL_PATH = resolve(
  import.meta.dir,
  '../../plugin/skills/teamem-onboarding/SKILL.md'
);

describe('teamem-onboarding skill works without source-tree config (Codex F9)', () => {
  it('skill body has no functional CLAUDE_PLUGIN_OPTION_TEAMEM_ROOT precondition', () => {
    const text = readFileSync(SKILL_PATH, 'utf-8');
    expect(text).not.toContain('CLAUDE_PLUGIN_OPTION_TEAMEM_ROOT');
    expect(text).not.toContain('teamem_root');
  });

  it('skill body does not reference the deleted `bun run setup --check` step', () => {
    const text = readFileSync(SKILL_PATH, 'utf-8');
    expect(text).not.toContain('bun run setup --check');
    // Also no bridge_dir gating language.
    expect(text).not.toContain('bridge_dir');
  });

  it('skill body instructs the agent to invoke the bundled setup CLI', () => {
    const text = readFileSync(SKILL_PATH, 'utf-8');
    expect(text).toContain('${CLAUDE_PLUGIN_ROOT}/lib/setup.js');
    expect(text).toContain('bun run');
  });

  it('skill frontmatter is intact (name + description present)', () => {
    const text = readFileSync(SKILL_PATH, 'utf-8');
    // Frontmatter is the first --- … --- block.
    const fm = text.match(/^---\n([\s\S]*?)\n---/);
    expect(fm).not.toBeNull();
    if (fm) {
      expect(fm[1]).toContain('name: teamem-onboarding');
      expect(fm[1]).toContain('description:');
    }
  });
});
