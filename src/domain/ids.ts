import { ulid } from 'ulidx';

export function newEventId(): string {
  return ulid();
}

export function newClaimId(): string {
  return ulid();
}

export function newIdempotencyKey(): string {
  return ulid();
}

function sha256Hex(input: string): string {
  // Bun.CryptoHasher is sync and zero-dep — preferred over the async
  // crypto.subtle.digest path so the gate can compute the key in the same
  // synchronous frame as the bun:sqlite transaction body.
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(input);
  return hasher.digest('hex');
}

/**
 * F-NEW-3 deterministic idempotency key for `claim_scope`. Keyed on
 * `(space_id, principal, normalized_scope_paths)` — NEVER on `actor`,
 * because the route layer auto-defaults `actor` to `principal` when
 * missing, so the same logical retry can carry different `actor` values.
 *
 * Caller MUST pre-normalize+sort+dedupe `normalizedPaths` (use
 * `normalizePathPattern` then `sortedUnique`) so two callers passing the
 * same logical scope land on the same hash.
 */
export function deterministicClaimIdempotencyKey(
  space_id: string,
  principal: string,
  normalizedPaths: string[]
): string {
  return sha256Hex(`${space_id}|${principal}|${normalizedPaths.join(',')}`);
}

/**
 * Companion to {@link deterministicClaimIdempotencyKey} for `release_scope`.
 * Keyed on `(space_id, principal, claim_id)` — `claim_id` already uniquely
 * identifies the target row, so no scope-paths normalization is required.
 */
export function deterministicReleaseIdempotencyKey(
  space_id: string,
  principal: string,
  claim_id: string
): string {
  return sha256Hex(`${space_id}|${principal}|${claim_id}`);
}

/**
 * Deterministic idempotency key for `post_message`. Keyed on the full
 * logical message identity so retries with identical args produce the same
 * key and are deduplicated by the `INSERT OR REPLACE` in the projection.
 *
 * Normalization rules (matching the plan spec):
 *  - recipient_principal / thread_id / in_reply_to: null/undefined → ""
 *  - body: trailing whitespace trimmed before hashing
 *  - request_id: optional caller-controlled nonce; omitted → ""
 */
export function deterministicMessageIdempotencyKey(
  space_id: string,
  principal: string,
  recipient_principal: string | null | undefined,
  thread_id: string | null | undefined,
  in_reply_to: string | null | undefined,
  body: string,
  request_id?: string
): string {
  const r = recipient_principal ?? '';
  const t = thread_id ?? '';
  const ir = in_reply_to ?? '';
  const b = body.trimEnd();
  const rid = request_id ?? '';
  return sha256Hex(`${space_id}|${principal}|${r}|${t}|${ir}|${b}|${rid}`);
}
