#!/usr/bin/env bash
# Shared helpers for the teamem plugin's hook + command scripts.
# Source this file. Sets: SESSION_ID, SESSION_DIR, ACTIVE_FLAG, DISABLED_FLAG, PERSIST_FLAG.
# Provides: teamem_is_active, teamem_session_id_from_stdin_json.

TEAMEM_DEFAULT_SPACE="${CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE:-}"

# Claude normally sets CLAUDE_PLUGIN_DATA to this plugin's data directory, but
# sessions with multiple local plugins can expose another plugin's data dir to
# slash-command shells. Installed Teamem can recover its own data slug from the
# cache layout: ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>.
_teamem_data_from_installed_cache() {
  local root="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}"
  [ -n "$root" ] || return 1
  root=$(cd "$root" 2>/dev/null && pwd) || return 1

  local plugin_dir marketplace_dir cache_dir plugin_name marketplace
  plugin_dir=$(dirname "$root")
  marketplace_dir=$(dirname "$plugin_dir")
  cache_dir=$(dirname "$marketplace_dir")
  [ "$(basename "$cache_dir")" = "cache" ] || return 1

  plugin_name=$(basename "$plugin_dir")
  marketplace=$(basename "$marketplace_dir")
  [ -n "$plugin_name" ] && [ -n "$marketplace" ] || return 1
  printf '%s/.claude/plugins/data/%s-%s' "${HOME}" "$plugin_name" "$marketplace"
}

_teamem_data_from_source_plugin() {
  local root="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}"
  [ -n "$root" ] || return 1
  root=$(cd "$root" 2>/dev/null && pwd) || return 1
  [ -f "${root}/.claude-plugin/plugin.json" ] || return 1
  grep -Eq '"name"[[:space:]]*:[[:space:]]*"teamem2?"' "${root}/.claude-plugin/plugin.json" 2>/dev/null || return 1

  local marketplace_json marketplace
  marketplace_json="$(dirname "$root")/.claude-plugin/marketplace.json"
  if [ -f "$marketplace_json" ]; then
    marketplace=$(bun -e '
try {
  const fs = require("fs");
  const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(typeof data.name === "string" ? data.name : "");
} catch {}
' "$marketplace_json" 2>/dev/null || printf '')
    if [ -n "$marketplace" ]; then
      printf '%s/.claude/plugins/data/teamem-%s' "${HOME}" "$marketplace"
      return 0
    fi
  fi

  printf '%s/.claude/plugins/data/teamem-inline' "${HOME}"
}

_teamem_plugin_data_env_looks_teamem() {
  [ -n "${CLAUDE_PLUGIN_DATA:-}" ] || return 1
  case "$(basename "${CLAUDE_PLUGIN_DATA}")" in
    teamem|teamem-*|teamem2|teamem2-*) return 0 ;;
  esac
  return 1
}

_teamem_resolve_data_dir() {
  local derived=""
  if derived=$(_teamem_data_from_installed_cache 2>/dev/null); then
    if _teamem_plugin_data_env_looks_teamem; then
      printf '%s' "${CLAUDE_PLUGIN_DATA}"
      return 0
    fi
    printf '%s' "$derived"
    return 0
  fi

  if derived=$(_teamem_data_from_source_plugin 2>/dev/null); then
    if _teamem_plugin_data_env_looks_teamem; then
      printf '%s' "${CLAUDE_PLUGIN_DATA}"
      return 0
    fi
    printf '%s' "$derived"
    return 0
  fi

  if [ -n "${CLAUDE_PLUGIN_DATA:-}" ]; then
    printf '%s' "${CLAUDE_PLUGIN_DATA}"
    return 0
  fi

  printf '%s/.claude/plugins/data/teamem' "${HOME}"
}

TEAMEM_DATA="$(_teamem_resolve_data_dir)"

# Derive a project identity that is STABLE across multiple local clones of the
# same git repo. Order:
#   1. git remote.origin.url — same for every clone of the same repo, so two
#      developers checking out the same project on the same machine share one
#      auto-on flag and one set of session claims.
#   2. git toplevel — fallback when there's a git repo but no remote (local
#      init, fork without origin set).
#   3. realpath PWD — fallback when not in a git repo at all.
#   4. PWD — last-resort.
# Override with TEAMEM_PROJECT_ID env var for ad-hoc grouping (e.g. monorepo
# subdirs that should be treated as separate projects).
_teamem_project_root() {
  if [ -n "${TEAMEM_PROJECT_ID:-}" ]; then
    printf '%s' "$TEAMEM_PROJECT_ID"
    return 0
  fi
  local url
  url=$(git config --get remote.origin.url 2>/dev/null) && [ -n "$url" ] && { printf '%s' "$url"; return 0; }
  local root
  root=$(git rev-parse --show-toplevel 2>/dev/null) && [ -n "$root" ] && { printf '%s' "$root"; return 0; }
  root=$(realpath "$PWD" 2>/dev/null) && [ -n "$root" ] && { printf '%s' "$root"; return 0; }
  pwd
}
PROJECT_ROOT=$(_teamem_project_root)

# Codex F12: SHA-1 helper that falls through portable hashers.
# `shasum` is macOS-default; `sha1sum` is Linux-default. Without this
# fallback `_common.sh` was sourcing under `set -euo pipefail` and exiting
# on Linux installs because `shasum` was not on PATH — every slash command
# (including `/teamem-on`) died before the active flag could be written.
_teamem_sha1() {
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$1" | shasum -a 1 | awk '{print $1}'
  elif command -v sha1sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha1sum | awk '{print $1}'
  elif command -v bun >/dev/null 2>&1; then
    bun -e "import {createHash} from 'node:crypto'; process.stdout.write(createHash('sha1').update(process.argv[1]).digest('hex'))" "$1"
  else
    printf 'teamem: no sha1 helper available (need shasum, sha1sum, or bun)\n' >&2
    return 1
  fi
}
PROJECT_KEY=$(_teamem_sha1 "$PROJECT_ROOT")
PERSIST_FLAG="${TEAMEM_DATA}/projects/${PROJECT_KEY}/auto-on"

