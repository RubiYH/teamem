import { isCancel, text, note } from '@clack/prompts';
import {
  loadCredentials,
  pickEntry,
  pruneEntry,
  checkJwtExp,
  SessionExpiredError,
  type CredentialEntry
} from '../bridge/credentials.js';

const AC24_WARNING =
  '(share via SECURE channel only — Signal/1Password/in-person)';

function printRoomCode(code: string) {
  note(`Your room code: ${code}\n${AC24_WARNING}`, 'Room code');
}

function die(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function parseArgs(args: string[]): {
  subcommand: string;
  spaceFlag: string | undefined;
  rest: string[];
} {
  const subcommand = args[0] ?? '';
  let spaceFlag: string | undefined;
  const rest: string[] = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--space' && args[i + 1]) {
      spaceFlag = args[i + 1];
      i++;
    } else {
      rest.push(args[i]);
    }
  }
  return { subcommand, spaceFlag, rest };
}

async function resolveEntry(spaceFlag?: string): Promise<CredentialEntry> {
  const creds = await loadCredentials();
  if (!creds || Object.keys(creds.spaces).length === 0) {
    die("No credentials found. Run 'bun run setup' to create or join a space.");
  }
  let entry: CredentialEntry;
  try {
    entry = pickEntry({
      flag: spaceFlag,
      env: process.env.TEAMEM_SPACE,
      creds: creds!
    });
  } catch (err) {
    die((err as Error).message);
  }
  try {
    checkJwtExp(entry!);
  } catch (err) {
    if (err instanceof SessionExpiredError) die(err.message);
    throw err;
  }
  return entry!;
}

async function fetchSpace(
  entry: CredentialEntry,
  path: string,
  body: unknown = {}
): Promise<Response> {
  const baseUrl = entry.server_url.replace(/\/$/, '');
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${entry.jwt}`
      },
      body: JSON.stringify(body)
    });
  } catch (err) {
    die(`Network error: ${(err as Error).message}`);
  }
  return res!;
}

async function cmdRotateCode(spaceFlag?: string) {
  const entry = await resolveEntry(spaceFlag);
  const res = await fetchSpace(entry, '/spaces/rotate-code');
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    die(`rotate-code failed: ${body.error ?? res.status}`);
  }
  const data = (await res.json()) as { room_code: string; rotated_at: string };
  printRoomCode(data.room_code);
}

async function cmdKick(memberName: string, spaceFlag?: string) {
  if (!memberName) die('Usage: space kick <member_name> [--space <id>]');
  const entry = await resolveEntry(spaceFlag);
  const res = await fetchSpace(entry, '/spaces/kick', {
    member_name: memberName
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (body.error === 'not_creator') die('Only the creator can kick members.');
    if (body.error === 'cannot_self_kick') die('You cannot kick yourself.');
    if (body.error === 'target_not_found')
      die(`Member '${memberName}' not found.`);
    die(`kick failed: ${body.error ?? res.status}`);
  }
  process.stdout.write(`Kicked ${memberName}\n`);
}

async function cmdLeave(spaceFlag?: string) {
  const entry = await resolveEntry(spaceFlag);
  const res = await fetchSpace(entry, '/spaces/leave');
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (body.error === 'creator_must_disband') {
      die(
        "You are the creator. Use 'bun run space disband' to disband the space instead."
      );
    }
    die(`leave failed: ${body.error ?? res.status}`);
  }
  await pruneEntry(entry.space_id);
  process.stdout.write(`Left space ${entry.space_id}\n`);
}

async function cmdDisband(spaceFlag?: string) {
  const entry = await resolveEntry(spaceFlag);

  const confirmation = await text({
    message: `Type the space label to confirm disbanding: "${entry.label}"`,
    placeholder: entry.label
  });
  if (isCancel(confirmation)) die('Disband cancelled.');
  if ((confirmation as string).trim() !== entry.label) {
    die('Label mismatch — disband cancelled.');
  }

  // Server requires label_confirmation matching the actual space label
  // (plan §2 req 1, defense-in-depth alongside the CLI prompt).
  const res = await fetchSpace(entry, '/spaces/disband', {
    label_confirmation: entry.label
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (body.error === 'not_creator')
      die('Only the creator can disband the space.');
    if (body.error === 'label_required')
      die('Server rejected disband: label confirmation missing.');
    if (body.error === 'label_mismatch')
      die('Server rejected disband: label mismatch.');
    die(`disband failed: ${body.error ?? res.status}`);
  }
  // Soft-disband retains data + credentials for the 7-day grace window so
  // the creator can run `space restore` to undo. Members of a disbanded
  // space see 410 immediately on every API call; the creator's local
  // credential is the only key that can drive restore, so we keep it.
  process.stdout.write(
    `Space ${entry.space_id} (${entry.label}) disbanded. Run 'bun run space restore' within 7 days to undo; otherwise data will be hard-deleted by GC.\n`
  );
}

async function cmdRestore(spaceFlag?: string) {
  const entry = await resolveEntry(spaceFlag);
  const res = await fetchSpace(entry, '/spaces/restore');
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (body.error === 'not_creator')
      die('Only the creator can restore the space.');
    if (body.error === 'not_disbanded')
      die('Space is not disbanded; nothing to restore.');
    if (body.error === 'grace_expired')
      die(
        'Grace window has elapsed and the space has been hard-deleted by GC. Restore is no longer possible.'
      );
    die(`restore failed: ${body.error ?? res.status}`);
  }
  process.stdout.write(`Space ${entry.space_id} (${entry.label}) restored.\n`);
}

async function cmdList() {
  const creds = await loadCredentials();
  if (!creds || Object.keys(creds.spaces).length === 0) {
    process.stdout.write('No spaces in credentials.json\n');
    return;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  for (const [id, entry] of Object.entries(creds.spaces)) {
    const isDefault = id === creds.default_space_id ? ' (default)' : '';
    const daysLeft = Math.floor((entry.jwt_exp - nowSec) / 86400);
    const expStr = daysLeft > 0 ? `expires in ${daysLeft}d` : 'EXPIRED';
    process.stdout.write(
      `${id}${isDefault}  label=${entry.label}  member=${entry.member_name}  jwt=${expStr}  server=${entry.server_url}\n`
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  const { subcommand, spaceFlag, rest } = parseArgs(args);

  switch (subcommand) {
    case 'rotate-code':
      await cmdRotateCode(spaceFlag);
      break;
    case 'kick':
      await cmdKick(rest[0], spaceFlag);
      break;
    case 'leave':
      await cmdLeave(spaceFlag);
      break;
    case 'disband':
      await cmdDisband(spaceFlag);
      break;
    case 'restore':
      await cmdRestore(spaceFlag);
      break;
    case 'list':
      await cmdList();
      break;
    default:
      process.stderr.write(
        'Usage: bun run space <subcommand> [options]\n' +
          'Subcommands: rotate-code, kick <name>, leave, disband, restore, list\n' +
          'Options: --space <space_id>\n'
      );
      process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`space fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
