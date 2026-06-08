#!/usr/bin/env bash
# Plugin SessionStart hook — syncs Space Rules and surfaces queued notifications.
#
# On every SessionStart:
# 1. Injects one short instruction on startup/resume so Claude fetches the full
#    briefing once, then relies on lighter edit-time claim tools.
# 2. Calls the dedicated teamem.session_sync path for Space Rules correctness.
# 3. Surfaces decision replays and gotcha notices from session_sync.
# 4. Fetches unread_notifications for the current principal and surfaces each
#    as a Tier-W warn line so the user sees pending force-release alerts from
#    sessions that were offline or had no live channel delivery.

set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
# shellcheck source=./_common.sh
. "${PLUGIN_ROOT}/scripts/_common.sh"

INPUT=$(cat 2>/dev/null || true)
SID=$(teamem_session_id_from_stdin_json "$INPUT")
teamem_resolve_session_dir "$SID"
SESSION_SOURCE=$(printf '%s' "$INPUT" | bun -e '
try {
  const raw = await Bun.stdin.text();
  const i = raw.trim() ? JSON.parse(raw) : {};
  process.stdout.write(String(i.source || ""));
} catch {
  process.stdout.write("");
}
' 2>/dev/null || printf '')

_teamem_activate_from_launch_intent() {
  case "${TEAMEM_CLAUDE_LAUNCH_INTENT:-}" in
    activate|teamem|1|true) ;;
    *) return 0 ;;
  esac

  [ -x "${PLUGIN_ROOT}/bin/teamem-flag" ] || {
    _teamem_warn "launch-intent" "could not activate Teamem because teamem-flag is missing; reinstall with \`teamem init\`."
    return 1
  }

  local launch_space="${TEAMEM_CLAUDE_LAUNCH_SPACE:-${TEAMEM_SPACE:-}}"
  if [ -n "$launch_space" ]; then
    if ! TEAMEM_SPACE="$launch_space" bun run "$BRIDGE_JS" call teamem.whoami --space "$launch_space" --json '{}' >/dev/null 2>&1; then
      _teamem_warn "launch-intent" "could not activate Teamem for Space '${launch_space}'; run \`teamem init\` or set TEAMEM_SPACE to a valid Space id or label."
      return 1
    fi
    if ! CLAUDE_SESSION_ID="$SESSION_ID" "${PLUGIN_ROOT}/bin/teamem-flag" enable --space "$launch_space" >/dev/null 2>&1; then
      _teamem_warn "launch-intent" "could not store Teamem activation for Space '${launch_space}'; run \`teamem init\` to repair the plugin install."
      return 1
    fi
  else
    if ! CLAUDE_SESSION_ID="$SESSION_ID" "${PLUGIN_ROOT}/bin/teamem-flag" enable >/dev/null 2>&1; then
      _teamem_warn "launch-intent" "could not store Teamem activation; run \`teamem init\` to repair the plugin install."
      return 1
    fi
  fi
}

BRIDGE_JS=$(teamem_bridge_js)
_teamem_activate_from_launch_intent || exit 0
teamem_is_active || exit 0

[ -f "$BRIDGE_JS" ] || exit 0
STARTER_TEMPLATE="${PLUGIN_ROOT}/templates/TEAMEM.starter.md"
SPACE_RULES_HELPER="${PLUGIN_ROOT}/scripts/space-rules-file.js"
STATUSLINE_CACHE_HELPER="${PLUGIN_ROOT}/scripts/statusline-cache-writer.js"
SESSION_SYNC_RESULT=""
SESSION_SYNC_SPACE=""

_inject_briefing_prompt() {
  case "${SESSION_SOURCE:-startup}" in
    startup|resume|"")
      local briefing_payload space
      if space=$(_teamem_resolve_space 2>/dev/null) && [ -n "$space" ]; then
        briefing_payload=$(printf '%s' "$space" | bun -e '
const space = await Bun.stdin.text();
process.stdout.write(JSON.stringify({ token_budget: 2000, space }));
' 2>/dev/null || printf '{"token_budget":2000}')
      else
        briefing_payload='{"token_budget":2000}'
      fi
      printf 'teamem: Teamem is active at session startup/resume. The first Teamem step for this session is one mcp__teamem__get_briefing call with %s; later edit coordination uses Teamem claim/conflict tools, so full briefing is not repeated before every edit.\n' "$briefing_payload"
      ;;
  esac
}

_fetch_session_sync() {
  [ -n "$SESSION_SYNC_RESULT" ] && return 0
  local space
  space=$(_teamem_resolve_space 2>/dev/null) || space=""
  SESSION_SYNC_SPACE="$space"
  if [ -n "$space" ]; then
    SESSION_SYNC_RESULT=$(bun run "$BRIDGE_JS" call teamem.session_sync \
      --space "$space" --json '{}' 2>/dev/null) || SESSION_SYNC_RESULT=""
  else
    SESSION_SYNC_RESULT=$(bun run "$BRIDGE_JS" call teamem.session_sync \
      --json '{}' 2>/dev/null) || SESSION_SYNC_RESULT=""
  fi
}

