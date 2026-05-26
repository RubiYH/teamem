#!/usr/bin/env bash
# Plugin PreToolUse gate. Decides whether an Edit/Write/MultiEdit/NotebookEdit/
# apply_patch tool call should proceed based on a claim_scope call to the
# teamem bridge. Always exits 0 when teamem is inactive.
#
# Self-contained: invokes the bundled bridge at ${CLAUDE_PLUGIN_ROOT}/lib/bridge.js.

[ "${TEAMEM_HOOK_DISABLE:-}" = "1" ] && exit 0

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
# shellcheck source=./_common.sh
. "${PLUGIN_ROOT}/scripts/_common.sh"

# Step 0: bun availability check.
if ! command -v bun >/dev/null 2>&1; then
  _LOG_DIR="${HOME}/.cache/teamem"
  mkdir -p "$_LOG_DIR" 2>/dev/null || true
  _ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo unknown)
  printf '{"ts":"%s","tool":"unknown","error":"bun_not_found","path":""}\n' "$_ts" >> "${_LOG_DIR}/hook-errors.log" 2>/dev/null || true
  exit 0
fi

# Step 1: read stdin and parse via bun -e (NOT regex). Each field is emitted
# on its own line, base64-encoded so newlines/tabs in the patch body cannot
# corrupt the framing (bash 3.2 collapses consecutive tab separators in IFS).
INPUT=$(cat)
PARSE_RESULT=$(printf '%s' "$INPUT" | bun -e '
const i = JSON.parse(await Bun.stdin.text());
const enc = (s) => Buffer.from(String(s), "utf8").toString("base64");
const fields = [
  i.tool_name || "",
  i.tool_input?.file_path || "",
  i.tool_input?.notebook_path || "",
  i.cwd || "",
  i.tool_input?.command || "",
  i.session_id || ""
];
process.stdout.write(fields.map(enc).join("\n"));
' 2>/dev/null) || PARSE_RESULT=""

_b64dec() { printf '%s' "${1:-}" | base64 -d 2>/dev/null || printf ''; }

{
  IFS= read -r _F1 || _F1=""
  IFS= read -r _F2 || _F2=""
  IFS= read -r _F3 || _F3=""
  IFS= read -r _F4 || _F4=""
  IFS= read -r _F5 || _F5=""
  IFS= read -r _F6 || _F6=""
} <<< "$PARSE_RESULT"

TOOL_NAME=$(_b64dec "$_F1")
FILE_PATH=$(_b64dec "$_F2")
NOTEBOOK_PATH=$(_b64dec "$_F3")
CWD_FROM_JSON=$(_b64dec "$_F4")
APPLY_PATCH_CMD=$(_b64dec "$_F5")
SESSION_ID=$(_b64dec "$_F6")

# Step 2: tool allowlist BEFORE `set -e`.
case "$TOOL_NAME" in
  Edit|Write|MultiEdit|NotebookEdit|apply_patch) ;;
  *) exit 0 ;;
esac

# Step 3: now safe to enable strict mode.
set -euo pipefail

# Step 3b: respect launcher/SessionStart activation and project auto-on. The
# plugin scripts gate on session state files written by teamem-flag; if neither
# is present, exit 0.
teamem_resolve_session_dir "${SESSION_ID:-default}"
if ! teamem_is_active; then
  _LOG_DIR="${HOME}/.cache/teamem"
  mkdir -p "$_LOG_DIR" 2>/dev/null || true
  _ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo unknown)
  printf '{"ts":"%s","event":"hook_fired","tool":"%s","path":"%s","decision":"skip_inactive","session":"%s"}\n' \
    "$_ts" "$TOOL_NAME" "$FILE_PATH" "${SESSION_ID:-default}" >> "${_LOG_DIR}/hook-trace.log" 2>/dev/null || true
  exit 0
fi

START_TIME=$(date +%s 2>/dev/null || echo 0)
LOG_DIR="${HOME}/.cache/teamem"
LOG_FILE="${LOG_DIR}/hook-errors.log"
TRACE_FILE="${LOG_DIR}/hook-trace.log"
SPACE_ID="${TEAMEM_SPACE:-default}"

mkdir -p "$LOG_DIR" 2>/dev/null || true

# Determine cache file path: session-scoped when SESSION_ID is present,
# legacy per-space otherwise.
if [ -n "$SESSION_ID" ]; then
  SESSIONS_DIR="${LOG_DIR}/sessions"
  mkdir -p "$SESSIONS_DIR" 2>/dev/null || true
  CACHE_FILE="${SESSIONS_DIR}/${SESSION_ID}.claims.json"
