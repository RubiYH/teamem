#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
# shellcheck source=./_common.sh
. "${PLUGIN_ROOT}/scripts/_common.sh"

if ! command -v bun >/dev/null 2>&1; then
  printf 'teamem-rule: Bun is required to update TEAMEM.md\n' >&2
  exit 1
fi

RULE_CALL="${PLUGIN_ROOT}/bin/teamem-call"
SPACE_RULES_HELPER="${PLUGIN_ROOT}/scripts/space-rules-file.js"

if [ ! -f "${RULE_CALL}" ]; then
  printf 'teamem-rule: missing teamem-call wrapper at %s\n' "${RULE_CALL}" >&2
  exit 1
fi

if [ ! -f "${SPACE_RULES_HELPER}" ]; then
  printf 'teamem-rule: missing space-rules helper at %s\n' "${SPACE_RULES_HELPER}" >&2
  exit 1
fi

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

REQUEST_JSON="$(bun -e '
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const repoRoot = process.argv[1];
const teamemPath = path.join(repoRoot, "TEAMEM.md");
const heading = "## Teamem Space Rules";
const starterPlaceholder =
  "Run `/teamem-rule init` to pull the latest server-authored Space Rules snapshot into a managed block below. Teamem only refreshes that managed block and leaves the rest of this file alone.";

const begin = "<!-- BEGIN TEAMEM SPACE RULES -->";
const end = "<!-- END TEAMEM SPACE RULES -->";

function stableHash(body) {
  return createHash("sha256")
    .update(body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd())
    .digest("hex");
}

if (!fs.existsSync(teamemPath)) {
  console.error("teamem-rule: TEAMEM.md does not exist; run /teamem-rule init first.");
  process.exit(1);
}

const current = fs.readFileSync(teamemPath, "utf8");
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const beginCount = current.match(new RegExp(`^${escapeRegExp(begin)}$`, "gm"))?.length ?? 0;
const endCount = current.match(new RegExp(`^${escapeRegExp(end)}$`, "gm"))?.length ?? 0;

if (beginCount !== endCount || beginCount > 1) {
  console.error("teamem-rule: TEAMEM.md has malformed managed-block markers; refusing to publish.");
  process.exit(1);
}

if (beginCount === 1) {
  const blockRegex = new RegExp(
    `${escapeRegExp(begin)}\\n([\\s\\S]*?)\\n${escapeRegExp(end)}\\n?`,
    "m"
  );
  const match = blockRegex.exec(current);
  if (!match || typeof match[1] !== "string") {
    console.error("teamem-rule: TEAMEM.md has managed-block markers that do not form a readable block.");
    process.exit(1);
  }

  const blockLines = match[1].split("\n");
  let metadata = null;
  if (blockLines[0]?.startsWith("<!-- teamem:space-rules ")) {
    const line = blockLines.shift();
    const prefix = "<!-- teamem:space-rules ";
    if (!line.endsWith(" -->")) {
      console.error("teamem-rule: TEAMEM.md has malformed managed-block metadata.");
      process.exit(1);
    }
    try {
      metadata = JSON.parse(line.slice(prefix.length, -4));
    } catch {
      console.error("teamem-rule: TEAMEM.md has unreadable managed-block metadata.");
      process.exit(1);
    }
  }

  if (!metadata || typeof metadata.rules_version !== "number" || typeof metadata.rules_hash !== "string") {
    console.error("teamem-rule: TEAMEM.md is missing managed-block rules_version/rules_hash metadata.");
    process.exit(1);
  }

  process.stdout.write(
    JSON.stringify({
      rules_markdown: blockLines.join("\n"),
      base_version: metadata.rules_version,
      base_hash: metadata.rules_hash
    })
  );
  process.exit(0);
}

const headingIndex = current.indexOf(heading);
if (headingIndex === -1) {
  console.error("teamem-rule: TEAMEM.md is missing the \"## Teamem Space Rules\" section.");
  process.exit(1);
}

const sectionStart = current.indexOf("\n", headingIndex);
const tail = sectionStart === -1 ? "" : current.slice(sectionStart + 1);
const nextHeadingOffset = tail.search(/^##\s/m);
const sectionBody = (nextHeadingOffset === -1 ? tail : tail.slice(0, nextHeadingOffset)).trim();

if (sectionBody.length === 0 || sectionBody === starterPlaceholder) {
  console.error("teamem-rule: no local Space Rules draft found; edit the Teamem Space Rules section first.");
  process.exit(1);
}

process.stdout.write(
  JSON.stringify({
    rules_markdown: sectionBody,
    base_version: 0,
    base_hash: stableHash("")
  })
);
' "${REPO_ROOT}")"

RESPONSE_JSON="$("${RULE_CALL}" teamem.update_space_rules --json "${REQUEST_JSON}")"

printf '%s' "${RESPONSE_JSON}" | bun "${SPACE_RULES_HELPER}" apply-update "${REPO_ROOT}"
