#!/usr/bin/env bash
# Claude Usage Tracker — Standalone tmux statusline script
#
# Calls the Anthropic OAuth usage API with file-based caching
# and outputs a tmux-formatted status string.
#
# Add to ~/.tmux.conf:
#   set -g status-right '#(~/.local/bin/tmux-usage.sh)'
#   set -g status-interval 60
#
# Environment variables:
#   CLAUDE_USAGE_CACHE_TTL   — cache TTL in seconds (default: 60)
#   CLAUDE_USAGE_CACHE_FILE  — cache file path (default: /tmp/claude-usage-cache-$UID.json)
#   CLAUDE_USAGE_COMPACT     — "1" = show only 5h percentage (default: "0")
#   CLAUDE_USAGE_NO_COLOR    — "1" = disable tmux colors (default: "0")

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
CACHE_TTL="${CLAUDE_USAGE_CACHE_TTL:-60}"
CACHE_FILE="${CLAUDE_USAGE_CACHE_FILE:-/tmp/claude-usage-cache-${UID}.json}"
COMPACT="${CLAUDE_USAGE_COMPACT:-0}"
NO_COLOR="${CLAUDE_USAGE_NO_COLOR:-0}"
CREDENTIALS_FILE="${HOME}/.claude/.credentials.json"
API_URL="https://api.anthropic.com/api/oauth/usage"
BETA_HEADER="anthropic-beta: oauth-2025-04-20"

# ---------------------------------------------------------------------------
# Color helpers
# ---------------------------------------------------------------------------
_fg() {
  if [[ "$NO_COLOR" == "1" ]]; then
    echo ""
  else
    echo "#[fg=$1]"
  fi
}

_reset() {
  if [[ "$NO_COLOR" == "1" ]]; then
    echo ""
  else
    echo "#[fg=default]"
  fi
}

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------
if ! command -v jq &>/dev/null; then
  echo "$(_fg red)Claude: jq not found (apt install jq)$(_reset)"
  exit 0
fi

if ! command -v curl &>/dev/null; then
  echo "$(_fg red)Claude: curl not found (apt install curl)$(_reset)"
  exit 0
fi

# ---------------------------------------------------------------------------
# Read credentials
# ---------------------------------------------------------------------------
if [[ ! -r "$CREDENTIALS_FILE" ]]; then
  echo "$(_fg red)Claude: No credentials$(_reset)"
  exit 0
fi

ACCESS_TOKEN="$(jq -r '.claudeAiOauth.accessToken // empty' "$CREDENTIALS_FILE" 2>/dev/null || true)"
if [[ -z "$ACCESS_TOKEN" ]]; then
  echo "$(_fg red)Claude: No credentials$(_reset)"
  exit 0
fi

# ---------------------------------------------------------------------------
# Token expiry check
# ---------------------------------------------------------------------------
EXPIRES_AT="$(jq -r '.claudeAiOauth.expiresAt // empty' "$CREDENTIALS_FILE" 2>/dev/null || true)"
if [[ -n "$EXPIRES_AT" ]]; then
  NOW_TS="$(date +%s)"
  if [[ "$EXPIRES_AT" =~ ^[0-9]+$ ]]; then
    EXPIRES_EPOCH="$EXPIRES_AT"
  else
    EXPIRES_EPOCH="$(date -d "$EXPIRES_AT" +%s 2>/dev/null || echo 0)"
  fi
  if (( EXPIRES_EPOCH > 0 && NOW_TS >= EXPIRES_EPOCH )); then
    echo "$(_fg yellow)Claude: Token expired - run claude auth$(_reset)"
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# Cache logic
# ---------------------------------------------------------------------------
_cache_is_fresh() {
  [[ -f "$CACHE_FILE" ]] || return 1
  local now mtime age
  now="$(date +%s)"
  mtime="$(stat -c %Y "$CACHE_FILE" 2>/dev/null || echo 0)"
  age=$(( now - mtime ))
  (( age < CACHE_TTL ))
}

_fetch_api() {
  local tmp_file response http_code body
  tmp_file="$(mktemp)"

  # curl writes body to tmp_file, outputs http_code to stdout
  http_code="$(curl -s -w '%{http_code}' -o "$tmp_file" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -H "${BETA_HEADER}" \
    "${API_URL}" 2>/dev/null || echo "000")"

  if [[ "$http_code" == "200" ]]; then
    # Atomic write: tmp -> rename
    mv -f "$tmp_file" "$CACHE_FILE"
    return 0
  else
    rm -f "$tmp_file"
    return 1
  fi
}

