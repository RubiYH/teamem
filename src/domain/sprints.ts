export type SprintStatus = 'active' | 'archived';

export type SprintContextMode =
  | { mode: 'space'; sprint: null }
  | { mode: 'sprint'; sprint: SprintSummary };

export type SprintSummary = {
  sprint_id: string;
  slug: string;
  display_name: string;
  goal: string;
  status: SprintStatus;
};

export type SprintValidationResult =
  | { ok: true; display_name: string; goal: string; slug: string }
  | { ok: false; code: string; message: string };

export function deriveSprintSlug(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function validateSprintDraft(input: {
  display_name: unknown;
  goal: unknown;
}): SprintValidationResult {
  if (typeof input.display_name !== 'string') {
    return {
      ok: false,
      code: 'invalid_sprint_name',
      message: 'display_name must be a string'
    };
  }
  if (typeof input.goal !== 'string') {
    return {
      ok: false,
      code: 'invalid_sprint_goal',
      message: 'goal must be a string'
    };
  }

  const display_name = input.display_name.trim();
  const goal = input.goal.trim();
  if (display_name.length === 0) {
    return {
      ok: false,
      code: 'invalid_sprint_name',
      message: 'display_name must be non-empty after trim'
    };
  }
  if (display_name.length > 80) {
    return {
      ok: false,
      code: 'invalid_sprint_name',
      message: 'display_name must be at most 80 characters'
    };
  }
  if (goal.length === 0) {
    return {
      ok: false,
      code: 'invalid_sprint_goal',
      message: 'goal must be non-empty after trim'
    };
  }
  if (goal.length > 500) {
    return {
      ok: false,
      code: 'invalid_sprint_goal',
      message: 'goal must be at most 500 characters'
    };
  }

  const slug = deriveSprintSlug(display_name);
  if (slug.length === 0) {
    return {
      ok: false,
      code: 'invalid_sprint_slug',
      message: 'display_name must normalize to a non-empty slug'
    };
  }

  return { ok: true, display_name, goal, slug };
}