# One-time migration: move legacy global auto-on into the project-keyed path.
if [ -f "${TEAMEM_DATA}/auto-on" ] && [ ! -f "${PERSIST_FLAG}" ]; then
  mkdir -p "${TEAMEM_DATA}/projects/${PROJECT_KEY}" 2>/dev/null || true
  mv "${TEAMEM_DATA}/auto-on" "${PERSIST_FLAG}" 2>/dev/null || true
fi

# Resolve session id. When called from a hook, hook input JSON on stdin has
# a session_id field. When called from a slash command, $CLAUDE_SESSION_ID
# may be set. Fallback: "default".
teamem_session_id_from_stdin_json() {
  local input="$1"
  [ -z "$input" ] && return 0
  if command -v bun >/dev/null 2>&1; then
    printf '%s' "$input" | bun -e '
try {
  const i = JSON.parse(await Bun.stdin.text());
  process.stdout.write(i.session_id || i.sessionId || "");
} catch { process.stdout.write(""); }
' 2>/dev/null
  fi
}

teamem_resolve_session_dir() {
  local sid="${CLAUDE_SESSION_ID:-${1:-default}}"
  SESSION_ID="$sid"
  SESSION_DIR="${TEAMEM_DATA}/sessions/${SESSION_ID}"
  ACTIVE_FLAG="${SESSION_DIR}/active"
  DISABLED_FLAG="${SESSION_DIR}/disabled"
  mkdir -p "${SESSION_DIR}" 2>/dev/null || true
}

# Truthy when:
#   1. ${SESSION_DIR}/active exists, OR
#   2. ${PERSIST_FLAG} (project-wide auto-on) exists
# unless ${SESSION_DIR}/disabled exists as a current-session override.
# Both are simple file-presence checks; no parsing.
teamem_is_active() {
  [ -f "${DISABLED_FLAG:-}" ] && return 1
  [ -f "${ACTIVE_FLAG:-}" ] && return 0
  [ -f "${PERSIST_FLAG}" ] && return 0
  return 1
}

teamem_log() {
  local msg="$1"
  local logf="${TEAMEM_DATA}/plugin.log"
  mkdir -p "${TEAMEM_DATA}" 2>/dev/null || true
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo unknown)
  printf '{"ts":"%s","msg":"%s","session":"%s"}\n' \
    "$ts" "$msg" "${SESSION_ID:-?}" >> "${logf}" 2>/dev/null || true
}

# Tier-W warn helper. Surfaces a one-line message on the hook's stderr so
# Claude Code can show it inline on tool result. Rate-limited per machine to
# 1 warning per ${TEAMEM_WARN_RATE_SECS:-60} seconds per warn-class so a
# broken bridge doesn't spam every keystroke. Set TEAMEM_HOOK_QUIET=1 to
# silence all Tier-W output. Always exits cleanly (returns 0).
#
# Usage: _teamem_warn <warn-class> <one-line message>
_teamem_warn() {
  [ "${TEAMEM_HOOK_QUIET:-}" = "1" ] && return 0
  local cls="${1:-generic}"
  local msg="${2:-unknown failure}"
  local rate="${TEAMEM_WARN_RATE_SECS:-60}"
  local marker="${TEAMEM_DATA}/last-warn-${cls}"
  mkdir -p "${TEAMEM_DATA}" 2>/dev/null || true
  local now
  now=$(date +%s 2>/dev/null || echo 0)
  local last=0
  if [ -f "$marker" ]; then
    last=$(cat "$marker" 2>/dev/null || echo 0)
  fi
  if [ "$((now - last))" -lt "$rate" ]; then
    return 0
  fi
  printf '%s' "$now" > "$marker" 2>/dev/null || true
  printf 'teamem: %s — %s\n' "$cls" "$msg" >&2
  return 0
}

# Path to the bundled bridge runtime shipped with the plugin.
teamem_bridge_js() {
  local plugin_root="${CLAUDE_PLUGIN_ROOT:-}"
  if [ -z "$plugin_root" ]; then
    plugin_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  fi
  printf '%s/lib/bridge.js' "$plugin_root"
}

# Codex F14: resolve which Teamem space the hook should target on each
# bridge call. Without this helper, gate-claim.sh and release-claims.sh
# invoked the bridge with no `--space` flag, and the bridge fell back to
# `credentials.default_space_id` regardless of which space the user
# pinned via `/teamem-on <space>` or the manifest's `default_space`.
# Multi-space users hit "claims silently land in the wrong space".
#
# Resolution order (echoes the resolved value to stdout, returns 0 on hit):
#   1. Per-session pin: `${SESSION_DIR}/space` (written by /teamem-on
#      <space>; preserved across hooks for the same session_id).
#   2. Manifest default: `${CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE}` (label
#      or space_id; the bridge's pickEntry resolves either form post-#20).
#   3. None — return 1, caller omits `--space` and the bridge falls back
#      to `credentials.default_space_id` (existing behavior, preserved
#      for single-space users who never set anything).
_teamem_resolve_space() {
  if [ -n "${SESSION_DIR:-}" ] && [ -f "${SESSION_DIR}/space" ]; then
    cat "${SESSION_DIR}/space" 2>/dev/null
    return 0
  fi
  if [ -n "${CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE:-}" ]; then
    printf '%s' "${CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE}"
    return 0
  fi
  return 1
}
