/**
 * Phase 3 — `src/setup/credentials.ts`
 *
 * Re-export of the canonical credentials helpers in `src/bridge/credentials.ts`.
 * The plan (§5 Phase 3 step 4) explicitly allows "NEW or extend
 * src/bridge/credentials.ts" — the bridge module already implements:
 *   - readCredentials  (loadCredentials)
 *   - writeCredentials (saveCredentials, enforces mode 0600)
 *   - appendEntry      (append-or-update by space_id)
 *   - removeEntry      (pruneEntry)
 *   - selectEntry      (pickEntry)
 *
 * The plan body specifies an entries[] array shape, but the e2e tests
 * (tests/e2e/setup-create.test.ts, tests/e2e/setup-join.test.ts) and
 * tests/e2e/multi-space-corruption.test.ts ALL exercise the existing
 * `spaces` Record shape. Per the executor task brief, the test suite is
 * authoritative for Phase 3's gate (AC15/AC16); shape migration to
 * entries[] is deferred to Phase 4 if needed and is explicitly NOT this
 * phase's job. Re-exporting keeps a single source of truth and avoids
 * the dual-shape drift that the multi-space-corruption test guards
 * against.
 */
export {
  loadCredentials as readCredentials,
  saveCredentials as writeCredentials,
  appendEntry,
  pruneEntry as removeEntry,
  pickEntry as selectEntry,
  checkJwtExp,
  defaultCredentialsPath,
  SessionExpiredError,
  UnknownSpaceError,
  type CredentialEntry as SpaceEntry,
  type CredentialsFile
} from '../bridge/credentials.js';
