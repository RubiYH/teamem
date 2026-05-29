import {
  intro,
  outro,
  text,
  select,
  note,
  cancel,
  isCancel,
  log
} from '@clack/prompts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  appendEntry,
  loadCredentials,
  defaultCredentialsPath,
  type CredentialEntry
} from '../bridge/credentials.js';
import {
  realIdentityProbe,
  suggestMemberNameDefault
} from './identity-default.js';

const AC24_WARNING =
  '(share via SECURE channel only — Signal/1Password/in-person)';

type CoordPref = 'auto-skip';

async function promptCoordPref(): Promise<CoordPref> {
  note(
    'The current plugin build uses queue-first coordination. Negotiator automation is postponed, so setup keeps the default `auto-skip` preference.',
    'Coordination'
  );
  return 'auto-skip';
}

async function applyCoordPref(
  _baseUrl: string,
  _jwt: string,
  pref: CoordPref
): Promise<void> {
  if (pref === 'auto-skip') return; // DB default, no call needed.
}

// Mirrors resolve_bridge_dir() in hooks/lib/gate-claim-scope.sh:82-99.
// Priority: credentials.json bridge_dir > TEAMEM_BRIDGE_DIR env.
async function resolveBridgeDir(credPath?: string): Promise<string | null> {
  const creds = await loadCredentials(credPath);
  const fromCreds = creds?.bridge_dir;
  if (fromCreds && existsSync(join(fromCreds, 'src', 'bridge'))) {
    return fromCreds;
  }
  const fromEnv = process.env.TEAMEM_BRIDGE_DIR;
  if (fromEnv && existsSync(join(fromEnv, 'src', 'bridge'))) {
    return fromEnv;
  }
  return null;
}

async function runCheck() {
  const credPath = defaultCredentialsPath();
  let allPass = true;

  // (a) credentials.json exists and parses
  const creds = await loadCredentials(credPath);
  const credsExist = existsSync(credPath);
  if (credsExist && creds !== null) {
    process.stdout.write('[PASS] credentials_found\n');
  } else {
    process.stdout.write('[FAIL] credentials_found\n');
    allPass = false;
  }

  // (b) bridge_dir resolves
  const bridgeDir = await resolveBridgeDir(credPath);
  if (bridgeDir !== null) {
    process.stdout.write('[PASS] bridge_dir_resolved\n');
  } else {
    process.stdout.write('[FAIL] bridge_dir_unresolved\n');
    allPass = false;
  }

  // (c) hooks dir exists for detected provider
  const homeDir = homedir();
  let provider: 'claude' | 'codex' | 'unknown' = 'unknown';
  if (existsSync(join(homeDir, '.claude', 'settings.local.json'))) {
    provider = 'claude';
  } else if (existsSync(join(homeDir, '.codex', 'config.toml'))) {
    provider = 'codex';
  }

  if (provider === 'unknown') {
    process.stdout.write(
      '[WARN] hooks_provider_unknown (neither ~/.claude/settings.local.json nor ~/.codex/config.toml found)\n'
    );
  } else if (bridgeDir !== null) {
    const hooksFile = join(bridgeDir, 'hooks', provider, 'pre-tool-use.sh');
    if (existsSync(hooksFile)) {
      process.stdout.write(`[PASS] hooks_installed (${provider})\n`);
    } else {
      process.stdout.write(
        `[FAIL] hooks_missing (${provider}: ${hooksFile} not found)\n`
      );
      allPass = false;
    }
  } else {
    process.stdout.write(
      '[FAIL] hooks_check_skipped (bridge_dir unresolved)\n'
    );
    allPass = false;
  }

  process.exit(allPass ? 0 : 2);
}

export function printRoomCode(code: string) {
  // note() goes to stdout via @clack
  note(`Your room code: ${code}\n${AC24_WARNING}`, 'Room code');
}

function bail(msg: string): never {
  cancel(msg);
  process.exit(1);
}

function credentialsOutputPath(credPath?: string): string {
  return credPath ?? defaultCredentialsPath();
}

// F5: `enforceBridgeDir` was removed. The pre-v1 standalone hook installer
// (`bun run hook-install`) is gone (slice #2); the plugin owns the hook
// lifecycle now. A fresh marketplace install has no source-tree path to
// resolve, and that is the supported shape (see ADR-0003 / ADR-0006).
// If we re-introduce a source-checkout-only diagnostic, gate it on
// `process.env.TEAMEM_SOURCE_DEV === '1'` and make it a soft warning, not
// an exit.

interface NonInteractiveArgs {
  serverUrl: string;
  flow: 'create' | 'join';
  memberName: string;
  spaceLabel?: string;
  roomCode?: string;
  credPath?: string;
}

function parseNonInteractive(): NonInteractiveArgs | null {
  const args = process.argv.slice(2);
  const jsonIdx = args.indexOf('--json');
  if (jsonIdx === -1) return null;
  const raw = args[jsonIdx + 1];
  if (!raw) return null;
  try {
    return JSON.parse(raw) as NonInteractiveArgs;
  } catch {
    return null;
  }
}

