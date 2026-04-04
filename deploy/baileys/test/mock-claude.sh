#!/bin/bash
# mock-claude.sh — Simulates claude CLI for bridge tests
# Usage: MOCK_CLAUDE_MODE=ok|slow|auth|fail BRIDGE_CLAUDE_BIN=./test/mock-claude.sh
case "${MOCK_CLAUDE_MODE:-ok}" in
  ok)
    echo "mock response"
    exit 0
    ;;
  slow)
    sleep "${MOCK_CLAUDE_DELAY:-0.5}"
    echo "slow response"
    exit 0
    ;;
  auth)
    echo "Error: 401 Unauthorized: invalid oauth token" >&2
    exit 1
    ;;
  fail)
    echo "Internal error" >&2
    exit 2
    ;;
  *)
    echo "Unknown MOCK_CLAUDE_MODE: ${MOCK_CLAUDE_MODE}" >&2
    exit 1
    ;;
esac
