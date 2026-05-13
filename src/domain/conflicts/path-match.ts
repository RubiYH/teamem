/**
 * Pure path-overlap matcher for the conflict engine.
 *
 * Token vocabulary (F7):
 *   - `**`  zero-or-more *segments*
 *   - `*`   zero-or-more chars within a single segment
 *   - `?`   exactly one char within a single segment
 *   - all other chars are literal
 *
 * No braces, no extglobs, no character classes.
 *
 * Two patterns A and B *overlap* iff there exists at least one POSIX path
 * string S that matches both. The matcher is symmetric (F8).
 *
 * Module is pure: no I/O, no `node:*`/`bun:*` imports, no `Date`,
 * no `process.env` (N3, AC22).
 */

export type ActiveClaimRow = {
  claim_id: string;
  principal: string;
  scope_paths: string[];
  expires_at?: string;
};

export type OverlapHit = {
  claim_id: string;
  principal: string;
  matched_target_paths: string[];
  expires_at?: string;
};

/**
 * F6 normalization: trim, strip leading `./`, collapse internal `//`,
 * strip trailing `/` (unless the whole pattern is `/`). Separators are
 * left as-is (POSIX-only per Q8 deferral; do NOT translate `\` → `/`).
 */
export function normalizePathPattern(p: string): string {
  let s = p.trim();
  while (s.startsWith('./')) s = s.slice(2);
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

function tokenize(p: string): string[] {
  return normalizePathPattern(p).split('/');
}

function hasGlobChars(seg: string): boolean {
  return seg.includes('*') || seg.includes('?');
}

/**
 * Per-segment glob-vs-glob overlap (no `/` allowed in either side).
 * Returns true iff there exists at least one literal string S (without `/`)
 * that matches both `a` and `b` under {`*` = zero-or-more non-slash, `?` =
 * one non-slash, literal otherwise} semantics.
 *
 * Strategy: dynamic-programming reachability over (i, j) positions in a, b.
 * Step rules:
 *   - if both consume a literal char, they must match exactly → consume both.
 *   - if one side has `*`, it can stay (consume nothing on that side) or
 *     consume one char of the eventual S (consume one literal/`?` from the
 *     other side, or pair with the other `*`).
 *   - `?` consumes exactly one char of S → must be paired with one literal,
 *     `?`, or one `*`-step on the other side.
 *
 * For our small segment alphabet this is O(|a|·|b|).
 */
function segmentsOverlap(a: string, b: string): boolean {
  // Fast paths:
  if (!hasGlobChars(a) && !hasGlobChars(b)) return a === b;
  if (a === '*' || b === '*') return true;
  // If only one side has glob chars, the other is a literal we match against
  // the glob side as pattern.
  if (!hasGlobChars(a)) return matchSegment(b, a);
  if (!hasGlobChars(b)) return matchSegment(a, b);

  const n = a.length;
  const m = b.length;
  // visited[i][j] === true means we've already explored this state.
  const visited: boolean[] = new Array((n + 1) * (m + 1)).fill(false);
  const idx = (i: number, j: number): number => i * (m + 1) + j;

  // Iterative DFS to avoid recursion depth concerns.
  const stack: number[] = [0, 0];
  while (stack.length > 0) {
    const j = stack.pop() as number;
    const i = stack.pop() as number;
    if (i === n && j === m) return true;
    if (visited[idx(i, j)]) continue;
    visited[idx(i, j)] = true;

    const ca = i < n ? a[i] : null;
    const cb = j < m ? b[j] : null;

    // a-side `*`: stays (i unchanged) or consumes one char of S.
    if (ca === '*') {
      // stay (consume zero chars of S)
      stack.push(i + 1, j);
      // consume one char of S — pair with whatever b can offer
      if (cb !== null) {
        if (cb === '*') {
          // both stars consume one char together
          stack.push(i, j + 1);
          stack.push(i + 1, j + 1);
        } else if (cb === '?') {
          stack.push(i, j + 1); // a* eats the char that ?-side requires
        } else {
          // literal on b: a* consumes that literal char of S
          stack.push(i, j + 1);
        }
      }
      continue;
    }
    // symmetric for b-side `*`
    if (cb === '*') {
      stack.push(i, j + 1);
      if (ca !== null) {
        if (ca === '?') {
          stack.push(i + 1, j);
        } else {
          stack.push(i + 1, j);
        }
      }
      continue;
    }

    // No stars at this position. Both must consume one char of S.
    if (ca === null || cb === null) continue;
    if (ca === '?' || cb === '?' || ca === cb) {
      stack.push(i + 1, j + 1);
    }
  }
  return false;
}

/**
 * Match a single segment pattern (with `*`/`?`) against a literal segment.
 * Used when only one side has glob chars (fast path inside `segmentsOverlap`).
 */
function matchSegment(pattern: string, literal: string): boolean {
  const n = pattern.length;
  const m = literal.length;
  // dp[i][j] = pattern[..i] matches literal[..j]
  const dp: boolean[] = new Array((n + 1) * (m + 1)).fill(false);
  const idx = (i: number, j: number): number => i * (m + 1) + j;
  dp[idx(0, 0)] = true;
  for (let i = 1; i <= n; i++) {
    if (pattern[i - 1] === '*') dp[idx(i, 0)] = dp[idx(i - 1, 0)];
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const pc = pattern[i - 1];
      if (pc === '*') {
        dp[idx(i, j)] = dp[idx(i - 1, j)] || dp[idx(i, j - 1)];
      } else if (pc === '?' || pc === literal[j - 1]) {
        dp[idx(i, j)] = dp[idx(i - 1, j - 1)];
      }
    }
  }
  return dp[idx(n, m)];
}

