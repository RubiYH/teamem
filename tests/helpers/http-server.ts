import type { Hono } from 'hono';

type ClosableServer = {
  close(callback?: () => void): void;
};

const LOOPBACK_HOST = '127.0.0.1';
const EPHEMERAL_PORT_START = 49_152;
const EPHEMERAL_PORT_COUNT = 16_384;
const MAX_START_ATTEMPTS = 128;

let serverStartSequence = 0;

function candidatePort(sequence: number, attempt: number): number {
  const offset =
    (process.pid * 131 + sequence * 977 + attempt * 101) % EPHEMERAL_PORT_COUNT;
  return EPHEMERAL_PORT_START + offset;
}

function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EADDRINUSE'
  );
}

export async function startHonoTestServer(
  app: Hono
): Promise<{ server: ClosableServer; port: number }> {
  const sequence = serverStartSequence++;
  let lastAddressInUseError: unknown;

  for (let attempt = 0; attempt < MAX_START_ATTEMPTS; attempt++) {
    const port = candidatePort(sequence, attempt);
    try {
      const bunServer = Bun.serve({
        port,
        hostname: LOOPBACK_HOST,
        fetch: app.fetch
      });
      return {
        port,
        server: {
          close(callback?: () => void) {
            bunServer.stop(true);
            callback?.();
          }
        }
      };
    } catch (error) {
      if (isAddressInUse(error)) {
        lastAddressInUseError = error;
        continue;
      }
      throw error;
    }
  }

  throw new Error(
    `Unable to start loopback HTTP test server after ${MAX_START_ATTEMPTS} candidate ports` +
      (lastAddressInUseError instanceof Error
        ? `: ${lastAddressInUseError.message}`
        : '')
  );
}