_write_statusline_display_cache() {
  [ -f "$STATUSLINE_CACHE_HELPER" ] || return 0
  _fetch_session_sync
  [ -n "$SESSION_SYNC_RESULT" ] || return 0
  printf '%s' "$SESSION_SYNC_RESULT" | bun "$STATUSLINE_CACHE_HELPER" \
    "$TEAMEM_DATA" "$PROJECT_KEY" "$SESSION_ID" "$PWD" "$SESSION_SYNC_SPACE" \
    2>/dev/null || true
}

_sync_space_rules() {
  [ -f "$SPACE_RULES_HELPER" ] || return 0
  [ -f "$STARTER_TEMPLATE" ] || return 0

  _fetch_session_sync
  local result
  result="$SESSION_SYNC_RESULT"
  [ -z "$result" ] && return 0

  local repo_root
  repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
  printf '%s' "$result" | bun "$SPACE_RULES_HELPER" session-sync "$repo_root" "$STARTER_TEMPLATE" || true
}

_surface_decision_replays() {
  _fetch_session_sync
  local result
  result="$SESSION_SYNC_RESULT"
  [ -z "$result" ] && return 0

  printf '%s' "$result" | bun -e '
const raw = await Bun.stdin.text();
try {
  const r = JSON.parse(raw);
  if (!r.ok || !Array.isArray(r.data?.decisions)) process.exit(0);
  for (const d of r.data.decisions) {
    const p = d.payload || {};
    process.stderr.write(
      `teamem: [decision] ${d.event_type} ${p.decision_id ?? "unknown"} — ${p.title ?? ""}\n`
    );
    if (typeof p.summary === "string" && p.summary.length > 0) {
      process.stderr.write(`teamem:   summary: ${p.summary}\n`);
    }
    if (typeof p.body === "string" && p.body.length > 0) {
      process.stderr.write(`teamem:   body: ${p.body}\n`);
    }
  }
} catch { process.exit(0); }
' || true
}

_surface_gotcha_notices() {
  _fetch_session_sync
  local result
  result="$SESSION_SYNC_RESULT"
  [ -z "$result" ] && return 0

  printf '%s' "$result" | bun -e '
const raw = await Bun.stdin.text();
try {
  const r = JSON.parse(raw);
  if (!r.ok || !Array.isArray(r.data?.gotcha_notices)) process.exit(0);
  for (const n of r.data.gotcha_notices) {
    const p = n.payload || {};
    const severity = typeof p.severity === "string" ? p.severity : "info";
    const relevance = typeof p.relevance === "string" ? p.relevance : "unknown";
    process.stderr.write(
      `teamem: [gotcha:${severity}] ${p.finding_id ?? "unknown"} — ${p.summary ?? ""}\n`
    );
    process.stderr.write(
      `teamem:   relevance: ${relevance}; fetch detail with teamem.get_finding and acknowledge with teamem.acknowledge_finding.\n`
    );
  }
} catch { process.exit(0); }
' || true
}

_fetch_notifications() {
  local space
  space=$(_teamem_resolve_space 2>/dev/null) || space=""

  local result
  if [ -n "$space" ]; then
    result=$(bun run "$BRIDGE_JS" call teamem.fetch_unread_notifications \
      --space "$space" --json '{}' 2>/dev/null) || result=""
  else
    result=$(bun run "$BRIDGE_JS" call teamem.fetch_unread_notifications \
      --json '{}' 2>/dev/null) || result=""
  fi

  [ -z "$result" ] && return 0

  # Parse and surface each notification as a warn line.
  printf '%s' "$result" | bun -e '
const raw = await Bun.stdin.text();
try {
  const r = JSON.parse(raw);
  if (!r.ok || !Array.isArray(r.data?.notifications)) process.exit(0);
  for (const n of r.data.notifications) {
    if (n.event_type === "claim_force_released") {
      const p = n.payload || {};
      process.stderr.write(
        `teamem: [force-release] ${p.path ?? "unknown"} (branch=${p.branch ?? "?"}) ` +
        `was force-released by ${p.released_by ?? "unknown"} at ${p.released_at ?? n.created_at}. ` +
        `Review their edits before resuming. Use /teamem-discuss to coordinate.\n`
      );
    } else {
      process.stderr.write(
        `teamem: [notification] ${n.event_type} — ${JSON.stringify(n.payload)}\n`
      );
    }
  }
} catch { process.exit(0); }
' || true
}

_inject_briefing_prompt
_write_statusline_display_cache
_sync_space_rules
_surface_decision_replays
_surface_gotcha_notices
_fetch_notifications

exit 0