/**
 * Walk two segment-tokenized patterns and decide overlap. `**` consumes
 * zero or more segments; everything else is per-segment.
 */
function walk(
  a: string[],
  b: string[],
  i: number,
  j: number,
  memo: Map<number, boolean>
): boolean {
  if (i === a.length && j === b.length) return true;
  const key = i * (b.length + 1) + j;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  const sa = i < a.length ? a[i] : null;
  const sb = j < b.length ? b[j] : null;

  // `**` on a-side: skip zero or more segments of b.
  if (sa === '**') {
    // Consume zero segments of a (treat the ** as already done) — but only if
    // the rest of a can still match (a-tail must be matchable to b-tail).
    if (walk(a, b, i + 1, j, memo)) {
      memo.set(key, true);
      return true;
    }
    // Consume one segment of b.
    if (j < b.length && walk(a, b, i, j + 1, memo)) {
      memo.set(key, true);
      return true;
    }
    memo.set(key, false);
    return false;
  }
  // symmetric for b-side `**`
  if (sb === '**') {
    if (walk(a, b, i, j + 1, memo)) {
      memo.set(key, true);
      return true;
    }
    if (i < a.length && walk(a, b, i + 1, j, memo)) {
      memo.set(key, true);
      return true;
    }
    memo.set(key, false);
    return false;
  }

  // Neither side is `**`. Must consume one segment from each.
  if (sa === null || sb === null) {
    memo.set(key, false);
    return false;
  }
  const ok = segmentsOverlap(sa, sb) && walk(a, b, i + 1, j + 1, memo);
  memo.set(key, ok);
  return ok;
}

/**
 * F1/F7/F8: returns true iff `a` and `b` denote sets of paths whose
 * intersection is non-empty under the segment-glob model above.
 */
export function pathsOverlap(a: string, b: string): boolean {
  const na = normalizePathPattern(a);
  const nb = normalizePathPattern(b);
  if (na === nb) return true;
  // AC13: trailing-slash-only pattern is a literal directory token, not a
  // glob — the normalizer strips trailing slash already, so `'src/auth/'`
  // becomes `'src/auth'` and we compare it as a literal segment list.
  const tokA = tokenize(na);
  const tokB = tokenize(nb);
  return walk(tokA, tokB, 0, 0, new Map());
}

/**
 * F2: returns the *target-side* patterns from `target` that overlap any
 * pattern in `other`. Result is deduplicated and sorted lexicographically
 * for determinism (AC15).
 */
export function findOverlaps(target: string[], other: string[]): string[] {
  const out = new Set<string>();
  for (const t of target) {
    for (const o of other) {
      if (pathsOverlap(t, o)) {
        out.add(t);
        break;
      }
    }
  }
  return Array.from(out).sort();
}

/**
 * Pure read for the gate. Operates on already-loaded claim rows; the SQL
 * SELECT lives in the DB-side helper. Per-claim overlap returns the subset
 * of `candidatePaths` that matched any of the claim's `scope_paths`.
 *
 * The third `opts` argument carries a *test-only* synchronous seam used by
 * AC-NEW-2 to prove SELECT-then-INSERT atomicity. **MUST be synchronous —
 * `bun:sqlite`'s `db.transaction(fn)` callback is sync; awaiting a Promise
 * would let the tx commit before the seam fires.**
 */
export function findOverlappingActiveClaims(
  claims: ActiveClaimRow[],
  candidatePaths: string[],
  opts?: { afterSelectHook?: () => void }
): OverlapHit[] {
  if (opts?.afterSelectHook) opts.afterSelectHook();
  const hits: OverlapHit[] = [];
  for (const claim of claims) {
    const matched = findOverlaps(candidatePaths, claim.scope_paths);
    if (matched.length > 0) {
      hits.push({
        claim_id: claim.claim_id,
        principal: claim.principal,
        matched_target_paths: matched,
        expires_at: claim.expires_at
      });
    }
  }
  return hits;
}
