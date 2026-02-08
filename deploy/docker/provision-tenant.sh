#!/bin/bash
# provision-tenant.sh - Create a new OpenClaw tenant
# Usage: ./provision-tenant.sh <tenant-name> [--port PORT] [--anthropic-key KEY]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="/data"
SHARED_DIR="${DATA_DIR}/shared"
TEMPLATES_DIR="${SCRIPT_DIR}/templates"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

print_success() { echo -e "${GREEN}✓${NC} $1"; }
print_warning() { echo -e "${YELLOW}!${NC} $1"; }
print_error() { echo -e "${RED}✗${NC} $1"; }

# Default values
PORT=""
ANTHROPIC_KEY=""
AGENT_NAME=""
AGENT_DESC="A helpful AI assistant"

# Parse arguments
TENANT_NAME=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --port)
            PORT="$2"
            shift 2
            ;;
        --anthropic-key)
            ANTHROPIC_KEY="$2"
            shift 2
            ;;
        --agent-name)
            AGENT_NAME="$2"
            shift 2
            ;;
        --agent-desc)
            AGENT_DESC="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: $0 <tenant-name> [options]"
            echo ""
            echo "Options:"
            echo "  --port PORT            Gateway port (auto-assigned if not specified)"
            echo "  --anthropic-key KEY    Anthropic API key"
            echo "  --agent-name NAME      Agent name (defaults to tenant name)"
            echo "  --agent-desc DESC      Agent description"
            echo ""
            echo "Example:"
            echo "  $0 my-tenant --port 18790 --anthropic-key sk-ant-..."
            exit 0
            ;;
        -*)
            print_error "Unknown option: $1"
            exit 1
            ;;
        *)
            if [[ -z "$TENANT_NAME" ]]; then
                TENANT_NAME="$1"
            else
                print_error "Unexpected argument: $1"
                exit 1
            fi
            shift
            ;;
    esac
done

# Validate tenant name
if [[ -z "$TENANT_NAME" ]]; then
    print_error "Tenant name is required"
    echo "Usage: $0 <tenant-name> [--port PORT] [--anthropic-key KEY]"
    exit 1
fi

# Sanitize tenant name (lowercase, alphanumeric and hyphens only)
TENANT_NAME_CLEAN=$(echo "$TENANT_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g')
if [[ "$TENANT_NAME" != "$TENANT_NAME_CLEAN" ]]; then
    print_warning "Tenant name sanitized to: $TENANT_NAME_CLEAN"
    TENANT_NAME="$TENANT_NAME_CLEAN"
fi

# Set agent name if not specified
if [[ -z "$AGENT_NAME" ]]; then
    AGENT_NAME="$TENANT_NAME"
fi

TENANT_DIR="${DATA_DIR}/${TENANT_NAME}"
OPENCLAW_DIR="${TENANT_DIR}/.openclaw"

# Check if tenant already exists
if [[ -d "$TENANT_DIR" ]]; then
    print_error "Tenant directory already exists: $TENANT_DIR"
    echo "To recreate, first run: rm -rf $TENANT_DIR"
    exit 1
fi

# Auto-assign port if not specified
if [[ -z "$PORT" ]]; then
    # Find highest used port and add 1
    EXISTING_PORTS=$(find "$DATA_DIR" -maxdepth 2 -name "openclaw.json" -exec grep -h '"port":' {} \; 2>/dev/null | grep -oP '\d+' | sort -n | tail -1 || echo "18788")
    PORT=$((EXISTING_PORTS + 1))
    print_warning "Auto-assigned port: $PORT"
fi

echo ""
echo "Provisioning tenant: $TENANT_NAME"
echo "  Directory: $TENANT_DIR"
echo "  Port: $PORT"
echo "  Agent: $AGENT_NAME"
echo ""

# Create directory structure
echo "Creating directory structure..."
mkdir -p "${OPENCLAW_DIR}/credentials/whatsapp/default"
mkdir -p "${OPENCLAW_DIR}/agents/${AGENT_NAME}/agent"
mkdir -p "${OPENCLAW_DIR}/identity"
mkdir -p "${OPENCLAW_DIR}/memory"
print_success "Created directories"

# Generate unique device identity
DEVICE_ID=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)
cat > "${OPENCLAW_DIR}/identity/device.json" << EOF
{
  "deviceId": "${DEVICE_ID}",
  "createdAt": "$(date -Iseconds)",
  "tenant": "${TENANT_NAME}"
}
EOF
print_success "Generated device identity: ${DEVICE_ID:0:8}..."

# Generate config from template
CONFIG_FILE="${OPENCLAW_DIR}/openclaw.json"
sed -e "s/{{GATEWAY_PORT}}/${PORT}/g" \
    -e "s/{{AGENT_NAME}}/${AGENT_NAME}/g" \
    -e "s/{{AGENT_DESCRIPTION}}/${AGENT_DESC}/g" \
    "${TEMPLATES_DIR}/openclaw.json" > "$CONFIG_FILE"
print_success "Created config: $CONFIG_FILE"

# Generate secrets.env
SECRETS_FILE="${TENANT_DIR}/secrets.env"
TIMESTAMP=$(date -Iseconds)
sed -e "s/{{TENANT_NAME}}/${TENANT_NAME}/g" \
    -e "s/{{TIMESTAMP}}/${TIMESTAMP}/g" \
    -e "s/{{ANTHROPIC_API_KEY}}/${ANTHROPIC_KEY:-YOUR_API_KEY_HERE}/g" \
    "${TEMPLATES_DIR}/secrets.env.template" > "$SECRETS_FILE"
chmod 600 "$SECRETS_FILE"
print_success "Created secrets file: $SECRETS_FILE"

# Create auth-profiles.json for the agent
if [[ -n "$ANTHROPIC_KEY" ]]; then
    cat > "${OPENCLAW_DIR}/agents/${AGENT_NAME}/agent/auth-profiles.json" << EOF
{
  "default": {
    "provider": "anthropic",
    "apiKey": "${ANTHROPIC_KEY}"
  }
}
EOF
    chmod 600 "${OPENCLAW_DIR}/agents/${AGENT_NAME}/agent/auth-profiles.json"
    print_success "Created auth profile with API key"
else
    cat > "${OPENCLAW_DIR}/agents/${AGENT_NAME}/agent/auth-profiles.json" << EOF
{
  "default": {
    "provider": "anthropic",
    "apiKey": ""
  }
}
EOF
    print_warning "Auth profile created without API key - update secrets.env or auth-profiles.json"
fi

# Add tenant to docker-compose if it exists
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"
if [[ -f "$COMPOSE_FILE" ]]; then
    if grep -q "openclaw-${TENANT_NAME}:" "$COMPOSE_FILE" 2>/dev/null; then
        print_warning "Tenant already in docker-compose.yml"
    else
        echo ""
        echo "To add this tenant to docker-compose.yml, run:"
        echo "  ./add-to-compose.sh ${TENANT_NAME} ${PORT}"
    fi
fi

echo ""
print_success "Tenant provisioned successfully!"
echo ""
echo "Next steps:"
echo "  1. Update API key in: $SECRETS_FILE"
echo "  2. Add to compose:    ./add-to-compose.sh ${TENANT_NAME} ${PORT}"
echo "  3. Start container:   docker compose up -d ${TENANT_NAME}"
echo "  4. Link WhatsApp:     docker exec -it openclaw-${TENANT_NAME} openclaw channels login --channel whatsapp"
echo ""
