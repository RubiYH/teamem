export interface RuntimePromptEnvironment {
  readonly isInteractive?: () => boolean;
  readonly prompt?: (message: string) => string | null;
}

export function isInteractiveTerminal(
  environment: RuntimePromptEnvironment = {}
): boolean {
  return (
    environment.isInteractive?.() ??
    (process.stdin.isTTY === true && process.stdout.isTTY === true)
  );
}

export function promptWithRuntime(
  message: string,
  environment: RuntimePromptEnvironment = {}
): string | null {
  const prompt = environment.prompt ?? getRuntimePrompt();
  return prompt(message);
}

function getRuntimePrompt(): (message: string) => string | null {
  const runtimePrompt = (globalThis as { prompt?: unknown }).prompt;
  if (typeof runtimePrompt !== 'function') {
    throw new Error(
      'Interactive prompt requires Bun prompt support. Re-run with explicit non-interactive flags.'
    );
  }
  return runtimePrompt as (message: string) => string | null;
}