else
  CACHE_FILE="${LOG_DIR}/active-claim-${SPACE_ID}.json"
  _ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo unknown)
  printf '{"ts":"%s","error":"session_id_missing","tool":"%s"}\n' "$_ts" "$TOOL_NAME" >> "$LOG_FILE" 2>/dev/null || true
fi

# Log rotation: truncate to last 4000 lines when file exceeds 5000 lines.
_rotate_log() {
  local file="$1"
  [ -f "$file" ] || return 0
  local lcount
  lcount=$(wc -l < "$file" 2>/dev/null || echo 0)
  if [ "$lcount" -gt 5000 ]; then
    local tmp="${file}.rot.$$"
    tail -n 4000 "$file" > "$tmp" 2>/dev/null && mv "$tmp" "$file" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
  fi
}

_log() {
  local err="$1"
  _rotate_log "$LOG_FILE"
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo unknown)
  printf '{"ts":"%s","tool":"%s","error":"%s","path":"%s"}\n' \
    "$ts" "$TOOL_NAME" "$err" "${PATHS[0]:-}" >> "$LOG_FILE" 2>/dev/null || true
}

_emit_trace() {
  local decision="$1"
  _rotate_log "$TRACE_FILE"
  local now elapsed_ms end
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo unknown)
  end=$(date +%s 2>/dev/null || echo 0)
  elapsed_ms=$(( (end - START_TIME) * 1000 ))
  printf '{"ts":"%s","event":"hook_fired","tool":"%s","path":"%s","decision":"%s","duration_ms":%d}\n' \
    "$now" "$TOOL_NAME" "${PATHS[0]:-}" "$decision" "$elapsed_ms" >> "$TRACE_FILE" 2>/dev/null || true
}

_trace_json_string() {
  printf '%s' "${1:-}" | bun -e '
    const s = await Bun.stdin.text();
    process.stdout.write(JSON.stringify(s));
  ' 2>/dev/null || printf '""'
}

_emit_coord_trace() {
  local mode="$1"
  local my_pref="$2"
  local their_pref="$3"
  local briefing="$4"
  local req_action="${5:-}"
  local req_error="${6:-}"
  local req_id="${7:-}"
  local now
  _rotate_log "$TRACE_FILE"
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo unknown)
  printf '{"ts":"%s","event":"coord_resolved","tool":"%s","path":"%s","mode":%s,"requester_pref":%s,"incumbent_pref":%s,"briefing":%s,"request_action":%s,"request_error":%s,"req_id":%s}\n' \
    "$now" \
    "$TOOL_NAME" \
    "${PATHS[0]:-}" \
    "$(_trace_json_string "$mode")" \
    "$(_trace_json_string "$my_pref")" \
    "$(_trace_json_string "$their_pref")" \
    "$(_trace_json_string "$briefing")" \
    "$(_trace_json_string "$req_action")" \
    "$(_trace_json_string "$req_error")" \
    "$(_trace_json_string "$req_id")" >> "$TRACE_FILE" 2>/dev/null || true
}

# flock + mkdir-mutex fallback for cache reads/writes (bash 3.2 / macOS compatible).
_cache_lock() {
  local lockdir="$1"
  local deadline=$(( $(date +%s 2>/dev/null || echo 0) + 1 ))
  while true; do
    if mkdir "$lockdir" 2>/dev/null; then
      return 0
    fi
    local now
    now=$(date +%s 2>/dev/null || echo 0)
    if [ "$now" -ge "$deadline" ]; then
      return 1
    fi
    sleep 0.05 2>/dev/null || true
  done
}

_cache_unlock() {
  local lockdir="$1"
  rmdir "$lockdir" 2>/dev/null || true
}

# Resolve the bundled bridge.
BRIDGE_JS=$(teamem_bridge_js)
if [ ! -f "$BRIDGE_JS" ]; then
  _ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo unknown)
  printf '{"ts":"%s","event":"bridge_bundle_missing","path":"%s"}\n' \
    "$_ts" "$BRIDGE_JS" >> "$LOG_FILE" 2>/dev/null || true
  exit 0
fi

