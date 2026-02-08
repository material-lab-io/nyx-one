#!/bin/bash
# list-tenants.sh - List all tenants and their status

set -euo pipefail

DATA_DIR="/data"
COMPOSE_FILE="/data/openclaw/docker-compose.yml"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo ""
echo -e "${BLUE}OpenClaw Tenants${NC}"
echo "================"
echo ""

printf "%-20s %-8s %-12s %-10s\n" "TENANT" "PORT" "STATUS" "WHATSAPP"
printf "%-20s %-8s %-12s %-10s\n" "------" "----" "------" "--------"

# Find all tenant directories (those with .openclaw subdirectory)
for tenant_dir in "$DATA_DIR"/*/; do
    if [[ -d "${tenant_dir}.openclaw" ]]; then
        tenant_name=$(basename "$tenant_dir")

        # Skip shared directory
        [[ "$tenant_name" == "shared" ]] && continue
        [[ "$tenant_name" == "openclaw" ]] && continue

        # Get port from config
        config_file="${tenant_dir}.openclaw/openclaw.json"
        if [[ -f "$config_file" ]]; then
            port=$(grep -oP '"port":\s*\K\d+' "$config_file" 2>/dev/null || echo "?")
        else
            port="?"
        fi

        # Check container status
        container_name="openclaw-${tenant_name}"
        if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${container_name}$"; then
            status="${GREEN}running${NC}"
        elif docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^${container_name}$"; then
            status="${RED}stopped${NC}"
        else
            status="${YELLOW}not created${NC}"
        fi

        # Check WhatsApp credentials
        wa_creds="${tenant_dir}.openclaw/credentials/whatsapp/default/creds.json"
        if [[ -f "$wa_creds" ]]; then
            wa_status="${GREEN}linked${NC}"
        else
            wa_status="${YELLOW}not linked${NC}"
        fi

        printf "%-20s %-8s %-12b %-10b\n" "$tenant_name" "$port" "$status" "$wa_status"
    fi
done

echo ""

# Count totals
total=$(find "$DATA_DIR" -maxdepth 2 -type d -name ".openclaw" 2>/dev/null | wc -l)
running=$(docker ps --filter "name=openclaw-" --format '{{.Names}}' 2>/dev/null | wc -l || echo 0)

echo "Total tenants: $total"
echo "Running: $running"
echo ""
