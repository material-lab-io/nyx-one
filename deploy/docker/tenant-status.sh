#!/bin/bash
# tenant-status.sh - Get detailed status for a tenant
# Usage: ./tenant-status.sh <tenant-name>

set -euo pipefail

TENANT_NAME="${1:-}"
DATA_DIR="/data"

if [[ -z "$TENANT_NAME" ]]; then
    echo "Usage: $0 <tenant-name>"
    exit 1
fi

TENANT_DIR="${DATA_DIR}/${TENANT_NAME}"
CONTAINER_NAME="openclaw-${TENANT_NAME}"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo ""
echo -e "${BLUE}Tenant: ${TENANT_NAME}${NC}"
echo "========================"
echo ""

# Directory check
echo -e "${BLUE}Directory:${NC}"
if [[ -d "$TENANT_DIR" ]]; then
    echo -e "  ${GREEN}✓${NC} $TENANT_DIR exists"
    du -sh "$TENANT_DIR" 2>/dev/null | awk '{print "  Size: "$1}'
else
    echo -e "  ${RED}✗${NC} Directory not found"
    exit 1
fi
echo ""

# Config check
echo -e "${BLUE}Configuration:${NC}"
config_file="${TENANT_DIR}/.openclaw/openclaw.json"
if [[ -f "$config_file" ]]; then
    port=$(grep -oP '"port":\s*\K\d+' "$config_file" 2>/dev/null || echo "?")
    model=$(grep -oP '"model":\s*"\K[^"]+' "$config_file" 2>/dev/null || echo "?")
    echo "  Port: $port"
    echo "  Model: $model"
else
    echo -e "  ${RED}✗${NC} Config not found"
fi
echo ""

# Secrets check
echo -e "${BLUE}Secrets:${NC}"
secrets_file="${TENANT_DIR}/secrets.env"
if [[ -f "$secrets_file" ]]; then
    if grep -q "ANTHROPIC_API_KEY=sk-" "$secrets_file" 2>/dev/null; then
        echo -e "  ${GREEN}✓${NC} Anthropic API key configured"
    else
        echo -e "  ${YELLOW}!${NC} Anthropic API key not set"
    fi
else
    echo -e "  ${RED}✗${NC} secrets.env not found"
fi
echo ""

# Container status
echo -e "${BLUE}Container:${NC}"
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER_NAME}$"; then
    echo -e "  ${GREEN}✓${NC} Running"
    docker ps --filter "name=${CONTAINER_NAME}" --format '  Uptime: {{.Status}}' 2>/dev/null
    docker stats --no-stream --format '  CPU: {{.CPUPerc}}, Memory: {{.MemUsage}}' "$CONTAINER_NAME" 2>/dev/null || true
elif docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER_NAME}$"; then
    echo -e "  ${RED}✗${NC} Stopped"
else
    echo -e "  ${YELLOW}!${NC} Not created"
fi
echo ""

# Channels status
echo -e "${BLUE}Channels:${NC}"

# WhatsApp
wa_creds="${TENANT_DIR}/.openclaw/credentials/whatsapp/default/creds.json"
if [[ -f "$wa_creds" ]]; then
    echo -e "  WhatsApp: ${GREEN}linked${NC}"
else
    echo -e "  WhatsApp: ${YELLOW}not linked${NC}"
fi

# Discord (check config)
if [[ -f "$config_file" ]] && grep -q '"discord"' "$config_file"; then
    if grep -q '"enabled": true' "$config_file" 2>/dev/null; then
        echo -e "  Discord: ${GREEN}enabled${NC}"
    else
        echo -e "  Discord: ${YELLOW}disabled${NC}"
    fi
fi
echo ""

# Health check if running
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER_NAME}$"; then
    echo -e "${BLUE}Health:${NC}"
    port=$(grep -oP '"port":\s*\K\d+' "$config_file" 2>/dev/null || echo "18789")
    if curl -sf "http://localhost:${port}/health" >/dev/null 2>&1; then
        echo -e "  ${GREEN}✓${NC} Gateway responding"
    else
        echo -e "  ${YELLOW}!${NC} Gateway not responding on port $port"
    fi
    echo ""
fi
