#!/usr/bin/env bash
# Claude Code Statusline — Displays usage in Claude Code's status bar
# Also forwards data to spacecake if available.
set -euo pipefail

INPUT="$(cat)"

# Forward to spacecake
configDir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
socketPath="${configDir}/spacecake.sock"
if [ -n "${SPACECAKE_TERMINAL:-}" ] && [ -S "$socketPath" ]; then
  echo "$INPUT" | curl -s -X POST -H "Content-Type: application/json" -d @- \
    --unix-socket "$socketPath" --max-time 2 \
    http://localhost/statusline >/dev/null 2>&1 &
fi

# ---------------------------------------------------------------------------
# Write shared cache for GNOME extension and tmux
# ---------------------------------------------------------------------------
SHARED_CACHE="/tmp/claude-usage-data-$(id -u).json"
echo "$INPUT" > "${SHARED_CACHE}.tmp" && mv "${SHARED_CACHE}.tmp" "$SHARED_CACHE"

if ! command -v jq &>/dev/null; then
  echo "Claude Usage | jq required"
  exit 0
fi

if [[ -z "$INPUT" ]] || ! echo "$INPUT" | jq empty 2>/dev/null; then
  echo "Claude Usage"
  exit 0
fi

# ---------------------------------------------------------------------------
# ANSI colors
# ---------------------------------------------------------------------------
RST='\033[0m'
CYAN='\033[36m'
GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
BLUE='\033[34m'
MAGENTA='\033[35m'
BOLD='\033[1m'
DIM='\033[2m'

_color_for_pct() {
  local pct="$1"
  if (( pct >= 90 )); then echo "$RED"
  elif (( pct >= 70 )); then echo "$YELLOW"
  else echo "$GREEN"
  fi
}

# ---------------------------------------------------------------------------
# Parse — model is an object: { id, display_name }
# ---------------------------------------------------------------------------
MODEL="$(echo "$INPUT" | jq -r '.model.display_name // .model.id // "unknown"')"

# Git branch from cwd
GIT_BRANCH="$(cd "$(echo "$INPUT" | jq -r '.cwd // "."')" 2>/dev/null && git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"

# Rate limits — percentages are already 0-100
FIVE_PCT="$(echo "$INPUT" | jq -r '.rate_limits.five_hour.used_percentage // 0' 2>/dev/null || echo "0")"
SEVEN_PCT="$(echo "$INPUT" | jq -r '.rate_limits.seven_day.used_percentage // 0' 2>/dev/null || echo "0")"

# Context window — already 0-100
CTX_PCT="$(echo "$INPUT" | jq -r '.context_window.used_percentage // 0' 2>/dev/null || echo "0")"

# Reset countdown — epoch seconds
RESET_AT="$(echo "$INPUT" | jq -r '.rate_limits.five_hour.resets_at // empty' 2>/dev/null || true)"
if [[ -n "$RESET_AT" ]]; then
  NOW_EPOCH="$(date +%s)"
  REMAINING=$(( RESET_AT - NOW_EPOCH ))
  (( REMAINING < 0 )) && REMAINING=0
  HOURS=$(( REMAINING / 3600 ))
  MINUTES=$(( (REMAINING % 3600) / 60 ))
  RESET_STR="$(printf '%02d:%02d' "$HOURS" "$MINUTES")"
else
  RESET_STR="--:--"
fi

# ---------------------------------------------------------------------------
# Progress bar (10 chars)
# ---------------------------------------------------------------------------
_bar() {
  local pct="$1"
  local filled=$(( pct / 10 ))
  local empty=$(( 10 - filled ))
  local bar=""
  for (( i=0; i<filled; i++ )); do bar+="█"; done
  for (( i=0; i<empty; i++ )); do bar+="░"; done
  echo "$bar"
}

FIVE_COLOR="$(_color_for_pct "$FIVE_PCT")"
FIVE_BAR="$(_bar "$FIVE_PCT")"

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
OUT="${BOLD}${CYAN}Claude Usage${RST}"

if [[ -n "$GIT_BRANCH" ]]; then
  OUT+=" ${DIM}|${RST} ${YELLOW}⌥${GIT_BRANCH}${RST}"
fi

OUT+=" ${DIM}|${RST} ${GREEN}${MODEL}${RST}"
OUT+=" ${DIM}|${RST} ${BLUE}Ctx: ${CTX_PCT}%${RST}"
OUT+=" ${DIM}|${RST} ${FIVE_COLOR}Usage: ${FIVE_PCT}%${RST} ${FIVE_COLOR}${FIVE_BAR}${RST}"
OUT+=" ${DIM}|${RST} ${MAGENTA}→ Reset: ${RESET_STR}${RST}"

echo -e "$OUT"
