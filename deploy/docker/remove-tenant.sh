#!/bin/bash
# remove-tenant.sh - Remove a tenant completely
# Usage: ./remove-tenant.sh <tenant-name> [--force]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"
DATA_DIR="/data"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

print_success() { echo -e "${GREEN}✓${NC} $1"; }
print_warning() { echo -e "${YELLOW}!${NC} $1"; }
print_error() { echo -e "${RED}✗${NC} $1"; }

TENANT_NAME="${1:-}"
FORCE="${2:-}"

if [[ -z "$TENANT_NAME" ]]; then
    echo "Usage: $0 <tenant-name> [--force]"
    exit 1
fi

TENANT_DIR="${DATA_DIR}/${TENANT_NAME}"

echo "This will remove tenant: $TENANT_NAME"
echo "  - Stop and remove container"
echo "  - Remove from docker-compose.yml"
echo "  - Delete data directory: $TENANT_DIR"
echo ""

if [[ "$FORCE" != "--force" ]]; then
    read -p "Are you sure? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 0
    fi
fi

# Stop container if running
CONTAINER_NAME="openclaw-${TENANT_NAME}"
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$" 2>/dev/null; then
    echo "Stopping container..."
    docker stop "$CONTAINER_NAME" 2>/dev/null || true
    docker rm "$CONTAINER_NAME" 2>/dev/null || true
    print_success "Container removed"
else
    print_warning "Container not found (may not have been started)"
fi

# Remove from docker-compose.yml
if [[ -f "$COMPOSE_FILE" ]] && grep -q "${TENANT_NAME}:" "$COMPOSE_FILE" 2>/dev/null; then
    echo "Removing from docker-compose.yml..."
    # This is a simple removal - it removes lines from the tenant name until the next service or EOF
    # For complex cases, may need manual editing
    TEMP_FILE=$(mktemp)
    awk -v tenant="${TENANT_NAME}:" '
        BEGIN { skip=0 }
        $0 ~ "^  "tenant { skip=1; next }
        skip && /^  [a-z]/ { skip=0 }
        !skip { print }
    ' "$COMPOSE_FILE" > "$TEMP_FILE"
    mv "$TEMP_FILE" "$COMPOSE_FILE"
    print_success "Removed from docker-compose.yml"
else
    print_warning "Tenant not found in docker-compose.yml"
fi

# Remove data directory
if [[ -d "$TENANT_DIR" ]]; then
    echo "Removing data directory..."
    rm -rf "$TENANT_DIR"
    print_success "Removed: $TENANT_DIR"
else
    print_warning "Data directory not found"
fi

echo ""
print_success "Tenant '${TENANT_NAME}' removed completely"
