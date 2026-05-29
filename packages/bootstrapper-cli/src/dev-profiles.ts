import {
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface DevProfileFileSystem {
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  readDirectory(path: string): readonly string[];
  mkdir(path: string): void;
  writeFile(path: string, content: string): void;
  removeDirectory(path: string): void;
}

export interface DevProfilePaths {
  readonly profileName: string;
  readonly profilesRoot: string;
  readonly profileRoot: string;
  readonly claudeConfigDir: string;
  readonly pluginCacheDir: string;
  readonly pluginDataDir: string;
  readonly credentialsPath: string;
  readonly mcpConfigPath: string;
  readonly metadataPath: string;
  readonly logsDir: string;
}

export interface DevProfileListEntry {
  readonly name: string;
  readonly path: string;
  readonly metadataPath: string;
}

export interface DevProfileSelection {
  readonly ok: true;
  readonly profileName: string;
  readonly paths: DevProfilePaths;
  readonly created: boolean;
}

export interface DevProfileFailure {
  readonly ok: false;
  readonly error: string;
}

export type DevProfileSelectionResult = DevProfileSelection | DevProfileFailure;

export type DevProfileCreateResult =
  | {
      readonly ok: true;
      readonly profileName: string;
      readonly paths: DevProfilePaths;
    }
  | DevProfileFailure;

export type DevProfilePrompt = (message: string) => string | null;

export type DevProfileDeleteResult =
  | {
      readonly ok: true;
      readonly profileName: string;
      readonly profileRoot: string;
    }
  | DevProfileFailure;

export type DevProfileActiveSessionStatus =
  | {
      readonly status: 'active';
      readonly message: string;
    }
  | {
      readonly status: 'inactive';
    }
  | {
      readonly status: 'inconclusive';
      readonly message: string;
    };

export interface DevProfileActiveSessionDetector {
  check(paths: DevProfilePaths): DevProfileActiveSessionStatus;
}

const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PROFILE_NAME_ERROR =
  'Use a lowercase slug with letters, numbers, hyphens, or underscores, up to 64 characters.';

export function createNodeDevProfileFileSystem(): DevProfileFileSystem {
  return {
    exists(path: string): boolean {
      try {
        statSync(path);
        return true;
      } catch {
        return false;
      }
    },
    isDirectory(path: string): boolean {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    },
    readDirectory(path: string): readonly string[] {
      try {
        return readdirSync(path);
      } catch {
        return [];
      }
    },
    mkdir(path: string): void {
      mkdirSync(path, { recursive: true });
    },
    writeFile(path: string, content: string): void {
      writeFileSync(path, content, 'utf8');
    },
    removeDirectory(path: string): void {
      rmSync(path, { recursive: true, force: true });
    }
  };
}

export function createNodeDevProfileActiveSessionDetector(): DevProfileActiveSessionDetector {
  return {
    check(paths: DevProfilePaths): DevProfileActiveSessionStatus {
      const result = spawnSync('pgrep', ['-fl', 'claude'], {
        encoding: 'utf8'
      });
      if (result.error) {
        return {
          status: 'inconclusive',
          message: `Could not inspect running Claude processes: ${result.error.message}`
        };
      }
      if (result.status === 1) {
        return { status: 'inactive' };
      }
      if (result.status !== 0) {
        return {
          status: 'inconclusive',
          message:
            result.stderr.trim() ||
            `Could not inspect running Claude processes; pgrep exited with ${result.status}.`
        };
      }

      const matchingLine = result.stdout
        .split('\n')
        .find((line) => line.includes(paths.profileRoot));
      if (!matchingLine) {
        return { status: 'inactive' };
      }
      return {
        status: 'active',
        message: `Found running Claude process for profile ${paths.profileName}: ${matchingLine.trim()}`
      };
    }
  };
}

export function validateDevProfileName(
  profileName: string
): { readonly ok: true; readonly value: string } | DevProfileFailure {
  if (!PROFILE_NAME_PATTERN.test(profileName)) {
    return {
      ok: false,
      error: PROFILE_NAME_ERROR
    };
  }

  return { ok: true, value: profileName };
}

export function getDevProfileNameError(): string {
  return PROFILE_NAME_ERROR;
}

export function resolveDevProfilePaths(options: {
  readonly homeDir?: string;
  readonly profileName: string;
}): DevProfilePaths {
  const validation = validateDevProfileName(options.profileName);
  if (!validation.ok) {
    throw new Error(validation.error);
  }

  const profilesRoot = resolve(
    options.homeDir ?? homedir(),
    '.teamem',
    'dev-profiles'
  );
  const profileRoot = resolve(profilesRoot, validation.value);

  if (
    profileRoot !== profilesRoot &&
    !profileRoot.startsWith(`${profilesRoot}${sep}`)
  ) {
    throw new Error('Resolved profile path escaped the dev profile root.');
  }

  return {
    profileName: validation.value,
    profilesRoot,
    profileRoot,
    claudeConfigDir: join(profileRoot, 'claude'),
    pluginCacheDir: join(profileRoot, 'claude', 'plugins'),
    pluginDataDir: join(profileRoot, 'plugin-data', 'teamem'),
    credentialsPath: join(profileRoot, 'credentials.json'),
    mcpConfigPath: join(profileRoot, 'mcp.json'),
    metadataPath: join(profileRoot, 'metadata.json'),
    logsDir: join(profileRoot, 'logs')
  };
}

export function listDevProfiles(options: {
  readonly homeDir?: string;
  readonly fileSystem?: DevProfileFileSystem;
}): readonly DevProfileListEntry[] {
  const fileSystem = options.fileSystem ?? createNodeDevProfileFileSystem();
  const profilesRoot = resolve(
    options.homeDir ?? homedir(),
    '.teamem',
    'dev-profiles'
  );
  if (!fileSystem.isDirectory(profilesRoot)) {
    return [];
  }

  return fileSystem
    .readDirectory(profilesRoot)
    .filter((name) => validateDevProfileName(name).ok)
    .map((name) =>
      resolveDevProfilePaths({ homeDir: options.homeDir, profileName: name })
    )
    .filter((paths) => fileSystem.isDirectory(paths.profileRoot))
    .map((paths) => ({
      name: paths.profileName,
      path: paths.profileRoot,
      metadataPath: paths.metadataPath
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function createDevProfile(options: {
  readonly homeDir?: string;
  readonly profileName: string;
  readonly fileSystem?: DevProfileFileSystem;
  readonly now?: () => Date;
}): DevProfileCreateResult {
  const validation = validateDevProfileName(options.profileName);
  if (!validation.ok) {
    return validation;
  }

  const fileSystem = options.fileSystem ?? createNodeDevProfileFileSystem();
  const paths = resolveDevProfilePaths({
    homeDir: options.homeDir,
    profileName: validation.value
  });
  if (fileSystem.exists(paths.profileRoot)) {
    return {
      ok: false,
      error: `Dev profile already exists: ${validation.value}`
    };
  }

  for (const directory of [
    paths.profilesRoot,
    paths.profileRoot,
    paths.claudeConfigDir,
    paths.pluginCacheDir,
    paths.pluginDataDir,
    paths.logsDir
  ]) {
    fileSystem.mkdir(directory);
  }

  fileSystem.writeFile(
    paths.metadataPath,
    `${JSON.stringify(
      {
        version: 1,
        profile: validation.value,
        createdAt: (options.now ?? (() => new Date()))().toISOString()
      },
      null,
      2
    )}\n`
  );

  return {
    ok: true,
    profileName: validation.value,
    paths
  };
}

export function deleteDevProfile(options: {
  readonly paths: DevProfilePaths;
  readonly fileSystem?: DevProfileFileSystem;
}): DevProfileDeleteResult {
  const fileSystem = options.fileSystem ?? createNodeDevProfileFileSystem();
  const validation = validateDevProfileDeleteTarget(options.paths);
  if (!validation.ok) {
    return validation;
  }
  if (!fileSystem.isDirectory(options.paths.profileRoot)) {
    return {
      ok: false,
      error: `Dev profile path is not a directory: ${options.paths.profileRoot}`
    };
  }
  fileSystem.removeDirectory(options.paths.profileRoot);
  return {
    ok: true,
    profileName: options.paths.profileName,
    profileRoot: options.paths.profileRoot
  };
}

export function validateDevProfileDeleteTarget(
  paths: DevProfilePaths
): { readonly ok: true } | DevProfileFailure {
  const profilesRoot = resolve(paths.profilesRoot);
  const profileRoot = resolve(paths.profileRoot);

  if (profileRoot === profilesRoot) {
    return {
      ok: false,
      error: `Refusing to delete dev profiles root: ${profileRoot}`
    };
  }
  if (!profileRoot.startsWith(`${profilesRoot}${sep}`)) {
    return {
      ok: false,
      error: `Refusing to delete non-contained dev profile path: ${profileRoot}`
    };
  }
  return { ok: true };
}

export function selectDevProfile(options: {
  readonly homeDir?: string;
  readonly requestedProfile?: string;
  readonly allowCreate: boolean;
  readonly createMode?: 'create' | 'plan';
  readonly fileSystem?: DevProfileFileSystem;
  readonly prompt?: DevProfilePrompt;
  readonly now?: () => Date;
}): DevProfileSelectionResult {
  const fileSystem = options.fileSystem ?? createNodeDevProfileFileSystem();

  if (options.requestedProfile) {
    const validation = validateDevProfileName(options.requestedProfile);
    if (!validation.ok) {
      return validation;
    }
    const paths = resolveDevProfilePaths({
      homeDir: options.homeDir,
      profileName: validation.value
    });
    if (
      fileSystem.exists(paths.profileRoot) &&
      !fileSystem.isDirectory(paths.profileRoot)
    ) {
      return {
        ok: false,
        error: `Dev profile path exists but is not a directory: ${paths.profileRoot}`
      };
    }
    if (!fileSystem.exists(paths.profileRoot)) {
      if (!options.allowCreate) {
        return {
          ok: false,
          error: `Dev profile does not exist: ${validation.value}`
        };
      }
      if (options.createMode === 'plan') {
        return {
          ok: true,
          profileName: validation.value,
          paths,
          created: true
        };
      }
      const created = createDevProfile({
        homeDir: options.homeDir,
        profileName: validation.value,
        fileSystem,
        now: options.now
      });
      if (!created.ok) {
        return created;
      }
      return {
        ok: true,
        profileName: created.profileName,
        paths: created.paths,
        created: true
      };
    }
    return {
      ok: true,
      profileName: validation.value,
      paths,
      created: false
    };
  }

  if (!options.prompt) {
    return {
      ok: false,
      error: 'Profile selection requires an interactive prompt.'
    };
  }

  const profiles = listDevProfiles({
    homeDir: options.homeDir,
    fileSystem
  });
  const promptMessage =
    profiles.length === 0
      ? options.allowCreate
        ? 'Create Teamem dev profile: '
        : 'Select Teamem dev profile: '
      : [
          'Select Teamem dev profile:',
          ...profiles.map((profile, index) => `${index + 1}. ${profile.name}`),
          options.allowCreate ? 'Or enter a new profile slug.' : undefined,
          '> '
        ]
          .filter((line): line is string => line !== undefined)
          .join('\n');
  const answer = options.prompt(promptMessage)?.trim();
  if (!answer) {
    return {
      ok: false,
      error: 'Profile selection was cancelled.'
    };
  }

  const indexSelection = Number.parseInt(answer, 10);
  if (
    Number.isInteger(indexSelection) &&
    `${indexSelection}` === answer &&
    indexSelection >= 1 &&
    indexSelection <= profiles.length
  ) {
    const selected = profiles[indexSelection - 1];
    return {
      ok: true,
      profileName: selected.name,
      paths: resolveDevProfilePaths({
        homeDir: options.homeDir,
        profileName: selected.name
      }),
      created: false
    };
  }

  const existing = profiles.find((profile) => profile.name === answer);
  if (existing) {
    return {
      ok: true,
      profileName: existing.name,
      paths: resolveDevProfilePaths({
        homeDir: options.homeDir,
        profileName: existing.name
      }),
      created: false
    };
  }

  if (!options.allowCreate) {
    return {
      ok: false,
      error:
        'Profile selection must be one of the listed profiles. Creation is not allowed for this command.'
    };
  }

  const validation = validateDevProfileName(answer);
  if (!validation.ok) {
    return validation;
  }
  if (options.createMode === 'plan') {
    return {
      ok: true,
      profileName: validation.value,
      paths: resolveDevProfilePaths({
        homeDir: options.homeDir,
        profileName: validation.value
      }),
      created: true
    };
  }

  const created = createDevProfile({
    homeDir: options.homeDir,
    profileName: validation.value,
    fileSystem,
    now: options.now
  });
  if (!created.ok) {
    return created;
  }
  return {
    ok: true,
    profileName: created.profileName,
    paths: created.paths,
    created: true
  };
}

export function renderDevProfileStatus(paths: DevProfilePaths): string {
  return [
    `Profile: ${paths.profileName}`,
    `Profile root: ${paths.profileRoot}`,
    `Claude config: ${paths.claudeConfigDir}`,
    `Plugin cache: ${paths.pluginCacheDir}`,
    `Plugin data: ${paths.pluginDataDir}`,
    `Credentials: ${paths.credentialsPath}`,
    `MCP config: ${paths.mcpConfigPath}`,
    `Metadata: ${paths.metadataPath}`,
    `Logs: ${paths.logsDir}`
  ].join('\n');
}

export function renderDevProfileList(
  profiles: readonly DevProfileListEntry[]
): string {
  if (profiles.length === 0) {
    return 'Teamem dev profiles\nNo dev profiles found.\n';
  }

  return (
    [
      'Teamem dev profiles',
      ...profiles.map((profile) => `- ${profile.name}: ${profile.path}`)
    ].join('\n') + '\n'
  );
}
