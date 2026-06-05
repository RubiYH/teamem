import {
  normalizeTranscript,
  type InteractiveSession
} from '../../plugin-e2e-module/src/index.js';

export function isClaudeInteractivePromptReady(transcript: string): boolean {
  const normalized = normalizeTranscript(transcript);

  return (
    /(^|\n)[^\S\n]*[>›❯][^\S\n]*(?=\n|$)/.test(normalized) ||
    /\btry\s*["'].*["']/i.test(normalized)
  );
}

export function isClaudeWorkspaceTrustPrompt(transcript: string): boolean {
  const compactTranscript = compactClaudeTranscript(transcript);
  const promptIndices = findClaudeStartupPromptIndices(compactTranscript);

  return (
    promptIndices.workspaceTrust >
      latestOtherClaudeStartupPromptIndex(promptIndices, 'workspaceTrust') &&
    compactTranscript.includes(
      'quicksafetycheck:isthisaprojectyoucreatedoroneyoutrust?'
    ) &&
    compactTranscript.includes('yes,itrustthisfolder')
  );
}

export function isClaudeBypassPermissionsSafetyPrompt(
  transcript: string
): boolean {
  const compactTranscript = compactClaudeTranscript(transcript);
  const promptIndices = findClaudeStartupPromptIndices(compactTranscript);

  return (
    promptIndices.bypassPermissions >
      latestOtherClaudeStartupPromptIndex(promptIndices, 'bypassPermissions') &&
    compactTranscript.includes('bypasspermissionsmode') &&
    compactTranscript.includes('yes,iaccept')
  );
}

export function isClaudeDevelopmentChannelsSafetyPrompt(
  transcript: string
): boolean {
  const compactTranscript = compactClaudeTranscript(transcript);
  const promptIndices = findClaudeStartupPromptIndices(compactTranscript);

  return (
    promptIndices.developmentChannels >
      latestOtherClaudeStartupPromptIndex(
        promptIndices,
        'developmentChannels'
      ) &&
    compactTranscript.includes(
      '--dangerously-load-development-channelsisforlocalchanneldevelopmentonly'
    ) &&
    compactTranscript.includes(
      'pleaseuse--channelstorunalistofapprovedchannels'
    ) &&
    compactTranscript.includes('iamusingthisforlocaldevelopment') &&
    compactTranscript.includes('entertoconfirm')
  );
}

export function isClaudeProjectMcpServersSafetyPrompt(
  transcript: string
): boolean {
  const compactTranscript = compactClaudeTranscript(transcript);
  const promptIndices = findClaudeStartupPromptIndices(compactTranscript);

  return (
    promptIndices.projectMcpServers >
      latestOtherClaudeStartupPromptIndex(promptIndices, 'projectMcpServers') &&
    compactTranscript.includes('newmcpserversfoundinthisproject') &&
    compactTranscript.includes('selectanyyouwishtoenable') &&
    compactTranscript.includes('mcpserversmayexecutecode') &&
    compactTranscript.includes('entertoconfirm')
  );
}

export function isClaudeInteractiveReadyOrSafetyPrompt(
  transcript: string
): boolean {
  return (
    isClaudeInteractivePromptReady(transcript) ||
    isClaudeWorkspaceTrustPrompt(transcript) ||
    isClaudeProjectMcpServersSafetyPrompt(transcript) ||
    isClaudeDevelopmentChannelsSafetyPrompt(transcript) ||
    isClaudeBypassPermissionsSafetyPrompt(transcript)
  );
}

export async function acceptClaudeStartupPromptsIfPresent(
  session: InteractiveSession,
  timeoutMs: number
): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const transcript = session.rawTranscript();

    if (isClaudeInteractivePromptReady(transcript)) {
      return;
    }

    if (isClaudeWorkspaceTrustPrompt(transcript)) {
      await session.press('enter');
      await waitForClaudeStartupProgress(session, timeoutMs, 'workspace-trust');
      continue;
    }

    if (isClaudeProjectMcpServersSafetyPrompt(transcript)) {
      await session.press('enter');
      await waitForClaudeStartupProgress(session, timeoutMs, 'project-mcp');
      continue;
    }

    if (isClaudeDevelopmentChannelsSafetyPrompt(transcript)) {
      await session.press('enter');
      await waitForClaudeStartupProgress(
        session,
        timeoutMs,
        'development-channels'
      );
      continue;
    }

    if (isClaudeBypassPermissionsSafetyPrompt(transcript)) {
      await session.press('down');
      await session.press('enter');
      await waitForClaudeStartupProgress(
        session,
        timeoutMs,
        'bypass-permissions'
      );
      continue;
    }

    await session.waitFor(isClaudeInteractiveReadyOrSafetyPrompt, {
      timeoutMs
    });
  }

  if (!isClaudeInteractivePromptReady(session.rawTranscript())) {
    throw new Error(
      'Claude startup prompts did not settle to an interactive prompt after accepting known safety prompts.'
    );
  }
}

async function waitForClaudeStartupProgress(
  session: InteractiveSession,
  timeoutMs: number,
  acceptedPrompt:
    | 'workspace-trust'
    | 'project-mcp'
    | 'development-channels'
    | 'bypass-permissions'
): Promise<void> {
  await session.waitFor(
    (transcript) =>
      isClaudeInteractivePromptReady(transcript) ||
      (acceptedPrompt !== 'workspace-trust' &&
        isClaudeWorkspaceTrustPrompt(transcript)) ||
      (acceptedPrompt !== 'project-mcp' &&
        isClaudeProjectMcpServersSafetyPrompt(transcript)) ||
      (acceptedPrompt !== 'development-channels' &&
        isClaudeDevelopmentChannelsSafetyPrompt(transcript)) ||
      (acceptedPrompt !== 'bypass-permissions' &&
        isClaudeBypassPermissionsSafetyPrompt(transcript)),
    { timeoutMs }
  );
}

function compactClaudeTranscript(transcript: string): string {
  return normalizeTranscript(transcript).replace(/\s+/g, '').toLowerCase();
}

function findClaudeStartupPromptIndices(compactTranscript: string): {
  readonly workspaceTrust: number;
  readonly projectMcpServers: number;
  readonly bypassPermissions: number;
  readonly developmentChannels: number;
} {
  return {
    workspaceTrust: compactTranscript.lastIndexOf('quicksafetycheck:'),
    projectMcpServers: compactTranscript.lastIndexOf(
      'newmcpserversfoundinthisproject'
    ),
    bypassPermissions: compactTranscript.lastIndexOf('bypasspermissionsmode'),
    developmentChannels: compactTranscript.lastIndexOf(
      'iamusingthisforlocaldevelopment'
    )
  };
}

function latestOtherClaudeStartupPromptIndex(
  promptIndices: ReturnType<typeof findClaudeStartupPromptIndices>,
  currentPrompt:
    | 'workspaceTrust'
    | 'projectMcpServers'
    | 'bypassPermissions'
    | 'developmentChannels'
): number {
  return Math.max(
    ...Object.entries(promptIndices)
      .filter(([prompt]) => prompt !== currentPrompt)
      .map(([, index]) => index)
  );
}