async function runNonInteractive(opts: NonInteractiveArgs) {
  const baseUrl = opts.serverUrl.trim().replace(/\/$/, '');
  const memberName = opts.memberName.trim();

  if (opts.flow === 'create') {
    const body: Record<string, string> = { member_name: memberName };
    if (opts.spaceLabel?.trim()) body.label = opts.spaceLabel.trim();

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/spaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (err) {
      process.stderr.write(`Network error: ${(err as Error).message}\n`);
      process.exit(1);
    }

    if (!res!.ok) {
      const errBody = (await res!.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      process.stderr.write(
        `Server error ${res!.status}: ${errBody.error ?? 'unknown'}\n`
      );
      process.exit(1);
    }

    const data = (await res!.json()) as {
      space_id: string;
      label?: string;
      room_code: string;
      jwt: string;
    };
    const jwtParts = data.jwt.split('.');
    const payload = JSON.parse(
      Buffer.from(jwtParts[1], 'base64url').toString()
    ) as { exp: number };

    const entry: CredentialEntry = {
      space_id: data.space_id,
      // Trust the server's label so `space disband`'s label_confirmation
      // matches what's actually stored (security review P2#3).
      label: data.label ?? opts.spaceLabel ?? data.space_id,
      member_name: memberName,
      jwt: data.jwt,
      jwt_exp: payload.exp,
      server_url: baseUrl
    };

    await appendEntry(entry, opts.credPath, { makeDefault: true });
    // Print room code + AC24 warning to stdout for E2E assertion
    process.stdout.write(
      `Your room code: ${data.room_code}\n${AC24_WARNING}\n`
    );
    process.stdout.write(
      `Space created. Credentials saved to ${credentialsOutputPath(opts.credPath)}.\n`
    );
    // F5: no bridge_dir gate. The plugin owns the hook lifecycle in v1; a
    // fresh marketplace install has no source-tree path to resolve and that
    // is the supported shape (ADR-0003, ADR-0006).
  } else {
    const roomCode = opts.roomCode?.trim();
    if (!roomCode) {
      process.stderr.write('room_code required for join flow\n');
      process.exit(1);
    }

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/spaces/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          room_code: roomCode,
          member_name: memberName
        })
      });
    } catch (err) {
      process.stderr.write(`Network error: ${(err as Error).message}\n`);
      process.exit(1);
    }

    if (!res!.ok) {
      const errBody = (await res!.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const errCode = errBody.error as string | undefined;
      if (errCode === 'invalid_code') {
        process.stderr.write(
          'Invalid room code. Check the code and try again.\n'
        );
      } else if (errCode === 'code_expired') {
        process.stderr.write(
          'Room code has expired. Ask your team to rotate it.\n'
        );
      } else if (errCode === 'name_taken') {
        process.stderr.write(
          `Name '${memberName}' is already taken in this space.\n`
        );
      } else {
        process.stderr.write(
          `Server error ${res!.status}: ${errCode ?? 'unknown'}\n`
        );
      }
      process.exit(1);
    }

    const data = (await res!.json()) as {
      space_id: string;
      label?: string;
      jwt: string;
    };
    const jwtParts = data.jwt.split('.');
    const payload = JSON.parse(
      Buffer.from(jwtParts[1], 'base64url').toString()
    ) as { exp: number };

    const entry: CredentialEntry = {
      space_id: data.space_id,
      label: data.label ?? data.space_id,
      member_name: memberName,
      jwt: data.jwt,
      jwt_exp: payload.exp,
      server_url: baseUrl
    };

    await appendEntry(entry, opts.credPath, { makeDefault: true });
    process.stdout.write(`Joined space ${data.space_id}\n`);
    process.stdout.write(
      `Credentials saved to ${credentialsOutputPath(opts.credPath)}.\n`
    );
    // F5: no bridge_dir gate. The plugin owns the hook lifecycle in v1; a
    // fresh marketplace install has no source-tree path to resolve and that
    // is the supported shape (ADR-0003, ADR-0006).
  }
}

