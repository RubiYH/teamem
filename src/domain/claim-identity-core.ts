/**
 * Pure deep module — no I/O, no clock, no random.
 * Canonical identity functions for claims, consumed by both the server
 * (validating incoming payloads) and the claimIdentityProbe I/O adapter.
 */

export function canonicalizeRepoId(remoteUrl: string): string {
  let s = remoteUrl.trim();

  // Strip protocol prefix: https://, http://, ssh://, git://
  s = s.replace(/^(https?|ssh|git):\/\//, '');

  // Strip userinfo (user:pass@ or user@)
  s = s.replace(/^[^@/]+@/, '');

  // Handle SCP-style git@ shorthand: host:path → host/path.
  // Port numbers look like host:2222/path — skip those (digits-only before slash).
  // SCP paths look like host:org/repo — replace the colon when the segment after
  // is NOT purely digits (i.e. not a port).
  s = s.replace(/^([^/:]+):(?!\d+\/)/, '$1/');

  // Strip .git suffix
  s = s.replace(/\.git$/, '');

  // Lowercase everything (host and path)
  s = s.toLowerCase();

  // Remove any trailing slashes
  s = s.replace(/\/+$/, '');

  return s;
}

export function canonicalizePath(
  resolvedAbsPath: string,
  resolvedRepoToplevel: string
): string | null {
  // Normalize: remove trailing slashes
  const absPath = resolvedAbsPath.replace(/\/+$/, '');
  const toplevel = resolvedRepoToplevel.replace(/\/+$/, '');

  // Convert backslashes to forward slashes (Windows compat)
  const normAbs = absPath.replace(/\\/g, '/');
  const normTop = toplevel.replace(/\\/g, '/');

  if (normAbs === normTop) {
    return '.';
  }

  if (!normAbs.startsWith(normTop + '/')) {
    return null;
  }

  return normAbs.slice(normTop.length + 1);
}