# Invoke the bundled bridge in argv mode. Codex F14: prepend --space when
# the session pin or manifest default resolves so multi-space users hit
# the right space. Single-space users (no pin, no manifest default) keep
# pre-#21 behavior — the bridge falls back to credentials.default_space_id.
call_bridge_tool() {
  local tool_name="$1"
  local json_payload="$2"
  local space
  if space=$(_teamem_resolve_space); then
    bun run "$BRIDGE_JS" call "$tool_name" --space "$space" --json "$json_payload" 2>/dev/null
  else
    bun run "$BRIDGE_JS" call "$tool_name" --json "$json_payload" 2>/dev/null
  fi
}

# PATHS must exist before _log/_emit_trace fires (they read PATHS[0]).
PATHS=()

# Path normalization. Priority: CLAUDE_PROJECT_DIR > CWD_FROM_JSON > realpath $(pwd).
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-${CWD_FROM_JSON:-$(realpath "$(pwd)" 2>/dev/null || pwd)}}"
PROJECT_DIR=$(realpath "$PROJECT_DIR" 2>/dev/null || echo "$PROJECT_DIR")

# Dispatch by tool to populate PATHS.
case "$TOOL_NAME" in
  Edit|Write|MultiEdit)
    [ -n "$FILE_PATH" ] && PATHS=("$FILE_PATH")
    ;;
  NotebookEdit)
    [ -n "$NOTEBOOK_PATH" ] && PATHS=("$NOTEBOOK_PATH")
    ;;
  apply_patch)
    # Use here-string instead of `< <(...)` process substitution — POSIX sh
    # rejects the latter, and some hook spawners may parse the script under sh.
    _APPLY_PATHS=$(printf '%s' "$APPLY_PATCH_CMD" | grep -oE '\*\*\* (Update|Add|Delete) File: [^[:cntrl:]]+' | sed -E 's/.*File: //')
    while IFS= read -r line; do
      [ -n "$line" ] && PATHS+=("$line")
    done <<< "$_APPLY_PATHS"
    ;;
esac

# Defensive: if PATHS is empty, exit silently (allow).
if [ "${#PATHS[@]}" -eq 0 ]; then
  exit 0
fi

