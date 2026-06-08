#!/usr/bin/env bun

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const FORMAT_VERSION = 1;
const DEFAULT_FRESHNESS_MS = 5 * 60 * 1000;

function main() {
  const [dataRoot, projectKey, sessionId, workspaceCurrentDir] =
    process.argv.slice(2);
  if (!dataRoot) return;

  const raw = readStdinJson();
  const space = extractSpace(raw);
  if (!space) return;

  const now = new Date();
  const target = path.join(dataRoot, 'statusline', 'display.json');
  const cachedFreshSprintSpace = readFreshSprintCacheSpace(target, now);
  if (cachedFreshSprintSpace && spaceMatches(space, cachedFreshSprintSpace)) {
    return;
  }

  const record = {
    format_version: FORMAT_VERSION,
    updated_at: now.toISOString(),
    fresh_until: new Date(now.getTime() + DEFAULT_FRESHNESS_MS).toISOString(),
    identity: {
      ...(projectKey ? { project_key: projectKey } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(workspaceCurrentDir
        ? { workspace_current_dir: workspaceCurrentDir }
        : {})
    },
    space
  };

  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`);
}

function readStdinJson() {
  try {
    const raw = readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function extractSpace(raw) {
  if (!raw || raw.ok !== true || !raw.data) return undefined;
  const candidates = [
    raw.data.space,
    raw.data.current_space,
    raw.data.context?.space,
    raw.data.whoami,
    raw.data.space_rules_snapshot?.metadata
  ];
  for (const candidate of candidates) {
    const normalized = normalizeSpace(candidate);
    if (normalized) return normalized;
  }
  return undefined;
}

function normalizeSprint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const id = stringValue(value.sprint_id) ?? stringValue(value.id);
  const slug = stringValue(value.slug);
  const name =
    stringValue(value.display_name) ?? stringValue(value.name) ?? slug ?? id;
  return name
    ? {
        ...(id ? { sprint_id: id } : {}),
        ...(slug ? { slug } : {}),
        display_name: name
      }
    : undefined;
}

function readFreshSprintCacheSpace(target, now) {
  try {
    const parsed = JSON.parse(readFileSync(target, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    if (parsed.format_version !== FORMAT_VERSION) return undefined;
    const freshUntil =
      typeof parsed.fresh_until === 'string'
        ? Date.parse(parsed.fresh_until)
        : Number.NaN;
    const hasFreshSprint =
      Number.isFinite(freshUntil) &&
      freshUntil > now.getTime() &&
      !!normalizeSprint(parsed.sprint);
    return hasFreshSprint ? normalizeSpace(parsed.space) : undefined;
  } catch {
    return undefined;
  }
}

function normalizeSpace(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const id =
    stringValue(value.id) ??
    stringValue(value.space_id) ??
    stringValue(value.spaceId);
  const label =
    stringValue(value.label) ??
    stringValue(value.space_label) ??
    stringValue(value.spaceLabel) ??
    id;
  return label ? { ...(id ? { id } : {}), label } : undefined;
}

function spaceMatches(incoming, cached) {
  if (!incoming || !cached) return false;
  if (incoming.id && cached.id) return incoming.id === cached.id;
  return incoming.label === cached.label;
}

function stringValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

main();
