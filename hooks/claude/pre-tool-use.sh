#!/usr/bin/env bash
# teamem — Claude Code PreToolUse hook
# Detects conflicts before tool execution. Advisory only — always exits 0.

set -euo pipefail

TEAMEM_SERVER_URL="${TEAMEM_SERVER_URL:-http://localhost:3000}"
TEAMEM_BEARER_TOKEN="${TEAMEM_BEARER_TOKEN:-}"
TEAMEM_PRINCIPAL="${TEAMEM_PRINCIPAL:-}"
TEAMEM_ACTOR="${TEAMEM_ACTOR:-${TEAMEM_PRINCIPAL}/claude}"
TEAMEM_REPO_ID="${TEAMEM_REPO_ID:-${CLAUDE_PROJECT_DIR:-$(pwd)}}"
TEAMEM_PATHS="${TEAMEM_PATHS:-}"  # space-separated paths being edited
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

# Build paths JSON array from TEAMEM_PATHS (space-separated)
PATHS_JSON="[]"
if [ -n "$TEAMEM_PATHS" ]; then
  PATHS_JSON="["
  first=1
  for p in $TEAMEM_PATHS; do
    [ $first -eq 0 ] && PATHS_JSON="${PATHS_JSON},"
    PATHS_JSON="${PATHS_JSON}\"${p}\""
    first=0
  done
  PATHS_JSON="${PATHS_JSON}]"
fi

BODY=$(printf '{"repo_id":"%s","principal":"%s","scope":{"paths":%s}}' \
  "$TEAMEM_REPO_ID" "$TEAMEM_PRINCIPAL" "$PATHS_JSON")

RESULT=$(_call_tool "teamem.detect_conflicts" "$BODY" 2>/dev/null) || {
  exit 0
}

# Parse risk_score from result (simple grep — avoids jq dependency)
RISK_SCORE=$(printf '%s' "$RESULT" | grep -o '"risk_score":[0-9]*' | grep -o '[0-9]*' || echo "0")
RISK_SCORE="${RISK_SCORE:-0}"

if [ "$RISK_SCORE" -ge 40 ] 2>/dev/null; then
  printf '\n[teamem WARNING] Conflict detected (risk_score=%s). Review active team claims before proceeding.\nRun: bun run bridge call detect_conflicts --repo-id %s\n\n' \
    "$RISK_SCORE" "$TEAMEM_REPO_ID"
fi

exit 0
