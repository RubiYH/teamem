#!/usr/bin/env bash
# Plugin Stop hook — telemetry only. Claims survive turn end.
#
# Per slice #28: the Stop hook no longer releases claims. Claims persist
# across turn boundaries until explicitly released via teamem.release_scope,
# teamem.force_release, or git evidence (post-commit hook).
#
# The hook still fires for telemetry: writes a single stop_hook_fired line
# to the trace log and exits 0. Tier-W silent-failure surfacing remains for
# any infra errors in this path.

[ "${TEAMEM_HOOK_DISABLE:-}" = "1" ] && exit 0

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
# shellcheck source=./_common.sh
. "${PLUGIN_ROOT}/scripts/_common.sh"

INPUT=$(cat)

PARSE_RESULT=$(printf '%s' "$INPUT" | bun -e '
const enc = (s) => Buffer.from(String(s), "utf8").toString("base64");
try {
  const i = JSON.parse(await Bun.stdin.text());
  const sid = i.session_id || i.sessionId || "";
  process.stdout.write(enc(sid));
} catch {
  process.stdout.write("");
}
' 2>/dev/null) || PARSE_RESULT=""

_b64dec() { printf '%s' "${1:-}" | base64 -d 2>/dev/null || printf ''; }

SESSION_ID=$(_b64dec "$PARSE_RESULT")

[ -z "$SESSION_ID" ] && exit 0

teamem_resolve_session_dir "$SESSION_ID"
teamem_is_active || exit 0

LOG_DIR="${HOME}/.cache/teamem"
TRACE_FILE="${LOG_DIR}/hook-trace.log"

mkdir -p "$LOG_DIR" 2>/dev/null || true

_emit_trace() {
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo unknown)
  printf '{"ts":"%s","event":"stop_hook_fired","session_id":"%s","released_count":0,"left_count":0}\n' \
    "$ts" "$SESSION_ID" >> "$TRACE_FILE" 2>/dev/null || \
    _teamem_warn "teamem: stop hook trace write failed"
}

_emit_trace

exit 0