async function runInteractive() {
  intro('teamem setup');

  const creds = await loadCredentials();
  if (creds && Object.keys(creds.spaces).length > 0) {
    const action = await select({
      message: 'Credentials already exist. What would you like to do?',
      options: [
        { value: 'add', label: 'Add another space' },
        { value: 'abort', label: 'Abort' }
      ]
    });
    if (isCancel(action) || action === 'abort') {
      bail('Setup aborted.');
    }
  }

  const serverUrl = await text({
    message: 'Server URL',
    placeholder: 'http://localhost:3000',
    defaultValue: 'http://localhost:3000'
  });
  if (isCancel(serverUrl)) bail('Setup cancelled.');
  const baseUrl = (serverUrl as string).replace(/\/$/, '');

  const flow = await select({
    message: 'What would you like to do?',
    options: [
      { value: 'create', label: 'Create a new space (you become the creator)' },
      { value: 'join', label: 'Join an existing space with a room code' }
    ]
  });
  if (isCancel(flow)) bail('Setup cancelled.');

  // Issue #8: prefill the member-name prompt from `git config user.name`,
  // env $USER, or the OS username — refused if the candidate is a generic
  // shared-host value (root|ubuntu|admin|user|nobody).
  const suggestedMemberName = suggestMemberNameDefault(realIdentityProbe());

  if (flow === 'create') {
    const memberName = await text({
      message: 'Your name in this space',
      placeholder: suggestedMemberName ?? 'alice',
      ...(suggestedMemberName ? { initialValue: suggestedMemberName } : {})
    });
    if (isCancel(memberName) || !(memberName as string).trim())
      bail('Setup cancelled.');

    const spaceLabel = await text({
      message: 'Space label (optional)',
      placeholder: 'my-team'
    });
    if (isCancel(spaceLabel)) bail('Setup cancelled.');

    const body: Record<string, string> = {
      member_name: (memberName as string).trim()
    };
    if ((spaceLabel as string).trim())
      body.label = (spaceLabel as string).trim();

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/spaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (err) {
      bail(`Network error: ${(err as Error).message}`);
    }

    if (!res!.ok) {
      const errBody = (await res!.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      bail(`Server error ${res!.status}: ${errBody.error ?? 'unknown'}`);
    }

    const data = (await res!.json()) as {
      space_id: string;
      label?: string;
      room_code: string;
      jwt: string;
    };
    const jwtParts = data.jwt.split('.');
    const payload = JSON.parse(
      Buffer.from(jwtParts[1], 'base64url').toString()
    ) as { exp: number };

    const entry: CredentialEntry = {
      space_id: data.space_id,
      // Server is the source of truth (security review P2#3) — fall back to
      // the locally-typed label, then ULID, only if missing.
      label: data.label ?? body.label ?? data.space_id,
      member_name: (memberName as string).trim(),
      jwt: data.jwt,
      jwt_exp: payload.exp,
      server_url: baseUrl
    };

    await appendEntry(entry, undefined, { makeDefault: true });
    const coordPref = await promptCoordPref();
    await applyCoordPref(baseUrl, data.jwt, coordPref);
    printRoomCode(data.room_code);
    outro(
      `Space created (coord pref: ${coordPref}). Credentials saved to ${credentialsOutputPath()}`
    );
    // F5: no bridge_dir gate. See note above.
  } else {
    const roomCode = await text({
      message: 'Room code',
      placeholder: 'ABCD1234'
    });
    if (isCancel(roomCode) || !(roomCode as string).trim())
      bail('Setup cancelled.');

    const memberName = await text({
      message: 'Your name in this space',
      placeholder: suggestedMemberName ?? 'alice',
      ...(suggestedMemberName ? { initialValue: suggestedMemberName } : {})
    });
    if (isCancel(memberName) || !(memberName as string).trim())
      bail('Setup cancelled.');

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/spaces/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          room_code: (roomCode as string).trim(),
          member_name: (memberName as string).trim()
        })
      });
    } catch (err) {
      bail(`Network error: ${(err as Error).message}`);
    }

    if (!res!.ok) {
      const errBody = (await res!.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const errCode = errBody.error as string | undefined;
      if (errCode === 'invalid_code')
        bail('Invalid room code. Check the code and try again.');
      if (errCode === 'code_expired')
        bail('Room code has expired. Ask your team to rotate it.');
      if (errCode === 'name_taken')
        bail(
          `Name '${(memberName as string).trim()}' is already taken in this space.`
        );
      bail(`Server error ${res!.status}: ${errCode ?? 'unknown'}`);
    }

    const data = (await res!.json()) as {
      space_id: string;
      label?: string;
      jwt: string;
    };
    const jwtParts = data.jwt.split('.');
    const payload = JSON.parse(
      Buffer.from(jwtParts[1], 'base64url').toString()
    ) as { exp: number };

    const entry: CredentialEntry = {
      space_id: data.space_id,
      label: data.label ?? data.space_id,
      member_name: (memberName as string).trim(),
      jwt: data.jwt,
      jwt_exp: payload.exp,
      server_url: baseUrl
    };

    await appendEntry(entry, undefined, { makeDefault: true });
    log.success(`Joined space ${data.space_id}`);
    const coordPref = await promptCoordPref();
    await applyCoordPref(baseUrl, data.jwt, coordPref);
    outro(
      `Credentials saved to ${credentialsOutputPath()} (coord pref: ${coordPref})`
    );
    // F5: no bridge_dir gate. See note above.
  }
}

async function main() {
  if (process.argv.includes('--check')) {
    await runCheck();
    return;
  }
  const nonInteractive = parseNonInteractive();
  if (nonInteractive) {
    await runNonInteractive(nonInteractive);
  } else {
    await runInteractive();
  }
}

main().catch((err) => {
  process.stderr.write(`setup fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
