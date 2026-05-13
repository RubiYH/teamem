#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
# shellcheck source=./_common.sh
. "${PLUGIN_ROOT}/scripts/_common.sh"

if ! command -v bun >/dev/null 2>&1; then
  printf 'teamem-rule: Bun is required to initialize TEAMEM.md\n' >&2
  exit 1
fi

RULE_CALL="${PLUGIN_ROOT}/bin/teamem-call"
STARTER_TEMPLATE="${PLUGIN_ROOT}/templates/TEAMEM.starter.md"
SPACE_RULES_HELPER="${PLUGIN_ROOT}/scripts/space-rules-file.js"

if [ ! -f "${RULE_CALL}" ]; then
  printf 'teamem-rule: missing teamem-call wrapper at %s\n' "${RULE_CALL}" >&2
  exit 1
fi

if [ ! -f "${STARTER_TEMPLATE}" ]; then
  printf 'teamem-rule: missing starter template at %s\n' "${STARTER_TEMPLATE}" >&2
  exit 1
fi

if [ ! -f "${SPACE_RULES_HELPER}" ]; then
  printf 'teamem-rule: missing space-rules helper at %s\n' "${SPACE_RULES_HELPER}" >&2
  exit 1
fi

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
SNAPSHOT_JSON="$("${RULE_CALL}" teamem.export_space_rules_snapshot --json '{}')"

printf '%s' "${SNAPSHOT_JSON}" | bun "${SPACE_RULES_HELPER}" init "${REPO_ROOT}" "${STARTER_TEMPLATE}"
