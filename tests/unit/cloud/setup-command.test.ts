import { describe, expect, it } from 'bun:test';
import { buildCloudSetupCommand } from '../../../src/cloud/setup-command.js';

describe('buildCloudSetupCommand', () => {
  it('renders the non-interactive hosted join command deterministically', () => {
    const setup = buildCloudSetupCommand({
      serverUrl: 'https://runtime.teamem.dev',
      roomCode: 'ABCD1234',
      memberNamePlaceholder: '<your-name>'
    });

    expect(setup.argv).toEqual([
      'teamem',
      'init',
      '--join',
      '--server-url',
      'https://runtime.teamem.dev',
      '--room-code',
      'ABCD1234',
      '--member-name',
      '<your-name>'
    ]);
    expect(setup.command).toBe(
      "teamem init --join --server-url https://runtime.teamem.dev --room-code ABCD1234 --member-name '<your-name>'"
    );
  });

  it('shell-quotes member placeholders that contain spaces or quotes', () => {
    const setup = buildCloudSetupCommand({
      serverUrl: 'https://runtime.teamem.dev',
      roomCode: 'ABCD1234',
      memberNamePlaceholder: "Your dev's name"
    });

    expect(setup.command).toContain("--member-name 'Your dev'\\''s name'");
  });
});