# Try to get fresh data
if ! _cache_is_fresh; then
  if ! _fetch_api; then
    # API failed — use stale cache if available
    if [[ -f "$CACHE_FILE" ]]; then
      # Mark as stale but continue with old data
      STALE=1
    else
      echo "$(_fg red)Claude: API error$(_reset)"
      exit 0
    fi
  else
    STALE=0
  fi
else
  STALE=0
fi

# ---------------------------------------------------------------------------
# Parse usage data
# ---------------------------------------------------------------------------

# Extract 5-hour usage percentage (nested: .five_hour.used_percentage is 0-1)
FIVE_HOUR_PCT="$(jq -r '
  (.five_hour.used_percentage // 0) * 100 | floor
' < "$CACHE_FILE" 2>/dev/null || echo "0")"

# Extract 7-day usage percentage (nested: .seven_day.used_percentage is 0-1)
SEVEN_DAY_PCT="$(jq -r '
  (.seven_day.used_percentage // 0) * 100 | floor
' < "$CACHE_FILE" 2>/dev/null || echo "0")"

# Extract reset timestamp from 5-hour window and compute countdown
RESET_AT="$(jq -r '.five_hour.resets_at // empty' < "$CACHE_FILE" 2>/dev/null || true)"
if [[ -n "$RESET_AT" ]]; then
  # Handle both epoch and ISO format
  if [[ "$RESET_AT" =~ ^[0-9]+$ ]]; then
    RESET_EPOCH="$RESET_AT"
  else
    RESET_EPOCH="$(date -d "$RESET_AT" +%s 2>/dev/null || echo 0)"
  fi
  NOW_EPOCH="$(date +%s)"
  REMAINING=$(( RESET_EPOCH - NOW_EPOCH ))
  if (( REMAINING < 0 )); then
    REMAINING=0
  fi
  HOURS=$(( REMAINING / 3600 ))
  MINUTES=$(( (REMAINING % 3600) / 60 ))
  RESET_STR="$(printf '%dh%02dm' "$HOURS" "$MINUTES")"
else
  RESET_STR="--:--"
fi

# ---------------------------------------------------------------------------
# Color thresholds
# ---------------------------------------------------------------------------
_usage_color() {
  local pct="$1"
  if (( pct >= 90 )); then
    echo "red"
  elif (( pct >= 70 )); then
    echo "yellow"
  else
    echo "green"
  fi
}

FIVE_COLOR="$(_usage_color "$FIVE_HOUR_PCT")"
SEVEN_COLOR="$(_usage_color "$SEVEN_DAY_PCT")"

# ---------------------------------------------------------------------------
# Progress bar (10 chars: filled + empty)
# ---------------------------------------------------------------------------
_progress_bar() {
  local pct="$1"
  local filled=$(( pct / 10 ))
  local empty=$(( 10 - filled ))
  local bar=""

  for (( i=0; i<filled; i++ )); do
    bar+="█"
  done
  for (( i=0; i<empty; i++ )); do
    bar+="░"
  done
  echo "$bar"
}

FIVE_BAR="$(_progress_bar "$FIVE_HOUR_PCT")"

# ---------------------------------------------------------------------------
# Build output
# ---------------------------------------------------------------------------
STALE_MARKER=""
if [[ "${STALE:-0}" == "1" ]]; then
  STALE_MARKER=" $(_fg red)*$(_reset)"
fi

if [[ "$COMPACT" == "1" ]]; then
  # Compact mode: just the essentials
  echo "$(_fg cyan)Claude$(_reset) $(_fg "$FIVE_COLOR")${FIVE_HOUR_PCT}%$(_reset)${STALE_MARKER}"
else
  # Full mode
  echo "$(_fg cyan)Claude$(_reset) | $(_fg "$FIVE_COLOR")5h: ${FIVE_HOUR_PCT}%$(_reset) $(_fg "$FIVE_COLOR")${FIVE_BAR}$(_reset) | $(_fg "$SEVEN_COLOR")7d: ${SEVEN_DAY_PCT}%$(_reset) | $(_fg magenta)Reset: ${RESET_STR}$(_reset)${STALE_MARKER}"
fi
