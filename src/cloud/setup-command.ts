export type SetupCommandInput = {
  serverUrl: string;
  roomCode: string;
  memberNamePlaceholder?: string;
};

export type SetupCommandContract = {
  command: string;
  argv: readonly string[];
  placeholders: {
    memberName: string;
  };
};

const DEFAULT_MEMBER_NAME_PLACEHOLDER = '<your-name>';

export function buildCloudSetupCommand(
  input: SetupCommandInput
): SetupCommandContract {
  const memberName =
    input.memberNamePlaceholder?.trim() || DEFAULT_MEMBER_NAME_PLACEHOLDER;
  const argv = [
    'teamem',
    'init',
    '--join',
    '--server-url',
    input.serverUrl,
    '--room-code',
    input.roomCode,
    '--member-name',
    memberName
  ] as const;

  return {
    argv,
    command: argv.map(shellQuote).join(' '),
    placeholders: {
      memberName
    }
  };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
