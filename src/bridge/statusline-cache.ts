import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const FORMAT_VERSION = 1;
const DEFAULT_FRESHNESS_MS = 5 * 60 * 1000;
const STATUSLINE_CACHE_RELATIVE_PATH = join('statusline', 'display.json');

const CACHEABLE_TOOLS = new Set([
  'teamem.whoami',
  'teamem.session_sync',
  'teamem.get_briefing',
  'teamem.get_current_sprint',
  'teamem.create_sprint',
  'teamem.join_sprint',
  'teamem.leave_sprint',
  'teamem.reopen_sprint'
]);

const AUTHORITATIVE_CURRENT_CONTEXT_TOOLS = new Set([
  'teamem.get_briefing',
  'teamem.get_current_sprint',
  'teamem.create_sprint',
  'teamem.join_sprint',
  'teamem.leave_sprint',
  'teamem.reopen_sprint'
]);

export interface StatuslineCacheCredential {
  readonly space_id?: string;
  readonly label?: string;
}

export interface StatuslineCacheOptions {
  readonly credential?: StatuslineCacheCredential;
  readonly env?: Record<string, string | undefined>;
  readonly cwd?: string;
  readonly now?: Date;
  readonly freshnessMs?: number;
}

export function writeStatuslineDisplayCacheFromToolResponse(
  toolName: string,
  response: unknown,
  options: StatuslineCacheOptions = {}
): boolean {
  if (!CACHEABLE_TOOLS.has(toolName)) return false;
  const target = resolveCacheTarget(options.env ?? process.env);
  if (!target) return false;
  if (!isOkToolResponse(response)) return false;

  const data = response.data as Record<string, unknown>;
  const canUpdateSprint = AUTHORITATIVE_CURRENT_CONTEXT_TOOLS.has(toolName);
  const space =
    extractSpace(data) ?? normalizeSpace(options.credential ?? undefined);
  const sprint = canUpdateSprint ? extractSprint(data) : undefined;
  const canClearCurrentSprint = canUpdateSprint && hasCurrentSpaceContext(data);

  if (!space && !sprint && !canClearCurrentSprint) return false;

  const now = options.now ?? new Date();
  if (!canUpdateSprint) {
    const cachedFreshSprintSpace = readFreshSprintCacheSpace(target, now);
    if (cachedFreshSprintSpace && spaceMatches(space, cachedFreshSprintSpace)) {
      return false;
    }
  }
  const freshUntil = new Date(
    now.getTime() + (options.freshnessMs ?? DEFAULT_FRESHNESS_MS)
  );
  const record = {
    format_version: FORMAT_VERSION,
    updated_at: now.toISOString(),
    fresh_until: freshUntil.toISOString(),
    identity: {
      ...stringProp('project_key', options.env?.TEAMEM_PROJECT_KEY),
      ...stringProp('session_id', options.env?.CLAUDE_SESSION_ID),
      ...stringProp(
        'workspace_current_dir',
        options.cwd ?? options.env?.PWD ?? process.cwd()
      )
    },
    ...(space ? { space } : {}),
    ...(sprint ? { sprint } : {})
  };

  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

function resolveCacheTarget(
  env: Record<string, string | undefined>
): string | undefined {
  if (env.TEAMEM_STATUSLINE_CACHE) return env.TEAMEM_STATUSLINE_CACHE;
  if (env.TEAMEM_DATA) {
    return join(env.TEAMEM_DATA, STATUSLINE_CACHE_RELATIVE_PATH);
  }
  if (
    env.CLAUDE_PLUGIN_DATA &&
    looksLikeTeamemDataDir(env.CLAUDE_PLUGIN_DATA)
  ) {
    return join(env.CLAUDE_PLUGIN_DATA, STATUSLINE_CACHE_RELATIVE_PATH);
  }
  return undefined;
}

function looksLikeTeamemDataDir(value: string): boolean {
  return basename(value).toLowerCase().includes('teamem');
}

function readFreshSprintCacheSpace(target: string, now: Date) {
  try {
    const parsed = JSON.parse(readFileSync(target, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    if (record.format_version !== FORMAT_VERSION) return undefined;
    const freshUntil =
      typeof record.fresh_until === 'string'
        ? Date.parse(record.fresh_until)
        : Number.NaN;
    const hasFreshSprint =
      Number.isFinite(freshUntil) &&
      freshUntil > now.getTime() &&
      !!normalizeSprint(record.sprint);
    return hasFreshSprint ? normalizeSpace(record.space) : undefined;
  } catch {
    return undefined;
  }
}

function isOkToolResponse(
  value: unknown
): value is { ok: true; data: Record<string, unknown> } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.ok === true &&
    !!record.data &&
    typeof record.data === 'object' &&
    !Array.isArray(record.data)
  );
}

function extractSpace(data: Record<string, unknown>) {
  const candidates = [
    data.space,
    data.current_space,
    nestedRecord(data.context, 'space'),
    data.whoami,
    nestedRecord(data.space_rules_snapshot, 'metadata'),
    data
  ];
  for (const candidate of candidates) {
    const normalized = normalizeSpace(candidate);
    if (normalized) return normalized;
  }
  return undefined;
}

function extractSprint(data: Record<string, unknown>) {
  const currentContexts = [
    data.context,
    data.current_context,
    data.new_context
  ];
  for (const context of currentContexts) {
    const normalized = normalizeSprintFromContext(context);
    if (normalized) return normalized;
  }
  return undefined;
}

function hasCurrentSpaceContext(data: Record<string, unknown>): boolean {
  return [data.context, data.current_context, data.new_context].some(
    (context) => {
      if (!context || typeof context !== 'object' || Array.isArray(context)) {
        return false;
      }
      const mode =
        stringValue((context as Record<string, unknown>).mode) ??
        stringValue((context as Record<string, unknown>).type);
      return mode === 'space';
    }
  );
}

function normalizeSprintFromContext(context: unknown) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    return undefined;
  }
  const record = context as Record<string, unknown>;
  const mode = stringValue(record.mode) ?? stringValue(record.type);
  if (mode !== 'sprint') return undefined;
  return normalizeSprint(record.sprint);
}

function normalizeSprint(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id = stringValue(record.sprint_id) ?? stringValue(record.id);
  const slug = stringValue(record.slug);
  const name =
    stringValue(record.display_name) ?? stringValue(record.name) ?? slug ?? id;
  return name
    ? {
        ...(id ? { sprint_id: id } : {}),
        ...(slug ? { slug } : {}),
        display_name: name
      }
    : undefined;
}

function normalizeSpace(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id =
    stringValue(record.id) ??
    stringValue(record.space_id) ??
    stringValue(record.spaceId);
  const label =
    stringValue(record.label) ??
    stringValue(record.space_label) ??
    stringValue(record.spaceLabel) ??
    id;
  return label ? { ...(id ? { id } : {}), label } : undefined;
}

function spaceMatches(
  incoming: ReturnType<typeof normalizeSpace>,
  cached: ReturnType<typeof normalizeSpace>
): boolean {
  if (!incoming || !cached) return false;
  if (incoming.id && cached.id) return incoming.id === cached.id;
  return incoming.label === cached.label;
}

function nestedRecord(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringProp(key: string, value: unknown): Record<string, string> {
  const normalized = stringValue(value);
  return normalized ? { [key]: normalized } : {};
}
