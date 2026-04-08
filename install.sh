#!/usr/bin/env bash
set -euo pipefail

# Claude Usage Tracker for Linux — Installer
# Idempotent: safe to run multiple times.

EXTENSION_UUID="claude-usage-tracker@xpertik.com"
EXTENSION_DIR="$HOME/.local/share/gnome-shell/extensions/$EXTENSION_UUID"
BIN_DIR="$HOME/.local/bin"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

usage() {
    cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Install Claude Usage Tracker components for Linux.

Options:
  --gnome       Install GNOME Shell extension only
  --tmux        Install tmux statusline scripts only
  --all         Install everything (default)
  --uninstall   Remove all installed components
  -h, --help    Show this help message

Examples:
  ./install.sh              # Install everything
  ./install.sh --gnome      # GNOME extension only
  ./install.sh --tmux       # tmux scripts only
  ./install.sh --uninstall  # Remove everything
EOF
}

check_tool() {
    if ! command -v "$1" &>/dev/null; then
        error "'$1' is required but not found. Please install it first."
        return 1
    fi
}

install_gnome() {
    info "Installing GNOME Shell extension..."

    # Check requirements
    check_tool glib-compile-schemas || return 1

    if ! command -v gnome-shell &>/dev/null; then
        warn "gnome-shell not found — installing extension files anyway."
        warn "The extension will only work in a GNOME Shell session."
    fi

    # Create target directory
    mkdir -p "$EXTENSION_DIR/schemas"

    # Copy extension files
    cp "$SCRIPT_DIR/gnome-extension/metadata.json"  "$EXTENSION_DIR/"
    cp "$SCRIPT_DIR/gnome-extension/extension.js"   "$EXTENSION_DIR/"
    cp "$SCRIPT_DIR/gnome-extension/stylesheet.css"  "$EXTENSION_DIR/"
    cp "$SCRIPT_DIR/gnome-extension/prefs.js"        "$EXTENSION_DIR/"
    cp "$SCRIPT_DIR/gnome-extension/schemas/org.gnome.shell.extensions.claude-usage-tracker.gschema.xml" \
       "$EXTENSION_DIR/schemas/"

    # Compile schemas
    glib-compile-schemas "$EXTENSION_DIR/schemas/"
    ok "GSettings schemas compiled."

    ok "GNOME extension installed to: $EXTENSION_DIR"

    echo ""
    info "To enable the extension:"
    echo "  1. Restart GNOME Shell: press Alt+F2, type 'r', press Enter (X11)"
    echo "     OR log out and log back in (Wayland)"
    echo "  2. Enable the extension:"
    echo "     gnome-extensions enable $EXTENSION_UUID"
    echo ""
}

install_tmux() {
    info "Installing tmux statusline scripts..."

    # Check requirements
    local missing=0
    for tool in curl jq; do
        if ! check_tool "$tool"; then
            missing=1
        fi
    done
    if [[ $missing -eq 1 ]]; then
        error "Missing required tools for tmux statusline. Aborting tmux install."
        return 1
    fi

    # Create bin directory
    mkdir -p "$BIN_DIR"

    # Copy scripts
    cp "$SCRIPT_DIR/statusline/tmux-usage.sh"       "$BIN_DIR/claude-tmux-usage.sh"
    cp "$SCRIPT_DIR/statusline/claude-statusline.sh" "$BIN_DIR/claude-statusline.sh"

    # Ensure executable
    chmod +x "$BIN_DIR/claude-tmux-usage.sh"
    chmod +x "$BIN_DIR/claude-statusline.sh"

    ok "Tmux scripts installed to: $BIN_DIR"

    # Check if ~/.local/bin is in PATH
    if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
        warn "$BIN_DIR is not in your PATH."
        echo "  Add this to your shell profile (~/.bashrc or ~/.zshrc):"
        echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
        echo ""
    fi

    echo ""
    info "Add to your ~/.tmux.conf:"
    echo "  set -g status-right '#(~/.local/bin/claude-tmux-usage.sh)'"
    echo "  set -g status-interval 60"
    echo ""
    info "For Claude Code statusline integration:"
    echo "  ~/.local/bin/claude-statusline.sh"
    echo ""
}

uninstall() {
    info "Uninstalling Claude Usage Tracker..."

    # Remove GNOME extension
    if [[ -d "$EXTENSION_DIR" ]]; then
        # Try to disable first
        if command -v gnome-extensions &>/dev/null; then
            gnome-extensions disable "$EXTENSION_UUID" 2>/dev/null || true
        fi
        rm -rf "$EXTENSION_DIR"
        ok "GNOME extension removed."
    else
        info "GNOME extension not installed — skipping."
    fi

    # Remove tmux scripts
    local removed=0
    for script in claude-tmux-usage.sh claude-statusline.sh; do
        if [[ -f "$BIN_DIR/$script" ]]; then
            rm -f "$BIN_DIR/$script"
            removed=1
        fi
    done
    if [[ $removed -eq 1 ]]; then
        ok "Tmux scripts removed."
    else
        info "Tmux scripts not installed — skipping."
    fi

    # Remove cache
    local cache_file="/tmp/claude-usage-cache-$(id -u).json"
    if [[ -f "$cache_file" ]]; then
        rm -f "$cache_file"
        ok "Cache file removed."
    fi

    ok "Uninstall complete."
    echo ""
    info "Remember to:"
    echo "  - Remove the tmux status-right line from ~/.tmux.conf (if added)"
    echo "  - Restart GNOME Shell or log out/in"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

INSTALL_GNOME=0
INSTALL_TMUX=0
UNINSTALL=0

if [[ $# -eq 0 ]]; then
    INSTALL_GNOME=1
    INSTALL_TMUX=1
fi

while [[ $# -gt 0 ]]; do
    case "$1" in
        --gnome)     INSTALL_GNOME=1; shift ;;
        --tmux)      INSTALL_TMUX=1; shift ;;
        --all)       INSTALL_GNOME=1; INSTALL_TMUX=1; shift ;;
        --uninstall) UNINSTALL=1; shift ;;
        -h|--help)   usage; exit 0 ;;
        *)           error "Unknown option: $1"; usage; exit 1 ;;
    esac
done

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   Claude Usage Tracker for Linux         ║"
echo "╚══════════════════════════════════════════╝"
echo ""

if [[ $UNINSTALL -eq 1 ]]; then
    uninstall
    exit 0
fi

if [[ $INSTALL_GNOME -eq 1 ]]; then
    install_gnome
fi

if [[ $INSTALL_TMUX -eq 1 ]]; then
    install_tmux
fi

ok "Installation complete!"
