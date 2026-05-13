#!/usr/bin/env bash
# teamem — Claude Code SessionStart hook
# Always exits 0 (advisory only).

set -euo pipefail

TEAMEM_SERVER_URL="${TEAMEM_SERVER_URL:-http://localhost:3000}"
TEAMEM_BEARER_TOKEN="${TEAMEM_BEARER_TOKEN:-}"
TEAMEM_PRINCIPAL="${TEAMEM_PRINCIPAL:-}"
TEAMEM_ACTOR="${TEAMEM_ACTOR:-${TEAMEM_PRINCIPAL}/claude}"
TEAMEM_DELEGATION="${TEAMEM_DELEGATION:-${TEAMEM_PRINCIPAL}->claude}"
TEAMEM_REPO_ID="${TEAMEM_REPO_ID:-${CLAUDE_PROJECT_DIR:-$(pwd)}}"
LOG_DIR="${HOME}/.cache/teamem"
LOG_FILE="${LOG_DIR}/hook-errors.log"

_log_error() {
  local tool="$1" error="$2" snippet="$3"
  # JSON-safe: escape backslashes, then quotes (AC11)
  snippet="${snippet//\\/\\\\}"
  snippet="${snippet//\"/\\\"}"
  mkdir -p "$LOG_DIR"
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "unknown")
  printf '{"ts":"%s","tool":"%s","error":"%s","payload_snippet":"%s"}\n' \
    "$ts" "$tool" "$error" "$snippet" >> "$LOG_FILE"
}

_call_tool() {
  local tool="$1" body="$2"
  local response http_code
  if ! command -v curl >/dev/null 2>&1; then
    _log_error "$tool" "curl_not_found" ""
    return 1
  fi
  response=$(curl -s -w "\n%{http_code}" \
    -X POST "${TEAMEM_SERVER_URL}/tools/${tool}" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TEAMEM_BEARER_TOKEN}" \
    --max-time 5 \
    -d "$body" 2>/dev/null) || {
    _log_error "$tool" "network_error" "${body:0:80}"
    return 1
  }
  http_code=$(printf '%s' "$response" | tail -1)
  local resp_body
  resp_body=$(printf '%s' "$response" | head -n -1)
  if [ "$http_code" -lt 200 ] || [ "$http_code" -ge 300 ]; then
    _log_error "$tool" "http_${http_code}" "${body:0:80}"
    return 1
  fi
  printf '%s' "$resp_body"
  return 0
}

# Publish session_start event
SESSION_ID="${CLAUDE_SESSION_ID:-unknown}"
BODY=$(printf '{"repo_id":"%s","principal":"%s","actor":"%s","delegation":"%s","event_type":"task_started","scope":{},"payload":{"task_id":"session-%s"}}' \
  "$TEAMEM_REPO_ID" "$TEAMEM_PRINCIPAL" "$TEAMEM_ACTOR" "$TEAMEM_DELEGATION" "$SESSION_ID")

_call_tool "teamem.publish_event" "$BODY" >/dev/null 2>&1 || true

exit 0
