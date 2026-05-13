#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';

const HEADING = '## Teamem Space Rules';
const STARTER_PLACEHOLDER =
  'Run `/teamem-rule init` to pull the latest server-authored Space Rules snapshot into a managed block below. Teamem only refreshes that managed block and leaves the rest of this file alone.';

function canonicalRulesBody(body) {
  return body.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd();
}

function stableRulesHash(body) {
  return createHash('sha256').update(canonicalRulesBody(body)).digest('hex');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readJsonFromStdin() {
  const raw = readFileSync(0, 'utf8');
  return raw.length === 0 ? null : JSON.parse(raw);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readSnapshotResponseEnvelope(raw, context) {
  if (!raw || raw.ok !== true || !raw.data || !raw.data.metadata) {
    const message =
      raw?.error?.message ??
      raw?.body?.error?.message ??
      raw?.body?.error ??
      raw?.error ??
      `unexpected ${context} response`;
    fail(`teamem-rule: ${message}`);
  }
  return raw.data;
}

function readSessionSyncEnvelope(raw) {
  if (!raw || raw.ok !== true || !raw.data?.space_rules_snapshot?.metadata) {
    const message =
      raw?.error?.message ??
      raw?.body?.error?.message ??
      raw?.body?.error ??
      raw?.error ??
      'unexpected session_sync response';
    console.error(`teamem: ${message}`);
    process.exit(0);
  }
  return raw.data;
}

function metadataComment(snapshotMetadata) {
  return escapeHtmlCommentText(JSON.stringify(snapshotMetadata));
}

function escapeHtmlCommentText(value) {
  return value
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/--/g, '-\\u002d');
}

function buildManagedBlock(snapshot) {
  return `${snapshot.metadata.managed_begin}
<!-- teamem:space-rules ${metadataComment(snapshot.metadata)} -->
${snapshot.rendered_rules_body}
${snapshot.metadata.managed_end}
`;
}

function teamemPath(repoRoot) {
  return path.join(repoRoot, 'TEAMEM.md');
}

function cachePath(repoRoot) {
  return path.join(repoRoot, '.teamem', 'space-rules-snapshot.json');
}

function writeFileIfChanged(targetPath, nextContent) {
  if (existsSync(targetPath)) {
    const current = readFileSync(targetPath, 'utf8');
    if (current === nextContent) {
      return { changed: false, mtimeMs: statSync(targetPath).mtimeMs };
    }
  }
  writeFileSync(targetPath, nextContent);
  return { changed: true, mtimeMs: statSync(targetPath).mtimeMs };
}

function writeSnapshotCache(repoRoot, snapshot) {
  const target = cachePath(repoRoot);
  mkdirSync(path.dirname(target), { recursive: true });
  if (existsSync(target)) {
    try {
      const existing = JSON.parse(readFileSync(target, 'utf8'));
      if (JSON.stringify(existing?.snapshot) === JSON.stringify(snapshot)) {
        return { changed: false, mtimeMs: statSync(target).mtimeMs };
      }
    } catch {
      // Fall through to rewrite malformed cache files.
    }
  }
  const next = `${JSON.stringify(
    {
      saved_at: new Date().toISOString(),
      snapshot
    },
    null,
    2
  )}\n`;
  return writeFileIfChanged(target, next);
}

function readTeamemState(current, begin, end) {
  const beginLineRegex = new RegExp(`^${escapeRegExp(begin)}$`, 'gm');
  const endLineRegex = new RegExp(`^${escapeRegExp(end)}$`, 'gm');
  const beginCount = current.match(beginLineRegex)?.length ?? 0;
  const endCount = current.match(endLineRegex)?.length ?? 0;

  if (beginCount !== endCount || beginCount > 1) {
    return { kind: 'malformed-markers' };
  }

  if (beginCount === 0) {
    return { kind: 'missing-block' };
  }

  const blockRegex = new RegExp(
    `${escapeRegExp(begin)}\\n([\\s\\S]*?)\\n${escapeRegExp(end)}\\n?`,
    'm'
  );
  const match = blockRegex.exec(current);
  if (!match || match.index === undefined || typeof match[1] !== 'string') {
    return { kind: 'malformed-block' };
  }

  const blockLines = match[1].split('\n');
  const metadataPrefix = '<!-- teamem:space-rules ';
  const metadataLine = blockLines[0];
  if (
    !metadataLine?.startsWith(metadataPrefix) ||
    !metadataLine.endsWith(' -->')
  ) {
    return { kind: 'missing-metadata' };
  }

  let metadata;
  try {
    metadata = JSON.parse(metadataLine.slice(metadataPrefix.length, -4));
  } catch {
    return { kind: 'invalid-metadata' };
  }

  if (
    typeof metadata?.rules_version !== 'number' ||
    typeof metadata?.rules_hash !== 'string'
  ) {
    return { kind: 'invalid-metadata' };
  }

  const body = blockLines.slice(1).join('\n');
  return {
    kind: 'managed-block',
    metadata,
    body,
    bodyHash: stableRulesHash(body),
    match
  };
}

function findManagedBlockMatch(current, begin, end) {
  const beginLineRegex = new RegExp(`^${escapeRegExp(begin)}$`, 'gm');
  const endLineRegex = new RegExp(`^${escapeRegExp(end)}$`, 'gm');
  const beginCount = current.match(beginLineRegex)?.length ?? 0;
  const endCount = current.match(endLineRegex)?.length ?? 0;

  if (beginCount !== endCount || beginCount > 1) {
    return { kind: 'malformed-markers' };
  }

  if (beginCount === 0) {
    return { kind: 'missing-block' };
  }

  const blockRegex = new RegExp(
    `${escapeRegExp(begin)}\\n([\\s\\S]*?)\\n${escapeRegExp(end)}\\n?`,
    'm'
  );
  const match = blockRegex.exec(current);
  if (!match || match.index === undefined) {
    return { kind: 'malformed-block' };
  }

  return { kind: 'managed-block', match };
}

function renderManagedFile(current, starterTemplate, snapshot) {
  const managedBlock = buildManagedBlock(snapshot);
  const managedSection = `${HEADING}\n\n${managedBlock}`;

  if (current === null) {
    return starterTemplate.includes(HEADING)
      ? `${starterTemplate.trimEnd()}\n\n${managedBlock}`
      : `${starterTemplate.trimEnd()}\n\n${managedSection}`;
  }

  const state = findManagedBlockMatch(
    current,
    snapshot.metadata.managed_begin,
    snapshot.metadata.managed_end
  );
  if (state.kind === 'malformed-markers') {
    fail(
      'teamem-rule: TEAMEM.md has malformed managed-block markers; refusing to rewrite.'
    );
  }
  if (state.kind === 'malformed-block') {
    fail(
      'teamem-rule: TEAMEM.md has managed-block markers that do not form a replaceable block.'
    );
  }
  if (state.kind === 'managed-block') {
    return `${current.slice(0, state.match.index)}${managedBlock}${current.slice(
      state.match.index + state.match[0].length
    )}`;
  }

  if (current.includes(HEADING)) {
    const separator = current.endsWith('\n') ? '\n' : '\n\n';
    return `${current}${separator}${managedBlock}`;
  }

  const separator = current.endsWith('\n') ? '\n' : '\n\n';
  return `${current}${separator}${managedSection}`;
}

function commandInit(repoRoot, starterTemplatePath) {
  const snapshot = readSnapshotResponseEnvelope(
    readJsonFromStdin(),
    'snapshot'
  );
  const starterTemplate = readFileSync(starterTemplatePath, 'utf8');
  const filePath = teamemPath(repoRoot);

  if (!snapshot.has_server_rules) {
    if (!existsSync(filePath)) {
      writeFileSync(filePath, `${starterTemplate.trimEnd()}\n`);
      console.log('Initialized TEAMEM.md from the local starter template.');
    } else {
      console.log(
        'No server-authored Space Rules snapshot exists; left TEAMEM.md unchanged.'
      );
    }
    writeSnapshotCache(repoRoot, snapshot);
    console.log(
      `Cached snapshot metadata at ${path.relative(repoRoot, cachePath(repoRoot))}.`
    );
    return;
  }

  const current = existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
  const next = renderManagedFile(current, starterTemplate, snapshot);
  writeFileIfChanged(filePath, next);
  writeSnapshotCache(repoRoot, snapshot);
  console.log(
    'Initialized TEAMEM.md and refreshed the Teamem-managed Space Rules block.'
  );
  console.log(
    `Cached snapshot metadata at ${path.relative(repoRoot, cachePath(repoRoot))}.`
  );
}

function commandApplyUpdate(repoRoot) {
  const raw = readJsonFromStdin();
  if (!raw || raw.ok !== true || !raw.data || !raw.data.metadata) {
    const message =
      raw?.error?.message ??
      raw?.error?.code ??
      raw?.body?.error?.message ??
      raw?.body?.error ??
      'unexpected update response';
    if (raw?.error?.code === 'space_rules_conflict' && raw?.error?.details) {
      console.error(
        `teamem-rule: ${message} (current_version=${raw.error.details.current_version}, current_hash=${raw.error.details.current_hash})`
      );
    } else {
      console.error(`teamem-rule: ${message}`);
    }
    process.exit(1);
  }
  const snapshot = raw.data;
  const filePath = teamemPath(repoRoot);
  const current = readFileSync(filePath, 'utf8');
  const next = renderManagedFile(current, current, snapshot);
  writeFileIfChanged(filePath, next);
  writeSnapshotCache(repoRoot, snapshot);
  console.log(
    `Published Space Rules snapshot version ${snapshot.metadata.rules_version} and refreshed TEAMEM.md from the server response.`
  );
}

function logSyncConflict(local, server) {
  console.error(
    `teamem: ${JSON.stringify({
      code: 'space_rules_sync_conflict',
      message:
        'Refused to overwrite TEAMEM.md because both the local draft and the server Space Rules changed.',
      details: {
        local_version: local.version,
        local_hash: local.hash,
        local_base_hash: local.baseHash,
        server_version: server.version,
        server_hash: server.hash
      }
    })}`
  );
}

function commandSessionSync(repoRoot, starterTemplatePath) {
  const response = readSessionSyncEnvelope(readJsonFromStdin());
  const snapshot = response.space_rules_snapshot;
  const starterTemplate = readFileSync(starterTemplatePath, 'utf8');
  const filePath = teamemPath(repoRoot);
  const current = existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;

  if (current === null) {
    if (!snapshot.has_server_rules) {
      writeSnapshotCache(repoRoot, snapshot);
      return;
    }
    const next = renderManagedFile(null, starterTemplate, snapshot);
    writeFileIfChanged(filePath, next);
    writeSnapshotCache(repoRoot, snapshot);
    return;
  }

  const state = readTeamemState(
    current,
    snapshot.metadata.managed_begin,
    snapshot.metadata.managed_end
  );

  if (state.kind === 'malformed-markers') {
    console.error(
      'teamem: TEAMEM.md has malformed Teamem Space Rules markers; skipping Space Rules sync.'
    );
    return;
  }
  if (state.kind === 'malformed-block') {
    console.error(
      'teamem: TEAMEM.md has unreadable Teamem Space Rules markers; skipping Space Rules sync.'
    );
    return;
  }
  if (state.kind === 'invalid-metadata' || state.kind === 'missing-metadata') {
    console.error(
      'teamem: TEAMEM.md has unreadable Teamem Space Rules metadata; skipping Space Rules sync.'
    );
    return;
  }

  if (state.kind !== 'managed-block') {
    if (!snapshot.has_server_rules) {
      writeSnapshotCache(repoRoot, snapshot);
      return;
    }
    const next = renderManagedFile(current, starterTemplate, snapshot);
    writeFileIfChanged(filePath, next);
    writeSnapshotCache(repoRoot, snapshot);
    return;
  }

  const serverVersion = snapshot.metadata.rules_version;
  const serverHash = snapshot.metadata.rules_hash;
  const localVersion = state.metadata.rules_version;
  const localBaseHash = state.metadata.rules_hash;
  const localBodyHash = state.bodyHash;
  const localChanged = localBodyHash !== localBaseHash;
  const serverChanged =
    localVersion !== serverVersion || localBaseHash !== serverHash;

  if (!serverChanged) {
    writeSnapshotCache(repoRoot, snapshot);
    return;
  }

  if (!localChanged) {
    const next = renderManagedFile(current, starterTemplate, snapshot);
    writeFileIfChanged(filePath, next);
    writeSnapshotCache(repoRoot, snapshot);
    return;
  }

  logSyncConflict(
    {
      version: localVersion,
      hash: localBodyHash,
      baseHash: localBaseHash
    },
    {
      version: serverVersion,
      hash: serverHash
    }
  );
}

const [, , command, repoRoot, extraArg] = process.argv;

if (!command || !repoRoot) {
  fail(
    'teamem-rule: usage: bun space-rules-file.js <init|apply-update|session-sync> <repo-root> [starter-template]'
  );
}

switch (command) {
  case 'init':
    if (!extraArg) {
      fail('teamem-rule: starter template path is required for init');
    }
    commandInit(repoRoot, extraArg);
    break;
  case 'apply-update':
    commandApplyUpdate(repoRoot);
    break;
  case 'session-sync':
    if (!extraArg) {
      fail('teamem-rule: starter template path is required for session-sync');
    }
    commandSessionSync(repoRoot, extraArg);
    break;
  default:
    fail(`teamem-rule: unknown command "${command}"`);
}
