#!/usr/bin/env bash
# check-token-safety.sh — Fail if a Claude setup-token appears in tracked files.
#
# The nyx-claude-token k8s secret must NEVER be committed to git.
# Setup tokens start with "sk-ant-oauthtoken". This script fails the build if
# any such token is found in any git-tracked file.
#
# Run: scripts/check-token-safety.sh
# Used by: .github/workflows/test.yml (token-safety job)

set -euo pipefail

FAIL=0

echo "Checking for leaked Claude tokens in tracked files..."

# Check for setup-token prefix followed by real token content (not placeholder "...")
# Real tokens have long alphanumeric content; placeholders use "..." or end with "-..."
if git grep -lP 'sk-ant-oauthtoken[A-Za-z0-9_-]{10,}' -- ':!scripts/check-token-safety.sh' 2>/dev/null | grep -q .; then
  echo ""
  echo "ERROR: Claude setup-token found in tracked files:"
  git grep -lP 'sk-ant-oauthtoken[A-Za-z0-9_-]{10,}' -- ':!scripts/check-token-safety.sh'
  echo ""
  echo "  The nyx-claude-token secret must NEVER be committed to git."
  echo "  Rotate the token immediately (it is now compromised), then"
  echo "  remove it from git history."
  echo ""
  echo "  Rotation: claude setup-token → deploy/k8s/rotate-nyx-token.sh <token>"
  FAIL=1
fi

# Check for short-lived access tokens (from ~/.claude/.credentials.json)
# Pattern: sk-ant-api03- or sk-ant- followed by real content (not placeholder)
if git grep -lP 'sk-ant-api03-[A-Za-z0-9_-]{10,}' -- ':!scripts/check-token-safety.sh' 2>/dev/null | grep -q .; then
  echo ""
  echo "ERROR: Claude API key found in tracked files:"
  git grep -lP 'sk-ant-api03-[A-Za-z0-9_-]{10,}' -- ':!scripts/check-token-safety.sh'
  echo ""
  echo "  Anthropic API keys must not be committed. Remove and rotate."
  FAIL=1
fi

# Check that nyx-secret.yaml doesn't have an oauth-token key with a real value
# (It should only exist as a comment block, never as actual stringData)
SECRET_FILE="deploy/k8s/nyx-secret.yaml"
if [ -f "$SECRET_FILE" ]; then
  # Look for 'oauth-token:' followed by something that isn't a comment or REPLACE_WITH_
  if grep -E '^\s+oauth-token:\s*"[^R"]' "$SECRET_FILE" 2>/dev/null | grep -q .; then
    echo ""
    echo "ERROR: nyx-secret.yaml contains an oauth-token value that appears real:"
    grep -n 'oauth-token:' "$SECRET_FILE"
    echo ""
    echo "  The nyx-claude-token secret must NOT be defined in nyx-secret.yaml."
    echo "  Remove it and rotate via: claude setup-token → deploy/k8s/rotate-nyx-token.sh <token>"
    FAIL=1
  fi
fi

if [ "$FAIL" -eq 0 ]; then
  echo "OK — no leaked tokens found."
fi

exit "$FAIL"
