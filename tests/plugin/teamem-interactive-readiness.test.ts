import { describe, expect, it } from 'bun:test';

import type {
  InteractiveReadinessMatcher,
  InteractiveSession
} from '../../plugin-e2e-module/src/index.js';
import {
  acceptClaudeStartupPromptsIfPresent,
  isClaudeBypassPermissionsSafetyPrompt,
  isClaudeDevelopmentChannelsSafetyPrompt,
  isClaudeInteractivePromptReady,
  isClaudeInteractiveReadyOrSafetyPrompt,
  isClaudeProjectMcpServersSafetyPrompt,
  isClaudeWorkspaceTrustPrompt
} from './teamem-interactive-readiness.js';

describe('Teamem interactive Claude startup readiness', () => {
  it('recognizes the development Channels safety prompt', () => {
    expect(
      isClaudeDevelopmentChannelsSafetyPrompt(developmentChannelsPrompt)
    ).toBeTrue();
    expect(
      isClaudeInteractiveReadyOrSafetyPrompt(developmentChannelsPrompt)
    ).toBeTrue();
    expect(
      isClaudeInteractivePromptReady(developmentChannelsPrompt)
    ).toBeFalse();
  });

  it('recognizes the project MCP server safety prompt', () => {
    expect(isClaudeProjectMcpServersSafetyPrompt(projectMcpServersPrompt)).toBe(
      true
    );
    expect(
      isClaudeInteractiveReadyOrSafetyPrompt(projectMcpServersPrompt)
    ).toBeTrue();
    expect(isClaudeInteractivePromptReady(projectMcpServersPrompt)).toBeFalse();
  });

  it('uses the latest startup prompt so stale prompts are not reaccepted', () => {
    const transcript = [
      workspaceTrustPrompt,
      projectMcpServersPrompt,
      developmentChannelsPrompt,
      bypassPermissionsPrompt
    ].join('\n');

    expect(isClaudeWorkspaceTrustPrompt(transcript)).toBeFalse();
    expect(isClaudeProjectMcpServersSafetyPrompt(transcript)).toBeFalse();
    expect(isClaudeDevelopmentChannelsSafetyPrompt(transcript)).toBeFalse();
    expect(isClaudeBypassPermissionsSafetyPrompt(transcript)).toBeTrue();
  });

  it('accepts trust, project MCP, development Channels, and bypass prompts before readiness', async () => {
    const { session, presses } = createScriptedSession([
      workspaceTrustPrompt,
      [workspaceTrustPrompt, projectMcpServersPrompt].join('\n'),
      [workspaceTrustPrompt, developmentChannelsPrompt].join('\n'),
      [
        workspaceTrustPrompt,
        projectMcpServersPrompt,
        developmentChannelsPrompt,
        bypassPermissionsPrompt
      ].join('\n'),
      [
        workspaceTrustPrompt,
        projectMcpServersPrompt,
        developmentChannelsPrompt,
        bypassPermissionsPrompt,
        readyPrompt
      ].join('\n')
    ]);

    await acceptClaudeStartupPromptsIfPresent(session, 1);

    expect(presses).toEqual(['enter', 'enter', 'enter', 'down', 'enter']);
  });
});

function createScriptedSession(transcripts: readonly string[]): {
  readonly session: InteractiveSession;
  readonly presses: string[];
} {
  let transcriptIndex = 0;
  const presses: string[] = [];
  const session = {
    rawTranscript: () => transcripts[transcriptIndex] ?? '',
    press: async (key: string) => {
      presses.push(key);
      if (key === 'enter') {
        transcriptIndex = Math.min(transcriptIndex + 1, transcripts.length - 1);
      }
    },
    waitFor: async (matcher: InteractiveReadinessMatcher) => {
      const currentTranscript = transcripts[transcriptIndex] ?? '';
      if (!matches(matcher, currentTranscript)) {
        throw new Error(
          `scripted transcript did not satisfy readiness matcher at index ${transcriptIndex}`
        );
      }
    }
  } as unknown as InteractiveSession;

  return { session, presses };
}

function matches(
  matcher: InteractiveReadinessMatcher,
  transcript: string
): boolean {
  if (typeof matcher === 'string') {
    return transcript.includes(matcher);
  }
  if (matcher instanceof RegExp) {
    return matcher.test(transcript);
  }
  return matcher(transcript);
}

const workspaceTrustPrompt = [
  'Quick safety check: Is this a project you created or one you trust?',
  '1. Yes, I trust this folder',
  '2. No, exit',
  'Enter to confirm · Esc to cancel'
].join('\n');

const developmentChannelsPrompt = [
  'WARNING: Loading development channels',
  '--dangerously-load-development-channels is for local channel development only.',
  'Do not use this option to run channels you have downloaded off the internet.',
  'Please use --channels to run a list of approved channels.',
  'Channels: server:teamem-channel',
  '1. I am using this for local development',
  '2. Exit',
  'Enter to confirm · Esc to cancel'
].join('\n');

const projectMcpServersPrompt = [
  '2 new MCP servers found in this project',
  'Select any you wish to enable.',
  'MCP servers may execute code or access system resources.',
  'Learn more in the MCP documentation.',
  '❯[✔] teamem',
  ' [✔] teamem-channel',
  'Space to select · Enter to confirm · Esc to reject all'
].join('\n');

const bypassPermissionsPrompt = [
  'Bypass Permissions mode',
  '1. No',
  '2. Yes, I accept',
  'Enter to confirm · Esc to cancel'
].join('\n');

const readyPrompt = ['Claude Code v2.1.162', '>', 'Try "create a test"'].join(
  '\n'
);
