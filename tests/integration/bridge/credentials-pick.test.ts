import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadCredentials,
  saveCredentials,
  pickEntry,
  pruneEntry,
  UnknownSpaceError,
  type CredentialEntry,
  type CredentialsFile
} from '../../../src/bridge/credentials.js';

const BASE_ENTRY: CredentialEntry = {
  space_id: 'sp-aaa',
  label: 'team-alpha',
  member_name: 'alice',
  jwt: 'h.p.s',
  jwt_exp: Math.floor(Date.now() / 1000) + 3600,
  server_url: 'http://localhost:3000'
};

const ENTRY_B: CredentialEntry = {
  space_id: 'sp-bbb',
  label: 'team-beta',
  member_name: 'alice',
  jwt: 'h2.p2.s2',
  jwt_exp: Math.floor(Date.now() / 1000) + 3600,
  server_url: 'http://localhost:3001'
};

let tmpDir: string;
let credPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'teamem-integ-'));
  credPath = join(tmpDir, 'credentials.json');
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('AC12 — credential pick priority', () => {
  it('--space flag takes precedence over env and default', async () => {
    const creds: CredentialsFile = {
      version: 1,
      default_space_id: 'sp-aaa',
      spaces: { 'sp-aaa': BASE_ENTRY, 'sp-bbb': ENTRY_B }
    };
    await writeFile(credPath, JSON.stringify(creds), 'utf-8');

    const loaded = await loadCredentials(credPath);
    expect(loaded).not.toBeNull();

    const entry = pickEntry({ flag: 'sp-bbb', env: 'sp-aaa', creds: loaded! });
    expect(entry.space_id).toBe('sp-bbb');
    expect(entry.label).toBe('team-beta');
  });

  it('TEAMEM_SPACE env takes precedence over default', async () => {
    const creds: CredentialsFile = {
      version: 1,
      default_space_id: 'sp-aaa',
      spaces: { 'sp-aaa': BASE_ENTRY, 'sp-bbb': ENTRY_B }
    };
    await writeFile(credPath, JSON.stringify(creds), 'utf-8');

    const loaded = await loadCredentials(credPath);
    const entry = pickEntry({ env: 'sp-bbb', creds: loaded! });
    expect(entry.space_id).toBe('sp-bbb');
  });

  it('falls back to default_space_id when no flag or env', async () => {
    const creds: CredentialsFile = {
      version: 1,
      default_space_id: 'sp-aaa',
      spaces: { 'sp-aaa': BASE_ENTRY, 'sp-bbb': ENTRY_B }
    };
    await writeFile(credPath, JSON.stringify(creds), 'utf-8');

    const loaded = await loadCredentials(credPath);
    const entry = pickEntry({ creds: loaded! });
    expect(entry.space_id).toBe('sp-aaa');
    expect(entry.member_name).toBe('alice');
  });

  it('throws when flag references unknown space', async () => {
    const creds: CredentialsFile = {
      version: 1,
      default_space_id: 'sp-aaa',
      spaces: { 'sp-aaa': BASE_ENTRY }
    };
    await writeFile(credPath, JSON.stringify(creds), 'utf-8');

    const loaded = await loadCredentials(credPath);
    expect(() => pickEntry({ flag: 'sp-notexist', creds: loaded! })).toThrow(
      UnknownSpaceError
    );
  });

  it('prune + pick: after prune, default shifts to remaining entry', async () => {
    const creds: CredentialsFile = {
      version: 1,
      default_space_id: 'sp-aaa',
      spaces: { 'sp-aaa': BASE_ENTRY, 'sp-bbb': ENTRY_B }
    };
    await saveCredentials(creds, credPath);

    await pruneEntry('sp-aaa', credPath);

    const loaded = await loadCredentials(credPath);
    expect(loaded!.default_space_id).toBe('sp-bbb');
    const entry = pickEntry({ creds: loaded! });
    expect(entry.space_id).toBe('sp-bbb');
  });
});
