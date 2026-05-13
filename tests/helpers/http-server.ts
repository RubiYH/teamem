import type { Hono } from 'hono';

type ClosableServer = {
  close(callback?: () => void): void;
};

export async function startHonoTestServer(
  app: Hono
): Promise<{ server: ClosableServer; port: number }> {
  const bunServer = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: app.fetch
  });
  const port = bunServer.port;
  if (typeof port !== 'number') {
    bunServer.stop(true);
    throw new Error(
      'Loopback HTTP test server started without an assigned port'
    );
  }
  return {
    port,
    server: {
      close(callback?: () => void) {
        bunServer.stop(true);
        callback?.();
      }
    }
  };
}
