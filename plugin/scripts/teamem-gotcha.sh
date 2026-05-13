#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

if ! command -v bun >/dev/null 2>&1; then
  printf 'teamem-gotcha: Bun is required to share gotchas\n' >&2
  exit 1
fi

TEAMEM_CALL="${PLUGIN_ROOT}/bin/teamem-call"
if [ ! -f "${TEAMEM_CALL}" ]; then
  printf 'teamem-gotcha: missing teamem-call wrapper at %s\n' "${TEAMEM_CALL}" >&2
  exit 1
fi

RAW_INPUT="${*:-}"

REQUEST_JSON="$(
  bun -e '
const raw = process.argv.slice(1).join(" ").trim();

function die(message) {
  console.error(`teamem-gotcha: ${message}`);
  process.exit(1);
}

if (raw.length === 0) die("summary is required");

const parts = raw.split(/\s+/).filter(Boolean);
const tags = [];
const summaryParts = [];
let severity = "info";

for (const part of parts) {
  const severityMatch = /^--severity=(info|warning|urgent)$/.exec(part);
  if (severityMatch) {
    severity = severityMatch[1];
    continue;
  }
  if (part.startsWith("--severity=")) {
    die("severity must be one of info, warning, urgent");
  }
  if (/^#[A-Za-z0-9_-]+$/.test(part)) {
    tags.push(part.slice(1).toLowerCase());
    continue;
  }
  summaryParts.push(part);
}

const summary = summaryParts.join(" ").trim();
if (summary.length === 0) die("summary is required after stripping tags");
if (summary.length > 280) die("summary must not exceed 280 characters");

const uniqueTags = [...new Set(tags)];
if (uniqueTags.length > 32) die("tags must not exceed 32 entries");

process.stdout.write(
  JSON.stringify({
    kind: "gotcha",
    summary,
    tags: uniqueTags,
    severity
  })
);
' -- "${RAW_INPUT}"
)"

RESPONSE_JSON="$("${TEAMEM_CALL}" teamem.share_finding --json "${REQUEST_JSON}")"

printf '%s' "${RESPONSE_JSON}" | bun -e '
const raw = await Bun.stdin.text();
let response;
try {
  response = JSON.parse(raw);
} catch {
  console.error("teamem-gotcha: invalid server response");
  process.exit(1);
}

if (!response?.ok) {
  const code = response?.error?.code ?? response?.body?.error?.code ?? "unknown_error";
  const message =
    response?.error?.message ??
    response?.body?.error?.message ??
    response?.body?.error ??
    "sharing gotcha failed";
  console.error(`teamem-gotcha: ${code} — ${message}`);
  process.exit(1);
}

const data = response.data ?? {};
const expires = data.expires_at === null ? "persistent" : `expires ${data.expires_at}`;
console.log(
  `Shared gotcha ${data.finding_id} (severity=${data.severity ?? "unknown"}, ${expires}).`
);
'
