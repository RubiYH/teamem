import { describe, expect, it } from 'bun:test';
import {
  deriveSprintSlug,
  validateSprintDraft
} from '../../../src/domain/sprints.js';

describe('sprint domain validation', () => {
  it('derives lowercase dash-collapsed slugs from display names', () => {
    expect(deriveSprintSlug('  Sprint: MVP + Lifecycle!! ')).toBe(
      'sprint-mvp-lifecycle'
    );
    expect(deriveSprintSlug('A---B___C')).toBe('a-b-c');
  });

  it('trims names and goals and accepts boundary lengths', () => {
    const result = validateSprintDraft({
      display_name: ` ${'A'.repeat(80)} `,
      goal: ` ${'G'.repeat(500)} `
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.display_name).toHaveLength(80);
      expect(result.goal).toHaveLength(500);
      expect(result.slug).toBe('a'.repeat(80));
    }
  });

  it('rejects empty, overlong, and empty-normalized values', () => {
    expect(
      validateSprintDraft({ display_name: '   ', goal: 'valid' })
    ).toMatchObject({ ok: false, code: 'invalid_sprint_name' });
    expect(
      validateSprintDraft({ display_name: 'x'.repeat(81), goal: 'valid' })
    ).toMatchObject({ ok: false, code: 'invalid_sprint_name' });
    expect(
      validateSprintDraft({ display_name: 'Valid', goal: ' '.repeat(2) })
    ).toMatchObject({ ok: false, code: 'invalid_sprint_goal' });
    expect(
      validateSprintDraft({ display_name: 'Valid', goal: 'g'.repeat(501) })
    ).toMatchObject({ ok: false, code: 'invalid_sprint_goal' });
    expect(
      validateSprintDraft({ display_name: '!!!', goal: 'valid' })
    ).toMatchObject({ ok: false, code: 'invalid_sprint_slug' });
  });
});
