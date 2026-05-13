import { pruneEntry, SessionExpiredError } from './credentials.js';

/**
 * Thrown by the bridge HTTP client when the server returns 410 Gone — i.e.
 * the space has been disbanded. The CLI/bridge entry point catches this and
 * decides whether to print a stderr message and exit. Library code in
 * http-client.ts MUST NOT call process.exit directly (it makes the module
 * un-testable and surprises any harness embedding it).
 */
export class SpaceDisbandedError extends Error {
  readonly space_id: string;
  readonly space_label: string;
  constructor(space_id: string, space_label: string) {
    super(`Space ${space_id} (label: ${space_label}) was disbanded`);
    this.name = 'SpaceDisbandedError';
    this.space_id = space_id;
    this.space_label = space_label;
  }
}

export type HttpClientError = {
  ok: false;
  status: number;
  error: string;
  body: unknown;
};

export type HttpClientResult<T> = { ok: true; data: T } | HttpClientError;

export interface BridgeHttpClient {
  post<T = unknown>(path: string, body: unknown): Promise<HttpClientResult<T>>;
}

export interface BridgeHttpClientOptions {
  baseUrl: string;
  jwt: string;
  spaceId: string;
  spaceLabel: string;
  credPath?: string;
}

export function createHttpClient(
  opts: BridgeHttpClientOptions
): BridgeHttpClient {
  const { baseUrl, jwt, spaceId, spaceLabel, credPath } = opts;

  return {
    async post<T = unknown>(
      path: string,
      body: unknown
    ): Promise<HttpClientResult<T>> {
      let res: Response;
      try {
        res = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${jwt}`
          },
          body: JSON.stringify(body)
        });
      } catch (err) {
        return {
          ok: false,
          status: 0,
          error: 'network_error',
          body: (err as Error).message
        };
      }

      if (res.status === 410) {
        await pruneEntry(spaceId, credPath);
        // Library code must not call process.exit. The bridge entry point
        // catches this typed error and decides whether to log + exit.
        throw new SpaceDisbandedError(spaceId, spaceLabel);
      }

      let responseBody: unknown;
      try {
        responseBody = await res.json();
      } catch {
        responseBody = null;
      }

      if (!res.ok) {
        // Phase 2b — for the structured 409 from the TOCTOU gate, the
        // server returns its native `{ok: false, error: {code, ...}}`
        // shape (with `colliding_paths`/`conflicting_principal`). Pass
        // it through verbatim so MCP consumers see the typed error
        // instead of an opaque transport envelope (AC-NEW-7).
        if (
          res.status === 409 &&
          responseBody &&
          typeof responseBody === 'object' &&
          (responseBody as { ok?: unknown }).ok === false &&
          typeof (responseBody as { error?: unknown }).error === 'object'
        ) {
          return { ok: true, data: responseBody as T };
        }
        return {
          ok: false,
          status: res.status,
          error: `http_${res.status}`,
          body: responseBody
        };
      }

      return { ok: true, data: responseBody as T };
    }
  };
}

export { SessionExpiredError };
