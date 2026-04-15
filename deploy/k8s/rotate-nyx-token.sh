#!/usr/bin/env bash
# rotate-nyx-token.sh — Update nyx-claude-token with a fresh long-lived setup-token
#
# USAGE:
#   claude setup-token          # run interactively on operator's host first
#   ./rotate-nyx-token.sh <token>
#
# DO NOT use this with the short-lived access token from ~/.claude/.credentials.json
# That token expires in ~8 hours and will cause auth failures.
# Only use the output of `claude setup-token` (valid ~1 year).

set -euo pipefail

TOKEN="${1:-}"

if [ -z "$TOKEN" ]; then
  echo "Usage: $0 <token-from-claude-setup-token>"
  echo ""
  echo "How to get the token:"
  echo "  claude setup-token"
  echo ""
  echo "DO NOT use the accessToken from ~/.claude/.credentials.json — that expires in ~8h."
  exit 1
fi

# Sanity check: warn if this looks like a credentials.json access token (too short)
# Setup tokens are longer and don't appear in .credentials.json
CREDS_TOKEN=""
if [ -f "$HOME/.claude/.credentials.json" ]; then
  CREDS_TOKEN=$(python3 -c "import json; d=json.load(open('$HOME/.claude/.credentials.json')); print(d.get('claudeAiOauth',{}).get('accessToken',''))" 2>/dev/null || true)
fi

if [ -n "$CREDS_TOKEN" ] && [ "$TOKEN" = "$CREDS_TOKEN" ]; then
  echo "ERROR: This is the short-lived access token from ~/.claude/.credentials.json"
  echo "       It expires in ~8 hours and will cause Nyx auth failures."
  echo ""
  echo "Run 'claude setup-token' to get a long-lived token instead."
  exit 1
fi

EXPIRY_YEAR=$(( $(date +%Y) + 1 ))
EXPIRY_DATE="${EXPIRY_YEAR}-$(date +%m-%d)"

echo "Updating nyx-claude-token in k8s namespace bots..."

kubectl create secret generic nyx-claude-token -n bots \
  --from-literal=oauth-token="$TOKEN" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl annotate secret nyx-claude-token -n bots \
  token-type=setup-token \
  token-expires="$EXPIRY_DATE" \
  managed-by=manual-rotation-only \
  rotation-procedure="run: claude setup-token → deploy/k8s/rotate-nyx-token.sh <token>" \
  --overwrite

echo "Restarting nyx deployment..."
kubectl rollout restart deployment/nyx -n bots
kubectl rollout status deployment/nyx -n bots --timeout=90s

echo ""
echo "Done. Token valid until approximately $EXPIRY_DATE."
echo "Next rotation: run 'claude setup-token' and re-run this script."
