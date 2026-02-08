#!/bin/bash
# Start OpenClaw gateway bound to all interfaces for Docker
exec openclaw gateway run --bind custom --port ${CLAWDBOT_GATEWAY_PORT:-18789}
