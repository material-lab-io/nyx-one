#!/bin/bash
# build-image.sh - Build the OpenClaw Docker image
# Usage: ./build-image.sh [--no-cache]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_NAME="openclaw"
IMAGE_TAG="2026.2.3"

NO_CACHE=""
if [[ "${1:-}" == "--no-cache" ]]; then
    NO_CACHE="--no-cache"
fi

echo "Building OpenClaw Docker image..."
echo "  Image: ${IMAGE_NAME}:${IMAGE_TAG}"
echo ""

cd "$SCRIPT_DIR"

docker build $NO_CACHE -t "${IMAGE_NAME}:${IMAGE_TAG}" -t "${IMAGE_NAME}:latest" .

echo ""
echo "Build complete!"
echo ""
echo "Image details:"
docker images "${IMAGE_NAME}" --format "  {{.Repository}}:{{.Tag}} - {{.Size}}"
echo ""
echo "Next steps:"
echo "  1. Provision a tenant:  ./provision-tenant.sh my-tenant"
echo "  2. Add to compose:      ./add-to-compose.sh my-tenant 18789"
echo "  3. Start container:     docker compose up -d my-tenant"
