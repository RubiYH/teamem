import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadCredentials,
  saveCredentials,
  pickEntry,
  pruneEntry,
  appendEntry,
  checkJwtExp,
  getBridgeDir,
  SessionExpiredError,
  UnknownSpaceError,
  type CredentialEntry,
  type CredentialsFile
} from '../../../src/bridge/credentials.js';

const VALID_ENTRY: CredentialEntry = {
  space_id: 'sp-abc',
  label: 'my-space',
  member_name: 'alice',
  jwt: 'header.payload.sig',
  jwt_exp: Math.floor(Date.now() / 1000) + 3600,
  server_url: 'http://localhost:3000'
};

const VALID_ENTRY_2: CredentialEntry = {
  space_id: 'sp-xyz',
  label: 'other-space',
  member_name: 'alice',
  jwt: 'header2.payload2.sig2',
  jwt_exp: Math.floor(Date.now() / 1000) + 3600,
  server_url: 'http://localhost:3000'
};

let tmpDir: string;
let credPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'teamem-test-'));
  credPath = join(tmpDir, 'credentials.json');
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeFile(overrides: Partial<CredentialsFile> = {}): CredentialsFile {
  return {
    version: 1,
    default_space_id: 'sp-abc',
    spaces: { 'sp-abc': { ...VALID_ENTRY } },
    ...overrides
  };
}

describe('loadCredentials', () => {
  it('returns null when file does not exist', async () => {
    const result = await loadCredentials(credPath);
    expect(result).toBeNull();
  });

  it('returns null for corrupt JSON', async () => {
    await writeFile(credPath, '{ this is not json }', 'utf-8');
    const result = await loadCredentials(credPath);
    expect(result).toBeNull();
  });

  it('returns null for malformed structure (wrong version)', async () => {
    await writeFile(
      credPath,
      JSON.stringify({ version: 2, spaces: {} }),
      'utf-8'
    );
    const result = await loadCredentials(credPath);
    expect(result).toBeNull();
  });

  it('returns null for missing spaces field', async () => {
    await writeFile(credPath, JSON.stringify({ version: 1 }), 'utf-8');
    const result = await loadCredentials(credPath);
    expect(result).toBeNull();
  });

  it('loads a valid credentials file', async () => {
    const creds = makeFile();
    await writeFile(credPath, JSON.stringify(creds), 'utf-8');
    const result = await loadCredentials(credPath);
    expect(result).not.toBeNull();
    expect(result!.version).toBe(1);
    expect(result!.spaces['sp-abc'].member_name).toBe('alice');
  });
});

describe('saveCredentials', () => {
  it('writes file with mode 0600', async () => {
    const creds = makeFile();
    await saveCredentials(creds, credPath);
    const { mode } = await stat(credPath);
    expect(mode & 0o777).toBe(0o600);
  });

  it('round-trips data correctly', async () => {
    const creds = makeFile();
    await saveCredentials(creds, credPath);
    const loaded = await loadCredentials(credPath);
    expect(loaded).not.toBeNull();
    expect(loaded!.default_space_id).toBe('sp-abc');
    expect(loaded!.spaces['sp-abc'].label).toBe('my-space');
  });
});

describe('pickEntry', () => {
  it('picks by --space flag (highest priority)', () => {
    const creds = makeFile({
      default_space_id: 'sp-abc',
      spaces: { 'sp-abc': VALID_ENTRY, 'sp-xyz': VALID_ENTRY_2 }
    });
    const entry = pickEntry({ flag: 'sp-xyz', env: 'sp-abc', creds });
    expect(entry.space_id).toBe('sp-xyz');
  });

  it('picks by TEAMEM_SPACE env when no flag', () => {
    const creds = makeFile({
      default_space_id: 'sp-abc',
      spaces: { 'sp-abc': VALID_ENTRY, 'sp-xyz': VALID_ENTRY_2 }
    });
    const entry = pickEntry({ env: 'sp-xyz', creds });
    expect(entry.space_id).toBe('sp-xyz');
  });

  it('falls back to default_space_id when no flag or env', () => {
    const creds = makeFile({
      default_space_id: 'sp-abc',
      spaces: { 'sp-abc': VALID_ENTRY, 'sp-xyz': VALID_ENTRY_2 }
    });
    const entry = pickEntry({ creds });
    expect(entry.space_id).toBe('sp-abc');
  });

  it('throws UnknownSpaceError for unknown flag', () => {
    const creds = makeFile();
    expect(() => pickEntry({ flag: 'sp-unknown', creds })).toThrow(
      UnknownSpaceError
    );
  });

  it('throws UnknownSpaceError when no default and no selection', () => {
    const creds = makeFile({ default_space_id: null });
    expect(() => pickEntry({ creds })).toThrow(UnknownSpaceError);
  });

  // Real production bug: Claude Code's plugin manifest substitutes
  // `${user_config.<key>}` into the MCP server `env` block. When the user
  // never set that option, some launcher versions pass the literal placeholder
  // through as the env value instead of the empty string. Pre-fix, the bridge
  // tried to resolve a space *named* `${user_config.default_space}` and
  // crashed; the MCP server failed to start in Claude Code.
  it('treats unsubstituted ${user_config.X} env value as unset', () => {
    const creds = makeFile({
      default_space_id: 'sp-abc',
      spaces: { 'sp-abc': VALID_ENTRY }
    });
    const entry = pickEntry({
      env: '${user_config.default_space}',
      creds
    });
    expect(entry.space_id).toBe('sp-abc');
  });

  it('treats unsubstituted ${user_config.X} flag value as unset', () => {
    const creds = makeFile({
      default_space_id: 'sp-abc',
      spaces: { 'sp-abc': VALID_ENTRY }
    });
    const entry = pickEntry({
      flag: '${user_config.default_space}',
      creds
    });
    expect(entry.space_id).toBe('sp-abc');
  });

  it('treats empty-string env value as unset (some launchers blank the var)', () => {
    const creds = makeFile({
      default_space_id: 'sp-abc',
      spaces: { 'sp-abc': VALID_ENTRY }
    });
    const entry = pickEntry({ env: '', creds });
    expect(entry.space_id).toBe('sp-abc');
  });
});

