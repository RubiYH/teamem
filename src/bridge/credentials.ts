import { readFile, chmod, mkdir, rename, open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export interface CredentialEntry {
  space_id: string;
  label: string;
  member_name: string;
  jwt: string;
  jwt_exp: number;
  server_url: string;
}

export interface CredentialsFile {
  version: 1;
  default_space_id: string | null;
  bridge_dir?: string;
  spaces: Record<string, CredentialEntry>;
}

export class SessionExpiredError extends Error {
  constructor() {
    super("Session expired — run 'bun run setup' to renew.");
    this.name = 'SessionExpiredError';
  }
}

export class UnknownSpaceError extends Error {
  constructor(id: string) {
    super(
      `Space '${id}' not found in credentials.json. Run 'bun run setup' to add it.`
    );
    this.name = 'UnknownSpaceError';
  }
}

/**
 * Codex F11 — `default_space` / `--space` / `TEAMEM_SPACE` accept either a
 * `space_id` (ULID) or a human-readable `label` (the user-facing name shown
 * in the marketplace install prompt). When two entries share the same label
 * we cannot disambiguate, so `pickEntry` throws this typed error listing
 * every matching `space_id` so the caller can pick one explicitly.
 */
export class AmbiguousSpaceLabelError extends Error {
  readonly label: string;
  readonly matching_ids: string[];
  constructor(label: string, matching_ids: string[]) {
    super(
      `Space label '${label}' is ambiguous — matches ${matching_ids.length} entries. ` +
        `Pass --space <id> or set TEAMEM_SPACE to one of: ${matching_ids.join(', ')}.`
    );
    this.name = 'AmbiguousSpaceLabelError';
    this.label = label;
    this.matching_ids = matching_ids;
  }
}

export function defaultCredentialsPath(): string {
  // TEAMEM_CREDENTIALS lets a single user run multiple personas on one machine
  // (test fixtures, dev double-checks) without overriding HOME — overriding
  // HOME breaks native Claude Code installs that resolve their CLI under
  // $HOME/.local/bin.
  //
  // Defense-in-depth: if Claude Code ever passes an unsubstituted plugin
  // manifest placeholder (e.g. `${user_config.credentials_path}`) into this
  // env var, treat it as unset and fall back to the homedir default rather
  // than trying to read a literally-named file.
  const raw = process.env.TEAMEM_CREDENTIALS;
  const looksLikePlaceholder =
    typeof raw === 'string' && /^\$\{[^}]*\}$/.test(raw.trim());
  if (raw && !looksLikePlaceholder && raw.trim().length > 0) {
    return raw;
  }
  return join(homedir(), '.teamem', 'credentials.json');
}

export async function loadCredentials(
  credPath?: string
): Promise<CredentialsFile | null> {
  const path = credPath ?? defaultCredentialsPath();
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isCredentialsFile(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isCredentialsFile(v: unknown): v is CredentialsFile {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (obj.version !== 1) return false;
  if (typeof obj.spaces !== 'object' || obj.spaces === null) return false;
  if (
    'bridge_dir' in obj &&
    (typeof obj.bridge_dir !== 'string' || obj.bridge_dir === '')
  )
    return false;
  return true;
}

export async function getBridgeDir(credPath?: string): Promise<string | null> {
  const creds = await loadCredentials(credPath);
  return creds?.bridge_dir ?? null;
}

export async function saveCredentials(
  creds: CredentialsFile,
  credPath?: string
): Promise<void> {
  const path = credPath ?? defaultCredentialsPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  // Atomic write: write to .tmp, fsync, rename. Prevents readers from
  // observing a half-written credentials file if the process is killed
  // mid-write (or if two CLI commands race).
  const tmpPath = `${path}.tmp`;
  const data = JSON.stringify(creds, null, 2);

  // Open with mode 0o600 so the tmp file is restrictive from creation.
  const handle = await open(tmpPath, 'w', 0o600);
  try {
    await handle.writeFile(data, 'utf-8');
    // Force durability of file contents before rename — the rename itself
    // is atomic on POSIX, but only the contents already on disk survive a
    // crash mid-rename.
    await handle.sync();
  } finally {
    await handle.close();
  }

  await rename(tmpPath, path);
  // Belt-and-braces: ensure mode survives umask/older filesystems.
  await chmod(path, 0o600);
}

export function pickEntry(opts: {
  flag?: string;
  env?: string;
  creds: CredentialsFile;
}): CredentialEntry {
  const { flag, env, creds } = opts;

  // Priority: --space flag > TEAMEM_SPACE env > default_space_id.
  // Single-entry default is satisfied implicitly: appendEntry() always sets
  // default_space_id when the first entry is added, so a credentials.json
  // with exactly one entry resolves to that entry without flag/env.
  //
  // Claude Code's plugin manifest substitutes `${user_config.<key>}` into
  // the MCP server `env` block. When the user has not set the option, some
  // launcher versions pass the literal placeholder through instead of an
  // empty string, breaking space resolution. Treat any unsubstituted
  // placeholder as "not provided" so the bridge falls back to default_space_id.
  const isPlaceholder = (v: unknown): boolean =>
    typeof v === 'string' && /^\$\{[^}]*\}$/.test(v.trim());
  const flagOrFallback = isPlaceholder(flag) ? undefined : flag;
  const envOrFallback = isPlaceholder(env) ? undefined : env;
  const input =
    flagOrFallback ??
    (envOrFallback && envOrFallback.length > 0 ? envOrFallback : undefined) ??
    creds.default_space_id;

  if (!input) {
    throw new UnknownSpaceError('(none)');
  }

  // Codex F11: accept either `space_id` (ULID, the historical key) or
  // `label` (the human-readable name surfaced in the marketplace install
  // prompt). Try space_id first — it's the unambiguous case and matches
  // pre-#20 behavior — then fall back to a label scan.
  const byId = creds.spaces[input];
  if (byId) return byId;

  const labelMatches = Object.entries(creds.spaces)
    .filter(([, entry]) => entry.label === input)
    .map(([id]) => id);
  if (labelMatches.length === 1) {
    return creds.spaces[labelMatches[0]!]!;
  }
  if (labelMatches.length > 1) {
    throw new AmbiguousSpaceLabelError(input, labelMatches);
  }

  throw new UnknownSpaceError(input);
}

export async function pruneEntry(
  space_id: string,
  credPath?: string
): Promise<void> {
  const creds = await loadCredentials(credPath);
  if (!creds) return;

  delete creds.spaces[space_id];

  if (creds.default_space_id === space_id) {
    const remaining = Object.keys(creds.spaces);
    creds.default_space_id = remaining.length > 0 ? remaining[0] : null;
  }

  await saveCredentials(creds, credPath);
}

export async function appendEntry(
  entry: CredentialEntry,
  credPath?: string
): Promise<void> {
  let creds = await loadCredentials(credPath);
  if (!creds) {
    creds = { version: 1, default_space_id: null, spaces: {} };
  }

  creds.spaces[entry.space_id] = entry;

  if (!creds.default_space_id) {
    creds.default_space_id = entry.space_id;
  }

  await saveCredentials(creds, credPath);
}

export function checkJwtExp(entry: CredentialEntry): void {
  const nowSec = Math.floor(Date.now() / 1000);
  if (entry.jwt_exp <= nowSec) {
    throw new SessionExpiredError();
  }
}
