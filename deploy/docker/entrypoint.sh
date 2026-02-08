#!/bin/bash
# OpenClaw Docker Entrypoint
# Runs gateway in foreground

PORT=${OPENCLAW_GATEWAY_PORT:-${CLAWDBOT_GATEWAY_PORT:-18789}}

# Run the gateway with loopback bind (host network means localhost is accessible)
exec openclaw gateway run --port $PORT --bind loopback "$@"
