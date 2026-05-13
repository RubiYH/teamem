/**
 * Pure deep module — no I/O, no clock, no random.
 * Encodes the release decision rule:
 *   HEAD advanced past head_sha_at_acquire AND porcelain clean for path AND branch matches.
 *
 * For deleted/renamed paths, porcelain state is bypassed — the file is gone,
 * so outstanding claims on it must always release.
 */

export interface ClaimSnapshot {
  head_sha_at_acquire: string | null;
  branch: string;
  path: string;
  auto_release_mode: 'on_commit' | 'manual_only' | 'ttl';
}

export type CommitStatus = 'M' | 'A' | 'D' | 'R';

export type ReleaseDecision =
  | { decision: 'release' }
  | {
      decision: 'still_held';
      reason:
        | 'head_unchanged'
        | 'working_tree_dirty'
        | 'manual_only'
        | 'invalid_sha';
    }
  | { decision: 'branch_mismatch'; reason: string };

/**
 * SHA-1 commit hash format: 40 lowercase hex chars. Anything else is
 * rejected as malformed evidence — the post-commit hook should never
 * surface a non-SHA, but the trust-model contract (ADR-0008 §"Trust
 * model") says we validate syntactic shape before acting on git
 * evidence.
 */
const FULL_SHA_RE = /^[0-9a-f]{40}$/;

export function evaluateRelease(
  claim: ClaimSnapshot,
  observedHeadSha: string,
  observedPorcelainDirty: boolean,
  observedBranch: string,
  commitStatus?: CommitStatus
): ReleaseDecision {
  if (claim.auto_release_mode === 'manual_only') {
    return { decision: 'still_held', reason: 'manual_only' };
  }

  // codex-review fix (task #4): reject malformed SHAs before any
  // release decision. Empty / wrong-length / uppercase / non-hex
  // strings should not advance any claim's lifecycle.
  if (
    typeof observedHeadSha !== 'string' ||
    !FULL_SHA_RE.test(observedHeadSha)
  ) {
    return { decision: 'still_held', reason: 'invalid_sha' };
  }

  if (observedBranch !== claim.branch) {
    return {
      decision: 'branch_mismatch',
      reason: `claim branch '${claim.branch}' != observed branch '${observedBranch}'`
    };
  }

  if (
    claim.head_sha_at_acquire !== null &&
    observedHeadSha === claim.head_sha_at_acquire
  ) {
    return { decision: 'still_held', reason: 'head_unchanged' };
  }

  // Deleted and renamed-away paths are gone from the working tree — bypass porcelain check.
  const isGone = commitStatus === 'D' || commitStatus === 'R';
  if (!isGone && observedPorcelainDirty) {
    return { decision: 'still_held', reason: 'working_tree_dirty' };
  }

  return { decision: 'release' };
}
