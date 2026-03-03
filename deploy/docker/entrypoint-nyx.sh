#!/bin/bash
# entrypoint-nyx.sh — Startup for Nyx Claude Code + Baileys container
set -e

DATA_DIR="${NYX_DATA_DIR:-/data/nyx}"
CREDS_DIR="$DATA_DIR/creds"

echo "[nyx] Starting Nyx (Claude Code + Baileys-direct)"
echo "[nyx] Data dir: $DATA_DIR"

# ── Restore Baileys credentials from secret ───────────────────────────────────
if [ -n "${WHATSAPP_CREDS_JSON:-}" ]; then
  echo "[nyx] Extracting Baileys credentials from WHATSAPP_CREDS_JSON..."
  mkdir -p "$CREDS_DIR"
  echo "$WHATSAPP_CREDS_JSON" | base64 -d > "$CREDS_DIR/creds.json"
  echo "[nyx] Credentials extracted"
fi

# ── Verify claude CLI is available and authenticated ─────────────────────────
CLAUDE_BIN="${NYX_CLAUDE_BIN:-claude}"
if ! command -v "$CLAUDE_BIN" >/dev/null 2>&1; then
  echo "[nyx] ERROR: claude CLI not found at $CLAUDE_BIN"
  exit 1
fi

# Quick auth check — fails if not logged in
if ! "$CLAUDE_BIN" -p "ping" --system "reply pong" --no-markdown >/dev/null 2>&1; then
  echo "[nyx] WARNING: claude auth check failed — ensure ~/.claude is mounted with valid credentials"
  echo "[nyx] To authenticate: docker run -it --rm -v \$HOME/.claude:/root/.claude nyx-claude claude auth login"
fi

echo "[nyx] claude CLI ready"

# ── Start Baileys bridge ──────────────────────────────────────────────────────
echo "[nyx] Starting Baileys bridge..."
exec node /app/baileys-bridge.js
