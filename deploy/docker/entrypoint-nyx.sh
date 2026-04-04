#!/bin/bash
# entrypoint-nyx.sh — Startup for Nyx Claude Code + Baileys container
set -e

DATA_DIR="${NYX_DATA_DIR:-/data/nyx}"
CREDS_DIR="$DATA_DIR/creds"
BACKUP_FILE="${WA_CREDS_BACKUP_PATH:-/secrets/wa-creds/creds-backup.tar.gz}"

echo "[nyx] Starting Nyx (Claude Code + Baileys-direct)"
echo "[nyx] Data dir: $DATA_DIR"

# ── Restore Baileys credentials ─────────────────────────────────────────────
# Priority: PVC (live state) > tar.gz backup > single creds.json env var
if [ -f "$CREDS_DIR/creds.json" ]; then
  echo "[nyx] Using existing credentials from PVC"
elif [ -f "$BACKUP_FILE" ]; then
  echo "[nyx] Restoring full credentials from backup archive..."
  mkdir -p "$DATA_DIR"
  tar xzf "$BACKUP_FILE" -C "$DATA_DIR"
  echo "[nyx] Restored $(ls "$CREDS_DIR" | wc -l) credential files from backup"
elif [ -n "${WHATSAPP_CREDS_JSON:-}" ]; then
  echo "[nyx] Bootstrapping creds.json from env (partial — may need QR rescan)..."
  mkdir -p "$CREDS_DIR"
  echo "$WHATSAPP_CREDS_JSON" > "$CREDS_DIR/creds.json"
else
  echo "[nyx] No credentials found — will generate QR code for scanning"
fi

# ── Verify claude CLI is available and authenticated ─────────────────────────
CLAUDE_BIN="${NYX_CLAUDE_BIN:-claude}"
if ! command -v "$CLAUDE_BIN" >/dev/null 2>&1; then
  echo "[nyx] ERROR: claude CLI not found at $CLAUDE_BIN"
  exit 1
fi

# Quick auth check — fails if not logged in
if ! "$CLAUDE_BIN" -p "ping" --system "reply pong" --output-format text >/dev/null 2>&1; then
  echo "[nyx] WARNING: claude auth check failed — ensure CLAUDE_CODE_OAUTH_TOKEN is set"
fi

echo "[nyx] claude CLI ready"

# ── Start Baileys bridge ────────────────────────────────────────────────────
echo "[nyx] Starting Baileys bridge..."
exec node /app/baileys-bridge.js
