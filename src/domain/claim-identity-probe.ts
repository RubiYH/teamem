import { realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonicalizeRepoId, canonicalizePath } from './claim-identity-core.js';

export interface ClaimIdentity {
  repo_id: string;
  path: string | null;
  branch: string | null;
  head_sha: string | null;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 5000
  });
  if (result.status !== 0) return '';
  return (result.stdout ?? '').trim();
}

export async function probeClaimIdentity(
  absFilePath: string
): Promise<ClaimIdentity> {
  let resolved: string;
  try {
    resolved = await realpath(absFilePath);
  } catch {
    resolved = absFilePath;
  }

  const dir = dirname(resolved);
  const toplevel = git(dir, ['rev-parse', '--show-toplevel']);
  if (!toplevel) {
    return { repo_id: '', path: null, branch: null, head_sha: null };
  }

  const remoteUrl = git(toplevel, ['config', '--get', 'remote.origin.url']);
  const repo_id = remoteUrl ? canonicalizeRepoId(remoteUrl) : toplevel;

  const branchRaw = git(toplevel, ['symbolic-ref', '--short', 'HEAD']);
  const branch = branchRaw || null;

  const headShaRaw = git(toplevel, ['rev-parse', 'HEAD']);
  const head_sha = headShaRaw || null;

  const relPath = canonicalizePath(resolved, toplevel);

  return { repo_id, path: relPath, branch, head_sha };
}