# Normalize each path to repo-relative when possible.
REL_PATHS=()
for P in "${PATHS[@]}"; do
  ABS=$(realpath "$P" 2>/dev/null || echo "$P")
  case "$ABS" in
    "$PROJECT_DIR"/*) REL_PATHS+=("${ABS#"$PROJECT_DIR"/}") ;;
    *)                REL_PATHS+=("$ABS") ;;
  esac
done

PATHS=("${REL_PATHS[@]}")

PATHS_JSON=$(printf '%s\n' "${PATHS[@]}" | bun -e '
const ps = (await Bun.stdin.text()).split("\n").filter(Boolean);
process.stdout.write(JSON.stringify(ps));
' 2>/dev/null) || PATHS_JSON="[]"

# Codex F17 — resolve the *current* space at gate time and persist it with
# diagnostic cache entries. Pre-#22 cache lookups were keyed only on
# `(session_id, path)`, so after a session space pin changed to space-B the
# gate could treat a claim originally minted in space-A as safe in space-B.
# Runtime no longer reads the cache for allow decisions, but writes keep the
# metadata accurate.
RESOLVED_SPACE=$(_teamem_resolve_space || true)
RESOLVED_SPACE="${RESOLVED_SPACE:-}"

# Do not short-circuit on the local claim cache. A post-commit release or peer
# force-release can make a local cache entry stale while a teammate now owns
# the path. The cache remains write-only diagnostics; correctness requires a
# server revalidation on every edit.

# Step 4 (slice #29): Git branch/repo probing for branch-aware claim scope.
GIT_CWD=""
if [ "${#PATHS[@]}" -gt 0 ] && [ -n "${PATHS[0]:-}" ]; then
  _FIRST_PATH="${PATHS[0]}"
  case "$_FIRST_PATH" in
    /*) GIT_CWD=$(dirname "$_FIRST_PATH") ;;
    *)  GIT_CWD="${CWD_FROM_JSON:-$(pwd)}" ;;
  esac
fi
GIT_CWD="${GIT_CWD:-${CWD_FROM_JSON:-$(pwd)}}"
# Fall back to cwd when the file's parent dir doesn't exist yet (e.g. new file).
[ -d "$GIT_CWD" ] || GIT_CWD="${CWD_FROM_JSON:-$(pwd)}"

GIT_TOPLEVEL=$(git -C "$GIT_CWD" rev-parse --show-toplevel 2>/dev/null || echo "")
GIT_BRANCH=""
GIT_HEAD_SHA=""
REPO_ID=""

# Outside any git repo — Tier-S silent skip.
if [ -z "$GIT_TOPLEVEL" ]; then
  _emit_trace "skip_outside_repo"
  exit 0
fi

if [ -n "$GIT_TOPLEVEL" ]; then
  GIT_BRANCH=$(git -C "$GIT_TOPLEVEL" symbolic-ref --short HEAD 2>/dev/null || echo "")
  if [ -z "$GIT_BRANCH" ]; then
    # Detached HEAD (mid-rebase, mid-bisect) — Tier-W warn then skip.
    _teamem_warn "detached-head" "teamem: detached HEAD — coordination paused for this edit" || true
    _emit_trace "skip_detached_head"
    exit 0
  fi
  GIT_HEAD_SHA=$(git -C "$GIT_TOPLEVEL" rev-parse HEAD 2>/dev/null || echo "")
  GIT_REMOTE_URL=$(git -C "$GIT_TOPLEVEL" config --get remote.origin.url 2>/dev/null || echo "")
  if [ -z "$GIT_REMOTE_URL" ]; then
    REPO_ID="$GIT_TOPLEVEL"
  else
    REPO_ID=$(GIT_REMOTE_URL="$GIT_REMOTE_URL" bun -e '
// MUST stay in lockstep with src/domain/claim-identity-core.ts
// canonicalizeRepoId — server and client must agree on repo_id.
const url = process.env.GIT_REMOTE_URL || "";
let s = url.trim();
s = s.replace(/^(https?|ssh|git):\/\//, "");
s = s.replace(/^[^@/]+@/, "");
s = s.replace(/^([^/:]+):(?!\d+\/)/, "$1/");
s = s.replace(/\.git$/, "");
s = s.toLowerCase();
s = s.replace(/\/+$/, "");
process.stdout.write(s);
' 2>/dev/null || echo "$GIT_TOPLEVEL")
  fi

  # Write per-repo last-branch state file (consumed by post-checkout hook in slice #33).
  REPO_HASH=$(printf '%s' "$REPO_ID" | bun -e '
const {createHash} = require("crypto");
process.stdin.resume();
let d = "";
process.stdin.on("data", c => d += c);
process.stdin.on("end", () => process.stdout.write(createHash("sha1").update(d).digest("hex")));
' 2>/dev/null || echo "default")
  PLUGIN_DATA_DIR="${CLAUDE_PLUGIN_DATA:-${HOME}/.cache/teamem}"
  LAST_BRANCH_DIR="${PLUGIN_DATA_DIR}/last-branch"
  mkdir -p "$LAST_BRANCH_DIR" 2>/dev/null || true
  printf '%s' "$GIT_BRANCH" > "${LAST_BRANCH_DIR}/${REPO_HASH}" 2>/dev/null || true
fi

# Build claim_scope JSON.
CLAIM_JSON=$(bun -e '
const paths = JSON.parse(process.argv[1]);
const repoId = process.argv[2] || "";
const branch = process.argv[3] || "";
const headSha = process.argv[4] || "";
// PRD §150: on_commit claims have NULL expires_at; lease_seconds is a
// ttl-only field. The gate hook acquires in on_commit mode so it must
// not send lease_seconds — release is driven by the post-commit hook.
process.stdout.write(JSON.stringify({
  scope: { paths },
  intent: "agent edit",
  repo_id: repoId,
  branch: branch,
  current_head_sha: headSha,
  auto_release_mode: "on_commit"
}));
' "$PATHS_JSON" "$REPO_ID" "$GIT_BRANCH" "$GIT_HEAD_SHA" 2>/dev/null) || { _log "claim_json_build_failed"; _teamem_warn "claim-encode-failed" "bun could not serialize claim payload — allowing edit (fail-open)"; _emit_trace "fail-open"; exit 0; }

# Call bridge.
OUTPUT=$(call_bridge_tool teamem.claim_scope "$CLAIM_JSON" 2>/dev/null) || {
  _log "bridge_unreachable"
  _teamem_warn "bridge-unreachable" "bridge subprocess failed (rc=$?) — check server is running and credentials are valid (fail-open)"
  _emit_trace "fail-open"
  exit 0
}

# Branch on response.
DISPATCH=$(printf '%s' "$OUTPUT" | bun -e '
const enc = (s) => Buffer.from(String(s), "utf8").toString("base64");
const emit = (decision, reason, cid, exp) => {
  process.stdout.write([decision, reason, cid, exp].map(enc).join("\n"));
};
try {
  const r = JSON.parse(await Bun.stdin.text());
  if (r && r.ok === true) {
    const cid = r.data?.claim_id || r.claim_id || "";
    const exp = r.data?.expires_at || r.expires_at || "";
    emit("allow", "", cid, exp);
    process.exit(0);
  }
  if (r?.ok === false && r?.error === "network_error") {
    emit("bridge_unreachable", "", "", "");
    process.exit(0);
  }
  const code = r?.error?.code || (r?.ok === false ? "unknown" : "unknown");
  if (code === "scope_conflict") {
    const e = r.error || {};
    const principal = e.conflicting_principal || "another teammate";
    const colliding = JSON.stringify(e.colliding_paths || []);
    const cid = e.conflicting_claim_id || e.claim_id || "?";
    emit("deny", `${principal} holds ${colliding} (claim ${cid}). Halt and report.`, "", "");
    process.exit(0);
  }
  if (code === "claim_paused_by_peer") {
    const e = r.error || {};
    const holder = e.conflicting_principal || "another teammate";
    const colliding = JSON.stringify(e.colliding_paths || []);
    const cid = e.conflicting_claim_id || e.claim_id || "?";
    const pausedAt = e.paused_at || "unknown time";
    const pausedReason = e.paused_reason || "branch_switch";
    emit("deny", `${holder} has a paused claim on ${colliding} (claim ${cid}, paused ${pausedAt}, reason: ${pausedReason}). Coordinate with ${holder} or ask your agent to prepare a force-release if this claim is stale.`, "", "");
    process.exit(0);
  }
  if (code === "scope_conflict_self_widening") {
    const e = r.error || {};
    const existing = e.existing_claim_id || e.conflicting_claim_id || e.claim_id || "?";
    emit("deny_self", `You'\''re trying to widen your own claim. Release claim_id ${existing} via teamem.release_scope, then retry this Edit.`, "", "");
    process.exit(0);
  }
  if (code === "unauthorized" || code === "auth_required" || code === "401") {
    emit("ask", "Teamem auth not configured; allow this edit?", "", "");
    process.exit(0);
  }
  if (code === "idempotency_collision") {
    const e = r.error || {};
    const ikey = e.idempotency_key || "";
    emit("idempotency_collision", ikey, "", "");
    process.exit(0);
  }
  emit("fail-open", `unhandled:${code}`, "", "");
} catch (e) {
  emit("fail-open", `parse_error:${(e && e.message) || "unknown"}`, "", "");
}
' 2>/dev/null) || DISPATCH=""

{
  IFS= read -r _D1 || _D1=""
  IFS= read -r _D2 || _D2=""
  IFS= read -r _D3 || _D3=""
  IFS= read -r _D4 || _D4=""
} <<< "$DISPATCH"

DECISION=$(_b64dec "$_D1")
REASON=$(_b64dec "$_D2")
CLAIM_ID=$(_b64dec "$_D3")
EXPIRES_AT=$(_b64dec "$_D4")

[ -z "$DECISION" ] && DECISION="fail-open"

case "$DECISION" in
  allow)
    # PRD §150: on_commit claims have empty expires_at; cache them anyway
    # (they never auto-expire). The cache reader treats empty expires_at as
    # "never expires" so this entry stays hit until released or invalidated.
    if [ -n "$CLAIM_ID" ]; then
      _LOCK_DIR="${CACHE_FILE}.lockdir"
      if _cache_lock "$_LOCK_DIR"; then
        _EVICTED=$(bun -e '
try {
  const fs = require("fs");
  const path = require("path");
  const cacheFile = process.argv[1];
  const paths = JSON.parse(process.argv[2]);
  const claimId = process.argv[3];
  const expiresAt = process.argv[4];
  // Codex F17 — record the resolved space alongside each entry so a
  // subsequent session pin to another space invalidates the cache for the
  // new space. Empty string means "no resolution" (single-space install,
  // pre-#22 behavior).
  const space = process.argv[5] || "";
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, "utf-8")) || {}; } catch {}
  if (typeof cache !== "object" || cache === null || Array.isArray(cache)) cache = {};
  for (const p of paths) cache[p] = { claim_id: claimId, expires_at: expiresAt, space };
  const keys = Object.keys(cache);
  let evicted = 0;
  if (keys.length > 50) {
    // PRD §150: on_commit claims have NULL expires_at (no scheduled
    // expiry). Sort empty/null to Infinity so they prune LAST — the
    // active edit set stays sticky, ttl entries get evicted first.
    const sorted = keys.slice().sort((a, b) => {
      const ea = cache[a]?.expires_at;
      const eb = cache[b]?.expires_at;
      const ta = ea ? Date.parse(ea) || Infinity : Infinity;
      const tb = eb ? Date.parse(eb) || Infinity : Infinity;
      return ta - tb;
    });
    const toRemove = sorted.slice(0, keys.length - 50);
    for (const k of toRemove) delete cache[k];
    evicted = toRemove.length;
  }
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  process.stdout.write(String(evicted));
} catch { process.stdout.write("0"); }
' "$CACHE_FILE" "$PATHS_JSON" "$CLAIM_ID" "$EXPIRES_AT" "$RESOLVED_SPACE" 2>/dev/null) || _EVICTED="0"
        _cache_unlock "$_LOCK_DIR"
        if [ "${_EVICTED:-0}" -gt 0 ] 2>/dev/null; then
          _log "cache_evict_oldest"
        fi
      fi
    fi

    # Issue #15 — emit agent_focus_changed after a successful claim. The
    # server projection dedupes within a 60s window keyed on
    # (space_id, principal, scope_hash), so rapid same-scope re-claims
    # collapse and only distinct work areas show up in recent_progress.
    # Best-effort fire-and-forget; failures must not block the allow.
    FOCUS_JSON=$(bun -e '
      const paths = JSON.parse(process.argv[1]);
      process.stdout.write(JSON.stringify({
        scope: { paths },
        intent: "auto-claimed by gate-claim"
      }));
    ' "$PATHS_JSON" 2>/dev/null) || FOCUS_JSON=""
    if [ -n "$FOCUS_JSON" ]; then
      call_bridge_tool teamem.agent_focus_changed "$FOCUS_JSON" >/dev/null 2>&1 || true
    fi
    _emit_trace "allow"
    exit 0
    ;;
  deny)
    # Issue #10 — Mode 6.A. Before emitting the deny, attempt to resolve the
    # coordination mode. The active plugin path queues a pending_edit so the server emits
    # `conflict_resolved` to us when the incumbent releases. The deny still
    # fires either way; queueing is a best-effort side effect — failures here
    # must not block the deny.
    #
    # We pull the conflicting principal's coord_pref from
    # getBriefing.recent_joins[]. The caller's coord_pref is also in the
    # briefing (their own row). resolveCoordMode runs inline in bun.
    BLOCKING_CLAIM_ID=$(printf '%s' "$OUTPUT" | bun -e '
      try {
        const r = JSON.parse(await Bun.stdin.text());
        const e = r?.error || {};
        process.stdout.write(String(e.conflicting_claim_id || ""));
      } catch { process.stdout.write(""); }
    ' 2>/dev/null) || BLOCKING_CLAIM_ID=""
    CONFLICTING_PRINCIPAL=$(printf '%s' "$OUTPUT" | bun -e '
      try {
        const r = JSON.parse(await Bun.stdin.text());
        const e = r?.error || {};
        process.stdout.write(String(e.conflicting_principal || ""));
      } catch { process.stdout.write(""); }
    ' 2>/dev/null) || CONFLICTING_PRINCIPAL=""
    MY_PREF_FROM_CONFLICT=$(printf '%s' "$OUTPUT" | bun -e '
      try {
        const r = JSON.parse(await Bun.stdin.text());
        const v = String(r?.error?.requester_coord_pref || "");
        process.stdout.write(["auto-skip","auto-discuss"].includes(v) ? v : "");
      } catch { process.stdout.write(""); }
    ' 2>/dev/null) || MY_PREF_FROM_CONFLICT=""
    THEIR_PREF_FROM_CONFLICT=$(printf '%s' "$OUTPUT" | bun -e '
      try {
        const r = JSON.parse(await Bun.stdin.text());
        const v = String(r?.error?.incumbent_coord_pref || "");
        process.stdout.write(["auto-skip","auto-discuss"].includes(v) ? v : "");
      } catch { process.stdout.write(""); }
    ' 2>/dev/null) || THEIR_PREF_FROM_CONFLICT=""

    if [ -n "$BLOCKING_CLAIM_ID" ] && [ -n "$CONFLICTING_PRINCIPAL" ]; then
      # Codex F18 — resolve the caller's principal via the server-authoritative
      # `teamem.whoami` tool instead of `process.env.TEAMEM_MEMBER_NAME` (which
      # is unset in marketplace installs — the manifest only exports
      # `TEAMEM_SPACE`). Keep this lookup for stale/legacy `auto-discuss`
      # rows so the gate can degrade them intentionally.
      #
      # Cache the resolved principal in `${SESSION_DIR}/whoami` so we don't
      # round-trip the bridge on every PreToolUse gate. The file holds the
      # principal string; it's invalidated when launcher/SessionStart
      # activation pins a different space (teamem-flag rewrites
      # `${SESSION_DIR}/space` and SHOULD also delete `${SESSION_DIR}/whoami`,
      # but if it doesn't, the cache survives at most until session end).
      MY_NAME=""
      WHOAMI_CACHE="${SESSION_DIR:-}/whoami"
      WHOAMI_SPACE_CACHE="${SESSION_DIR:-}/whoami.space"
      if [ -n "${SESSION_DIR:-}" ] && [ -f "$WHOAMI_CACHE" ] && [ -f "$WHOAMI_SPACE_CACHE" ]; then
        _CACHED_SPACE=$(cat "$WHOAMI_SPACE_CACHE" 2>/dev/null || printf '')
        if [ "$_CACHED_SPACE" = "$RESOLVED_SPACE" ]; then
          MY_NAME=$(cat "$WHOAMI_CACHE" 2>/dev/null || printf '')
        fi
      fi
      if [ -z "$MY_NAME" ]; then
        WHOAMI_OUTPUT=$(call_bridge_tool teamem.whoami '{}' 2>/dev/null) || WHOAMI_OUTPUT=""
        if [ -n "$WHOAMI_OUTPUT" ]; then
          MY_NAME=$(printf '%s' "$WHOAMI_OUTPUT" | bun -e '
            try {
              const r = JSON.parse(await Bun.stdin.text());
              if (r && r.ok === true) {
                process.stdout.write(String(r?.data?.principal || ""));
              } else {
                process.stdout.write("");
              }
            } catch { process.stdout.write(""); }
          ' 2>/dev/null) || MY_NAME=""
          if [ -n "$MY_NAME" ] && [ -n "${SESSION_DIR:-}" ]; then
            printf '%s' "$MY_NAME" > "$WHOAMI_CACHE" 2>/dev/null || true
            printf '%s' "$RESOLVED_SPACE" > "$WHOAMI_SPACE_CACHE" 2>/dev/null || true
          fi
        fi
      fi

      BRIEFING_OUTPUT=$(call_bridge_tool teamem.get_briefing '{}' 2>/dev/null) || BRIEFING_OUTPUT=""
      BRIEFING_STATE="ok"
      [ -n "$BRIEFING_OUTPUT" ] || BRIEFING_STATE="empty_or_failed"
      RESOLVED_MODE=$(printf '%s' "$BRIEFING_OUTPUT" | bun -e '
          // resolveCoordMode mirrored inline so the bash hook stays
          // self-contained (no module import gymnastics in -e mode).
          function resolveCoordMode(latter, incumbent) {
            if (latter === "auto-discuss" && incumbent === "auto-discuss") return "auto-discuss";
            return "auto-skip";
          }
          try {
            const text = await Bun.stdin.text();
            const r = text.trim() ? JSON.parse(text) : {};
            const joins = r?.data?.recent_joins || r?.recent_joins || [];
            const conflicting = process.argv[1];
            // Codex F18 — `myName` comes from the whoami round-trip, NOT
            // from process.env.TEAMEM_MEMBER_NAME (which production never sets).
            const myName = process.argv[2] || "";
            const valid = new Set(["auto-skip", "auto-discuss"]);
            let myPref = valid.has(process.argv[3]) ? process.argv[3] : "auto-skip";
            let theirPref = valid.has(process.argv[4]) ? process.argv[4] : "auto-skip";
            for (const j of joins) {
              if (!process.argv[4] && j.member_name === conflicting && valid.has(j.coord_pref)) theirPref = j.coord_pref;
              if (!process.argv[3] && j.member_name === myName && valid.has(j.coord_pref)) myPref = j.coord_pref;
            }
            process.stdout.write(resolveCoordMode(myPref, theirPref));
          } catch { process.stdout.write("auto-skip"); }
        ' "$CONFLICTING_PRINCIPAL" "$MY_NAME" "$MY_PREF_FROM_CONFLICT" "$THEIR_PREF_FROM_CONFLICT" 2>/dev/null) || RESOLVED_MODE="auto-skip"

      if [ "$RESOLVED_MODE" = "auto-skip" ]; then
          _emit_coord_trace "$RESOLVED_MODE" "$MY_PREF_FROM_CONFLICT" "$THEIR_PREF_FROM_CONFLICT" "$BRIEFING_STATE" "" ""
          QUEUE_JSON=$(bun -e '
            const paths = JSON.parse(process.argv[1]);
            const cid = process.argv[2];
            process.stdout.write(JSON.stringify({
              blocking_claim_id: cid,
              paths,
              intent: "queued by gate-claim auto-skip"
            }));
          ' "$PATHS_JSON" "$BLOCKING_CLAIM_ID" 2>/dev/null) || QUEUE_JSON=""
          if [ -n "$QUEUE_JSON" ]; then
            call_bridge_tool teamem.queue_pending_edit "$QUEUE_JSON" >/dev/null 2>&1 || true
          fi
        elif [ "$RESOLVED_MODE" = "auto-discuss" ]; then
          # Watcher + negotiator subagents are postponed in the current
          # plugin build. Degrade legacy/stale auto-discuss prefs to the
          # queued auto-skip path rather than opening a dispute with no
          # active runtime to drive it.
          QUEUE_JSON=$(bun -e '
            const paths = JSON.parse(process.argv[1]);
            const cid = process.argv[2];
            process.stdout.write(JSON.stringify({
              blocking_claim_id: cid,
              paths,
              intent: "queued while auto-discuss automation is postponed"
            }));
          ' "$PATHS_JSON" "$BLOCKING_CLAIM_ID" 2>/dev/null) || QUEUE_JSON=""
          if [ -n "$QUEUE_JSON" ]; then
            call_bridge_tool teamem.queue_pending_edit "$QUEUE_JSON" >/dev/null 2>&1 || true
          fi
          REASON="${REASON} — auto-discuss automation is postponed in this plugin build, so Teamem queued your intent instead of opening a dispute."
      fi
    fi

    # CONTEXT.md "Pending edit (skip queue)" advisory: surface that the
    # edit was queued and later session sync or channel delivery can
    # surface the release when available.
    DENY_REASON_AUGMENTED=$(printf '%s' "$REASON" | bun -e '
      const base = await Bun.stdin.text();
      process.stdout.write(JSON.stringify(
        base + " — your intent was queued; you'\''ll be alerted when the incumbent releases. Switch tasks for now."
      ));
    ' 2>/dev/null || printf '"scope conflict"')

    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":%s}}\n' \
      "$DENY_REASON_AUGMENTED"
    _emit_trace "deny"
    exit 0
    ;;
  deny_self)
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":%s}}\n' \
      "$(printf '%s' "$REASON" | bun -e 'process.stdout.write(JSON.stringify(await Bun.stdin.text()))' 2>/dev/null || printf '"self-widening"')"
    _emit_trace "deny_self"
    exit 0
    ;;
  ask)
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":%s}}\n' \
      "$(printf '%s' "$REASON" | bun -e 'process.stdout.write(JSON.stringify(await Bun.stdin.text()))' 2>/dev/null || printf '"auth"')"
    _emit_trace "ask"
    exit 0
    ;;
  bridge_unreachable)
    _log "bridge_unreachable"
    _teamem_warn "bridge-unreachable" "bridge returned network_error — check server is running (fail-open)"
    _emit_trace "fail-open"
    exit 0
    ;;
  idempotency_collision)
    _ikey="$REASON"
    _ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo unknown)
    _rotate_log "$LOG_FILE"
    printf '{"ts":"%s","event":"idempotency_collision","tool":"%s","path":"%s","idempotency_key":"%s","decision":"fail-open"}\n' \
      "$_ts" "$TOOL_NAME" "${PATHS[0]:-}" "$_ikey" >> "$LOG_FILE" 2>/dev/null || true
    _rotate_log "$TRACE_FILE"
    _end=$(date +%s 2>/dev/null || echo 0)
    _elapsed_ms=$(( (_end - START_TIME) * 1000 ))
    printf '{"ts":"%s","event":"hook_fired","tool":"%s","path":"%s","decision":"fail-open","reason":"idempotency_collision:%s","duration_ms":%d}\n' \
      "$_ts" "$TOOL_NAME" "${PATHS[0]:-}" "$_ikey" "$_elapsed_ms" >> "$TRACE_FILE" 2>/dev/null || true
    exit 0
    ;;
  *)
    _log "unhandled_response:${REASON}"
    _teamem_warn "unhandled-response" "bridge returned an unexpected shape (${REASON:-unknown}) — see ~/.cache/teamem/hook-errors.log (fail-open)"
    _emit_trace "fail-open"
    exit 0
    ;;
esac
