import {
  normalizeTranscript,
  type InteractiveSession
} from '../../plugin-e2e-module/src/index.js';

export function isClaudeInteractivePromptReady(transcript: string): boolean {
  const normalized = normalizeTranscript(transcript);

  return (
    /(^|\n)[^\S\n]*[>›❯][^\S\n]*(?=\n|$)/.test(normalized) ||
    /\btry ["'].*["']/i.test(normalized)
  );
}

export function isClaudeWorkspaceTrustPrompt(transcript: string): boolean {
  const compactTranscript = compactClaudeTranscript(transcript);
  const trustPromptIndex = compactTranscript.lastIndexOf('quicksafetycheck:');
  const bypassPromptIndex = compactTranscript.lastIndexOf(
    'bypasspermissionsmode'
  );

  return (
    trustPromptIndex > bypassPromptIndex &&
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
  const trustPromptIndex = compactTranscript.lastIndexOf('quicksafetycheck:');
  const bypassPromptIndex = compactTranscript.lastIndexOf(
    'bypasspermissionsmode'
  );

  return (
    bypassPromptIndex > trustPromptIndex &&
    compactTranscript.includes('bypasspermissionsmode') &&
    compactTranscript.includes('yes,iaccept')
  );
}

export function isClaudeInteractiveReadyOrSafetyPrompt(
  transcript: string
): boolean {
  return (
    isClaudeInteractivePromptReady(transcript) ||
    isClaudeWorkspaceTrustPrompt(transcript) ||
    isClaudeBypassPermissionsSafetyPrompt(transcript)
  );
}

export async function acceptClaudeStartupPromptsIfPresent(
  session: InteractiveSession,
  timeoutMs: number
): Promise<void> {
  if (isClaudeInteractivePromptReady(session.rawTranscript())) {
    return;
  }

  if (isClaudeWorkspaceTrustPrompt(session.rawTranscript())) {
    await session.press('enter');
    await session.waitFor(
      (transcript) =>
        isClaudeInteractivePromptReady(transcript) ||
        isClaudeBypassPermissionsSafetyPrompt(transcript),
      { timeoutMs }
    );
  }

  if (isClaudeBypassPermissionsSafetyPrompt(session.rawTranscript())) {
    await session.press('down');
    await session.press('enter');
    await session.waitFor(isClaudeInteractivePromptReady, { timeoutMs });
  }
}

function compactClaudeTranscript(transcript: string): string {
  return normalizeTranscript(transcript).replace(/\s+/g, '').toLowerCase();
}
