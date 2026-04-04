#!/bin/bash
# entrypoint-bridge.sh — Generic startup for Claude Code bridge containers
set -e

# ── Require at least one auth method ─────────────────────────────────────────
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "ERROR: Neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY is set"
  echo "  Set CLAUDE_CODE_OAUTH_TOKEN from: claude setup-token"
  exit 1
fi

CLAUDE_BIN="${BRIDGE_CLAUDE_BIN:-${NYX_CLAUDE_BIN:-claude}}"
BRIDGE_TYPE="${BRIDGE_TYPE:-baileys}"
AGENT="${AGENT_NAME:-nyx}"

echo "[${AGENT}] Starting bridge (type: ${BRIDGE_TYPE})"

# ── Bootstrap WhatsApp creds from secret (if PVC is empty) ───────────────────
# WHATSAPP_CREDS_JSON holds creds.json content from the k8s secret.
# Only written when the creds dir has no creds.json (fresh PVC or node failure).
if [ -n "${WHATSAPP_CREDS_JSON:-}" ]; then
  DATA_DIR="${BRIDGE_DATA_DIR:-${NYX_DATA_DIR:-/data/nyx}}"
  CREDS_DIR="${DATA_DIR}/creds"
  CREDS_FILE="${CREDS_DIR}/creds.json"
  if [ ! -f "${CREDS_FILE}" ]; then
    mkdir -p "${CREDS_DIR}"
    echo "${WHATSAPP_CREDS_JSON}" > "${CREDS_FILE}"
    echo "[${AGENT}] Bootstrapped WhatsApp creds from secret"
  fi
fi

# ── Auth smoke test — CrashLoopBackOff in k8s if broken ──────────────────────
if ! "$CLAUDE_BIN" -p "ping" --output-format text >/dev/null 2>/tmp/auth-check.err; then
  echo "ERROR: claude auth failed:"
  cat /tmp/auth-check.err >&2
  exit 1
fi
echo "[${AGENT}] claude auth OK"

# ── Dispatch to correct bridge ────────────────────────────────────────────────
case "$BRIDGE_TYPE" in
  baileys) exec node /app/baileys-bridge.js ;;
  slack)   exec node /app/slack-bridge.js ;;
  *) echo "Unknown BRIDGE_TYPE: $BRIDGE_TYPE"; exit 1 ;;
esac