describe('pruneEntry', () => {
  it('removes the specified entry from the file', async () => {
    const creds = makeFile({
      default_space_id: 'sp-abc',
      spaces: { 'sp-abc': VALID_ENTRY, 'sp-xyz': VALID_ENTRY_2 }
    });
    await saveCredentials(creds, credPath);

    await pruneEntry('sp-xyz', credPath);

    const loaded = await loadCredentials(credPath);
    expect(loaded!.spaces['sp-xyz']).toBeUndefined();
    expect(loaded!.spaces['sp-abc']).toBeDefined();
  });

  it('updates default_space_id when pruning the default', async () => {
    const creds = makeFile({
      default_space_id: 'sp-abc',
      spaces: { 'sp-abc': VALID_ENTRY, 'sp-xyz': VALID_ENTRY_2 }
    });
    await saveCredentials(creds, credPath);

    await pruneEntry('sp-abc', credPath);

    const loaded = await loadCredentials(credPath);
    expect(loaded!.default_space_id).toBe('sp-xyz');
  });

  it('sets default_space_id to null when last entry is pruned', async () => {
    const creds = makeFile();
    await saveCredentials(creds, credPath);

    await pruneEntry('sp-abc', credPath);

    const loaded = await loadCredentials(credPath);
    expect(loaded!.default_space_id).toBeNull();
    expect(Object.keys(loaded!.spaces)).toHaveLength(0);
  });

  it('is a no-op when credentials file does not exist', async () => {
    await expect(pruneEntry('sp-abc', credPath)).resolves.toBeUndefined();
  });
});

describe('appendEntry', () => {
  it('creates credentials file if it does not exist', async () => {
    await appendEntry(VALID_ENTRY, credPath);
    const loaded = await loadCredentials(credPath);
    expect(loaded).not.toBeNull();
    expect(loaded!.spaces['sp-abc']).toBeDefined();
    expect(loaded!.default_space_id).toBe('sp-abc');
  });

  it('sets as default when first entry', async () => {
    await appendEntry(VALID_ENTRY, credPath);
    const loaded = await loadCredentials(credPath);
    expect(loaded!.default_space_id).toBe('sp-abc');
  });

  it('does not change default when not the first entry', async () => {
    await appendEntry(VALID_ENTRY, credPath);
    await appendEntry(VALID_ENTRY_2, credPath);
    const loaded = await loadCredentials(credPath);
    expect(loaded!.default_space_id).toBe('sp-abc');
  });
});

describe('bridge_dir field', () => {
  it('round-trips bridge_dir correctly', async () => {
    const creds = makeFile({ bridge_dir: '/some/repo/path' });
    await saveCredentials(creds, credPath);
    const loaded = await loadCredentials(credPath);
    expect(loaded).not.toBeNull();
    expect(loaded!.bridge_dir).toBe('/some/repo/path');
  });

  it('tolerates missing bridge_dir field', async () => {
    const creds = makeFile();
    await saveCredentials(creds, credPath);
    const loaded = await loadCredentials(credPath);
    expect(loaded).not.toBeNull();
    expect(loaded!.bridge_dir).toBeUndefined();
  });

  it('rejects empty string bridge_dir', async () => {
    await writeFile(
      credPath,
      JSON.stringify({
        version: 1,
        default_space_id: null,
        spaces: {},
        bridge_dir: ''
      }),
      'utf-8'
    );
    const loaded = await loadCredentials(credPath);
    expect(loaded).toBeNull();
  });
});

describe('getBridgeDir', () => {
  it('returns bridge_dir when set', async () => {
    const creds = makeFile({ bridge_dir: '/repo/root' });
    await saveCredentials(creds, credPath);
    const dir = await getBridgeDir(credPath);
    expect(dir).toBe('/repo/root');
  });

  it('returns null when bridge_dir is not present', async () => {
    const creds = makeFile();
    await saveCredentials(creds, credPath);
    const dir = await getBridgeDir(credPath);
    expect(dir).toBeNull();
  });

  it('returns null when credentials file does not exist', async () => {
    const dir = await getBridgeDir(credPath);
    expect(dir).toBeNull();
  });
});

describe('checkJwtExp', () => {
  it('does not throw for a valid (future) jwt_exp', () => {
    const entry = {
      ...VALID_ENTRY,
      jwt_exp: Math.floor(Date.now() / 1000) + 3600
    };
    expect(() => checkJwtExp(entry)).not.toThrow();
  });

  it('throws SessionExpiredError for a past jwt_exp', () => {
    const entry = {
      ...VALID_ENTRY,
      jwt_exp: Math.floor(Date.now() / 1000) - 1
    };
    expect(() => checkJwtExp(entry)).toThrow(SessionExpiredError);
  });

  it('SessionExpiredError message matches AC13', () => {
    const entry = { ...VALID_ENTRY, jwt_exp: 0 };
    try {
      checkJwtExp(entry);
      expect(true).toBe(false);
    } catch (err) {
      expect((err as Error).message).toBe(
        "Session expired — run 'bun run setup' to renew."
      );
    }
  });
});
