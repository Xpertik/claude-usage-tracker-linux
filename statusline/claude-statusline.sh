#!/usr/bin/env bash
# Claude Code Statusline — Reads JSON from stdin and formats for tmux
#
# Claude Code provides a statusline hook that pipes JSON to this script.
# This script parses the JSON and outputs a tmux-formatted status string.
#
# Usage with Claude Code:
#   claude --output-format json | claude-statusline.sh
#
# Or configure as a Claude Code statusline hook.
#
# Environment variables:
#   CLAUDE_USAGE_NO_COLOR — "1" = disable tmux colors (default: "0")

set -euo pipefail

NO_COLOR="${CLAUDE_USAGE_NO_COLOR:-0}"

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
# Dependency check
# ---------------------------------------------------------------------------
if ! command -v jq &>/dev/null; then
  echo "$(_fg red)Claude: jq not found (apt install jq)$(_reset)"
  exit 0
fi

# ---------------------------------------------------------------------------
# Read JSON from stdin
# ---------------------------------------------------------------------------
INPUT="$(cat)"

if [[ -z "$INPUT" ]]; then
  echo "$(_fg red)Claude: No input$(_reset)"
  exit 0
fi

# Validate JSON
if ! echo "$INPUT" | jq empty 2>/dev/null; then
  echo "$(_fg red)Claude: Invalid JSON$(_reset)"
  exit 0
fi

# ---------------------------------------------------------------------------
# Parse fields
# ---------------------------------------------------------------------------

# Model name: "opus-4-6" -> "Opus 4.6"
RAW_MODEL="$(echo "$INPUT" | jq -r '.model // "unknown"' 2>/dev/null)"
_format_model() {
  local raw="$1"
  # Replace hyphens, capitalize first letter of each word, convert trailing numbers
  # e.g. "opus-4-6" -> "Opus 4.6", "sonnet-4" -> "Sonnet 4"
  echo "$raw" \
    | sed -E 's/-([0-9]+)-([0-9]+)/ \1.\2/g' \
    | sed -E 's/-([0-9]+)/ \1/g' \
    | sed -E 's/-/ /g' \
    | sed -E 's/\b([a-z])/\u\1/g'
}
MODEL="$(_format_model "$RAW_MODEL")"

# Git branch
GIT_BRANCH="$(echo "$INPUT" | jq -r '.git_branch // empty' 2>/dev/null || true)"

# Rate limits
FIVE_HOUR_PCT="$(echo "$INPUT" | jq -r '
  .rate_limits.five_hour.used_percentage // 0
  | (. * 100) | floor
' 2>/dev/null || echo "0")"

SEVEN_DAY_PCT="$(echo "$INPUT" | jq -r '
  .rate_limits.seven_day.used_percentage // 0
  | (. * 100) | floor
' 2>/dev/null || echo "0")"

# Context window usage (if available)
CTX_PCT="$(echo "$INPUT" | jq -r '
  .context_window.used_percentage // 0
  | (. * 100) | floor
' 2>/dev/null || echo "0")"

# Reset countdown from 5-hour resets_at
RESET_AT="$(echo "$INPUT" | jq -r '.rate_limits.five_hour.resets_at // empty' 2>/dev/null || true)"
if [[ -n "$RESET_AT" ]]; then
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
  RESET_STR="$(printf '%02d:%02d' "$HOURS" "$MINUTES")"
else
  RESET_STR="00:00"
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

# ---------------------------------------------------------------------------
# Progress bar (10 chars)
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
OUTPUT="$(_fg cyan)Claude Usage$(_reset)"

# Git branch (if available)
if [[ -n "$GIT_BRANCH" ]]; then
  OUTPUT+=" | $(_fg yellow)\u2325${GIT_BRANCH}$(_reset)"
fi

# Model
OUTPUT+=" | $(_fg green)${MODEL}$(_reset)"

# Context usage
OUTPUT+=" | $(_fg blue)Ctx: ${CTX_PCT}%$(_reset)"

# 5-hour usage with progress bar
OUTPUT+=" | $(_fg "$FIVE_COLOR")Usage: ${FIVE_HOUR_PCT}%$(_reset) $(_fg "$FIVE_COLOR")${FIVE_BAR}$(_reset)"

# Reset countdown
OUTPUT+=" | $(_fg magenta)\u2192 Reset: ${RESET_STR}$(_reset)"

echo -e "$OUTPUT"
