#!/bin/bash
# link-whatsapp.sh - Link WhatsApp for a tenant
# Usage: ./link-whatsapp.sh <tenant-name>

set -euo pipefail

TENANT_NAME="${1:-}"

if [[ -z "$TENANT_NAME" ]]; then
    echo "Usage: $0 <tenant-name>"
    echo ""
    echo "This will open an interactive session to scan the WhatsApp QR code."
    echo ""
    echo "Available tenants:"
    docker ps --filter "name=openclaw-" --format '  {{.Names}}' | sed 's/openclaw-//'
    exit 1
fi

CONTAINER_NAME="openclaw-${TENANT_NAME}"

# Check if container is running
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "Error: Container '${CONTAINER_NAME}' is not running"
    echo ""
    echo "Start it with: docker compose up -d ${TENANT_NAME}"
    exit 1
fi

echo "Linking WhatsApp for tenant: ${TENANT_NAME}"
echo ""
echo "A QR code will appear. Scan it with WhatsApp on your phone:"
echo "  1. Open WhatsApp"
echo "  2. Go to Settings > Linked Devices"
echo "  3. Tap 'Link a Device'"
echo "  4. Scan the QR code"
echo ""
echo "Press Ctrl+C to cancel"
echo ""

# Run the login command interactively
docker exec -it "$CONTAINER_NAME" openclaw channels login --channel whatsapp --account default
