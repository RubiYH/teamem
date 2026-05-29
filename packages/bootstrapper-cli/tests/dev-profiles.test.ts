import { describe, expect, it } from 'bun:test';

import {
  createDevProfile,
  deleteDevProfile,
  listDevProfiles,
  resolveDevProfilePaths,
  selectDevProfile,
  validateDevProfileDeleteTarget,
  validateDevProfileName,
  type DevProfileFileSystem
} from '../src/dev-profiles.js';

describe('dev profile model', () => {
  it('validates safe profile slugs', () => {
    for (const name of ['alice', 'alice-1', 'bob_2', 'a'.repeat(64)]) {
      expect(validateDevProfileName(name)).toEqual({ ok: true, value: name });
    }

    for (const name of [
      '',
      '.',
      '..',
      '../alice',
      'alice/bob',
      'alice\\bob',
      '/alice',
      'Alice',
      'alice.',
      '-alice',
      'a'.repeat(65)
    ]) {
      expect(validateDevProfileName(name).ok).toBe(false);
    }
  });

  it('resolves profile-owned paths under the machine-local dev profile root', () => {
    const paths = resolveDevProfilePaths({
      homeDir: '/tmp/home',
      profileName: 'alice'
    });

    expect(paths).toEqual({
      profileName: 'alice',
      profilesRoot: '/tmp/home/.teamem/dev-profiles',
      profileRoot: '/tmp/home/.teamem/dev-profiles/alice',
      claudeConfigDir: '/tmp/home/.teamem/dev-profiles/alice/claude',
      pluginCacheDir: '/tmp/home/.teamem/dev-profiles/alice/claude/plugins',
      pluginDataDir: '/tmp/home/.teamem/dev-profiles/alice/plugin-data/teamem',
      credentialsPath: '/tmp/home/.teamem/dev-profiles/alice/credentials.json',
      mcpConfigPath: '/tmp/home/.teamem/dev-profiles/alice/mcp.json',
      metadataPath: '/tmp/home/.teamem/dev-profiles/alice/metadata.json',
      logsDir: '/tmp/home/.teamem/dev-profiles/alice/logs'
    });
  });

  it('lists only valid profile directories', () => {
    const fileSystem = createProfileFileSystem({
      directories: [
        '/tmp/home/.teamem/dev-profiles/alice',
        '/tmp/home/.teamem/dev-profiles/bob_2',
        '/tmp/home/.teamem/dev-profiles/../escaped',
        '/tmp/home/.teamem/dev-profiles/NotASlug'
      ],
      files: ['/tmp/home/.teamem/dev-profiles/carol']
    });

    expect(listDevProfiles({ homeDir: '/tmp/home', fileSystem })).toEqual([
      {
        name: 'alice',
        path: '/tmp/home/.teamem/dev-profiles/alice',
        metadataPath: '/tmp/home/.teamem/dev-profiles/alice/metadata.json'
      },
      {
        name: 'bob_2',
        path: '/tmp/home/.teamem/dev-profiles/bob_2',
        metadataPath: '/tmp/home/.teamem/dev-profiles/bob_2/metadata.json'
      }
    ]);
  });

  it('creates profile directories and metadata without touching global state', () => {
    const fileSystem = createProfileFileSystem();

    const result = createDevProfile({
      homeDir: '/tmp/home',
      profileName: 'alice',
      fileSystem,
      now: () => new Date('2026-05-29T00:00:00.000Z')
    });

    expect(result.ok).toBe(true);
    expect(fileSystem.directories).toContain('/tmp/home/.teamem/dev-profiles');
    expect(fileSystem.directories).toContain(
      '/tmp/home/.teamem/dev-profiles/alice'
    );
    expect(fileSystem.directories).toContain(
      '/tmp/home/.teamem/dev-profiles/alice/claude'
    );
    expect(fileSystem.directories).toContain(
      '/tmp/home/.teamem/dev-profiles/alice/claude/plugins'
    );
    expect(fileSystem.directories).toContain(
      '/tmp/home/.teamem/dev-profiles/alice/plugin-data/teamem'
    );
    expect(fileSystem.directories).toContain(
      '/tmp/home/.teamem/dev-profiles/alice/logs'
    );
    expect(
      fileSystem.files.get('/tmp/home/.teamem/dev-profiles/alice/metadata.json')
    ).toBe(
      '{\n  "version": 1,\n  "profile": "alice",\n  "createdAt": "2026-05-29T00:00:00.000Z"\n}\n'
    );
    expect(fileSystem.files.has('/tmp/home/.teamem/credentials.json')).toBe(
      false
    );
  });

  it('selects requested, existing, or newly created profiles according to mode', () => {
    const fileSystem = createProfileFileSystem({
      directories: ['/tmp/home/.teamem/dev-profiles/alice']
    });

    expect(
      selectDevProfile({
        homeDir: '/tmp/home',
        requestedProfile: 'bob',
        allowCreate: true,
        fileSystem
      })
    ).toMatchObject({ ok: true, profileName: 'bob', created: true });

    expect(fileSystem.directories).toContain(
      '/tmp/home/.teamem/dev-profiles/bob'
    );

    expect(
      selectDevProfile({
        homeDir: '/tmp/home',
        allowCreate: false,
        fileSystem,
        prompt: () => '1'
      })
    ).toMatchObject({ ok: true, profileName: 'alice', created: false });

    expect(
      selectDevProfile({
        homeDir: '/tmp/home',
        allowCreate: true,
        fileSystem,
        prompt: () => 'charlie',
        now: () => new Date('2026-05-29T00:00:00.000Z')
      })
    ).toMatchObject({ ok: true, profileName: 'charlie', created: true });

    const deleteFileSystem = createProfileFileSystem({
      directories: ['/tmp/home/.teamem/dev-profiles/alice']
    });

    expect(
      selectDevProfile({
        homeDir: '/tmp/home',
        requestedProfile: 'missing',
        allowCreate: false,
        fileSystem: deleteFileSystem
      })
    ).toEqual({
      ok: false,
      error: 'Dev profile does not exist: missing'
    });
    expect(deleteFileSystem.mkdirCalls).toEqual([]);
    expect(deleteFileSystem.writeFileCalls).toEqual([]);

    expect(
      selectDevProfile({
        homeDir: '/tmp/home',
        allowCreate: false,
        fileSystem: deleteFileSystem,
        prompt: () => 'charlie'
      })
    ).toEqual({
      ok: false,
      error:
        'Profile selection must be one of the listed profiles. Creation is not allowed for this command.'
    });
  });

  it('plans profile creation without mutating profile state', () => {
    const fileSystem = createProfileFileSystem({
      directories: ['/tmp/home/.teamem/dev-profiles/alice']
    });

    expect(
      selectDevProfile({
        homeDir: '/tmp/home',
        allowCreate: true,
        createMode: 'plan',
        fileSystem,
        prompt: () => 'bob'
      })
    ).toMatchObject({ ok: true, profileName: 'bob', created: true });

    expect(fileSystem.directories).not.toContain(
      '/tmp/home/.teamem/dev-profiles/bob'
    );
    expect(fileSystem.mkdirCalls).toEqual([]);
    expect(fileSystem.writeFileCalls).toEqual([]);
  });

  it('deletes only the selected contained profile directory', () => {
    const fileSystem = createProfileFileSystem({
      directories: [
        '/tmp/home/.teamem/dev-profiles/alice/claude/plugins',
        '/tmp/home/.teamem/dev-profiles/bob',
        '/tmp/home/.claude',
        '/src/teamem/plugin',
        '/tmp/home/.config/claude/plugins'
      ],
      files: [
        '/tmp/home/.teamem/dev-profiles/alice/credentials.json',
        '/tmp/home/.teamem/credentials.json'
      ]
    });
    const paths = resolveDevProfilePaths({
      homeDir: '/tmp/home',
      profileName: 'alice'
    });

    expect(deleteDevProfile({ paths, fileSystem })).toEqual({
      ok: true,
      profileName: 'alice',
      profileRoot: '/tmp/home/.teamem/dev-profiles/alice'
    });

    expect(fileSystem.removeDirectoryCalls).toEqual([
      '/tmp/home/.teamem/dev-profiles/alice'
    ]);
    expect(fileSystem.directories).not.toContain(
      '/tmp/home/.teamem/dev-profiles/alice'
    );
    expect(
      fileSystem.files.has(
        '/tmp/home/.teamem/dev-profiles/alice/credentials.json'
      )
    ).toBe(false);
    expect(fileSystem.directories).toContain('/tmp/home/.teamem/dev-profiles');
    expect(fileSystem.directories).toContain(
      '/tmp/home/.teamem/dev-profiles/bob'
    );
    expect(fileSystem.directories).toContain('/tmp/home/.claude');
    expect(fileSystem.files.has('/tmp/home/.teamem/credentials.json')).toBe(
      true
    );
    expect(fileSystem.directories).toContain('/src/teamem/plugin');
    expect(fileSystem.directories).toContain(
      '/tmp/home/.config/claude/plugins'
    );
  });

  it('refuses unsafe dev profile delete targets', () => {
    const safe = resolveDevProfilePaths({
      homeDir: '/tmp/home',
      profileName: 'alice'
    });

    expect(
      validateDevProfileDeleteTarget({
        ...safe,
        profileRoot: safe.profilesRoot
      })
    ).toEqual({
      ok: false,
      error:
        'Refusing to delete dev profiles root: /tmp/home/.teamem/dev-profiles'
    });
    expect(
      validateDevProfileDeleteTarget({
        ...safe,
        profileRoot: '/tmp/home/.teamem/credentials.json'
      })
    ).toEqual({
      ok: false,
      error:
        'Refusing to delete non-contained dev profile path: /tmp/home/.teamem/credentials.json'
    });
  });
});

