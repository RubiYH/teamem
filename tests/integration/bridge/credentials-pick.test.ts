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
import {
  resolveCallCredential,
  stampIdentity
} from '../../../src/bridge/index.js';

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
let originalTeamemCredentials: string | undefined;

beforeEach(async () => {
  originalTeamemCredentials = process.env.TEAMEM_CREDENTIALS;
  tmpDir = await mkdtemp(join(tmpdir(), 'teamem-integ-'));
  credPath = join(tmpDir, 'credentials.json');
});

afterEach(async () => {
  if (originalTeamemCredentials === undefined) {
    delete process.env.TEAMEM_CREDENTIALS;
  } else {
    process.env.TEAMEM_CREDENTIALS = originalTeamemCredentials;
  }
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

  it('per-call MCP space overrides bridge startup/env/default resolution', async () => {
    const creds: CredentialsFile = {
      version: 1,
      default_space_id: 'sp-aaa',
      spaces: { 'sp-aaa': BASE_ENTRY, 'sp-bbb': ENTRY_B }
    };
    await writeFile(credPath, JSON.stringify(creds), 'utf-8');
    process.env.TEAMEM_CREDENTIALS = credPath;

    const entry = await resolveCallCredential(
      { TEAMEM_SPACE: 'sp-aaa' },
      BASE_ENTRY,
      { space: 'sp-bbb', token_budget: 2000 }
    );

    expect(entry.space_id).toBe('sp-bbb');
    expect(entry.label).toBe('team-beta');
  });

  it('strips bridge-only space routing before forwarding tool input', () => {
    expect(
      stampIdentity(
        {
          space: 'sp-bbb',
          space_id: 'forged-space',
          principal: 'mallory',
          token_budget: 2000
        },
        'sp-bbb',
        'alice'
      )
    ).toEqual({ token_budget: 2000 });
  });
});
