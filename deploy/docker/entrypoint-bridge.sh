#!/bin/bash
# entrypoint-bridge.sh — Generic startup for Claude Code bridge containers
set -e

CLAUDE_BIN="${BRIDGE_CLAUDE_BIN:-${NYX_CLAUDE_BIN:-claude}}"
BRIDGE_TYPE="${BRIDGE_TYPE:-baileys}"
AGENT="${AGENT_NAME:-nyx}"

echo "[${AGENT}] Starting bridge (type: ${BRIDGE_TYPE})"

# ── Auth rotation — try all available tokens, use first that works ────────────
# Tokens tried in order: CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN_2,
# then ANTHROPIC_API_KEY. The first passing auth wins and is exported for the
# bridge process. If all fail, exit 1 (CrashLoopBackOff with backoff).
try_auth() {
  local token="$1"
  local label="$2"
  if [ -z "$token" ]; then return 1; fi
  if CLAUDE_CODE_OAUTH_TOKEN="$token" "$CLAUDE_BIN" -p "ping" --output-format text >/dev/null 2>/tmp/auth-check.err; then
    echo "[${AGENT}] claude auth OK (${label})"
    export CLAUDE_CODE_OAUTH_TOKEN="$token"
    return 0
  fi
  echo "[${AGENT}] auth failed for ${label}: $(cat /tmp/auth-check.err | head -1)"
  return 1
}

if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  # API key path: no rotation needed, just verify the binary works
  if ! "$CLAUDE_BIN" -p "ping" --output-format text >/dev/null 2>/tmp/auth-check.err; then
    echo "ERROR: claude auth failed (ANTHROPIC_API_KEY):"
    cat /tmp/auth-check.err >&2
    exit 1
  fi
  echo "[${AGENT}] claude auth OK (api-key)"
elif try_auth "${CLAUDE_CODE_OAUTH_TOKEN:-}" "token-1" || \
     try_auth "${CLAUDE_CODE_OAUTH_TOKEN_2:-}" "token-2"; then
  : # one of the tokens worked, CLAUDE_CODE_OAUTH_TOKEN is now exported
else
  echo "ERROR: all auth methods failed — check nyx-claude-token secret"
  echo "  token-1 error: $(cat /tmp/auth-check.err 2>/dev/null | head -1)"
  echo "  Rotation: claude setup-token → deploy/k8s/rotate-nyx-token.sh <token>"
  exit 1
fi

# ── Bootstrap WhatsApp creds from secret (if PVC is empty) ───────────────────
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

# ── Dispatch to correct bridge ────────────────────────────────────────────────
case "$BRIDGE_TYPE" in
  baileys) exec node /app/baileys-bridge.js ;;
  slack)   exec node /app/slack-bridge.js ;;
  *) echo "Unknown BRIDGE_TYPE: $BRIDGE_TYPE"; exit 1 ;;
esac