function createProfileFileSystem(
  options: {
    readonly directories?: readonly string[];
    readonly files?: readonly string[];
  } = {}
): DevProfileFileSystem & {
  readonly directories: string[];
  readonly files: Map<string, string>;
  readonly mkdirCalls: string[];
  readonly writeFileCalls: string[];
  readonly removeDirectoryCalls: string[];
} {
  const directories = expandParentDirectories(options.directories ?? []);
  const files = new Map((options.files ?? []).map((path) => [path, '']));
  const mkdirCalls: string[] = [];
  const writeFileCalls: string[] = [];
  const removeDirectoryCalls: string[] = [];

  return {
    directories,
    files,
    mkdirCalls,
    writeFileCalls,
    removeDirectoryCalls,
    exists(path: string): boolean {
      return directories.includes(path) || files.has(path);
    },
    isDirectory(path: string): boolean {
      return directories.includes(path);
    },
    readDirectory(path: string): readonly string[] {
      const prefix = `${path}/`;
      return [
        ...new Set(
          [...directories, ...files.keys()]
            .filter((entry) => entry.startsWith(prefix))
            .map((entry) => entry.slice(prefix.length).split('/')[0] ?? '')
            .filter(Boolean)
        )
      ];
    },
    mkdir(path: string): void {
      mkdirCalls.push(path);
      if (!directories.includes(path)) {
        directories.push(path);
      }
    },
    writeFile(path: string, content: string): void {
      writeFileCalls.push(path);
      files.set(path, content);
    },
    removeDirectory(path: string): void {
      removeDirectoryCalls.push(path);
      const prefix = `${path}/`;
      for (let index = directories.length - 1; index >= 0; index -= 1) {
        if (
          directories[index] === path ||
          directories[index].startsWith(prefix)
        ) {
          directories.splice(index, 1);
        }
      }
      for (const filePath of [...files.keys()]) {
        if (filePath === path || filePath.startsWith(prefix)) {
          files.delete(filePath);
        }
      }
    }
  };
}

function expandParentDirectories(paths: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/').filter(Boolean);
    let current = path.startsWith('/') ? '' : '.';
    for (const part of parts) {
      current = current === '' ? `/${part}` : `${current}/${part}`;
      directories.add(current);
    }
  }
  return [...directories];
}
