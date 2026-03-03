#!/usr/bin/env bash
# setup-account.sh — Provision a new WhatsApp account for the nyx bridge
#
# Usage: bash deploy/setup-account.sh <account-name>
#
# What this does:
#   1. Creates /data/nyx/<name>/{creds,conversations}/
#   2. Creates accounts/<name>.env from the example template
#   3. Installs nyx-bridge@<name>.service to ~/.config/systemd/user/
#   4. Runs daemon-reload and enables the unit
#   5. Prints next steps for first run (QR scan)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <account-name>" >&2
  exit 1
fi

NAME="$1"

if [[ ! "$NAME" =~ ^[a-z][a-z0-9_-]*$ ]]; then
  echo "Error: account name must be lowercase alphanumeric/dash/underscore, starting with a letter." >&2
  exit 1
fi

echo "==> Setting up WhatsApp account: $NAME"

# 1. Create data directories
DATA_DIR="/data/nyx/${NAME}"
echo "    Creating data dirs: ${DATA_DIR}/{creds,conversations}"
mkdir -p "${DATA_DIR}/creds" "${DATA_DIR}/conversations"

# 2. Create env file from example if it doesn't exist
ENV_FILE="${REPO_ROOT}/accounts/${NAME}.env"
EXAMPLE_FILE="${REPO_ROOT}/accounts/charlie.env.example"

if [[ -f "$ENV_FILE" ]]; then
  echo "    accounts/${NAME}.env already exists — skipping (edit manually if needed)"
else
  if [[ ! -f "$EXAMPLE_FILE" ]]; then
    echo "Error: Example env file not found: $EXAMPLE_FILE" >&2
    exit 1
  fi
  sed \
    -e "s|/data/nyx/charlie|/data/nyx/${NAME}|g" \
    -e "s|/crew/charlie|/crew/${NAME}|g" \
    -e "s|AGENT_NAME=charlie|AGENT_NAME=${NAME}|g" \
    -e "s|AGENT_DISPLAY_NAME=Nyx (Charlie)|AGENT_DISPLAY_NAME=Nyx (${NAME^})|g" \
    "$EXAMPLE_FILE" > "$ENV_FILE"
  echo "    Created accounts/${NAME}.env from template"
  echo "    *** Edit ${ENV_FILE} to set MAYOR_BRIDGE_TOKEN and BRIDGE_WA_DM_ALLOWLIST ***"
fi

# 3. Install systemd unit
UNIT_SRC="${SCRIPT_DIR}/systemd/nyx-bridge@.service"
SYSTEMD_USER_DIR="${HOME}/.config/systemd/user"
UNIT_DEST="${SYSTEMD_USER_DIR}/nyx-bridge@.service"

mkdir -p "$SYSTEMD_USER_DIR"
if [[ ! -f "$UNIT_DEST" ]]; then
  cp "$UNIT_SRC" "$UNIT_DEST"
  echo "    Installed nyx-bridge@.service to ${SYSTEMD_USER_DIR}"
else
  echo "    nyx-bridge@.service already installed (skipping copy)"
fi

# 4. Reload and enable
echo "    Running: systemctl --user daemon-reload"
systemctl --user daemon-reload

echo "    Running: systemctl --user enable nyx-bridge@${NAME}"
systemctl --user enable "nyx-bridge@${NAME}"

echo ""
echo "==> Account '${NAME}' provisioned successfully."
echo ""
echo "Next steps:"
echo "  1. Edit the env file:   ${ENV_FILE}"
echo "     - Set MAYOR_BRIDGE_TOKEN to the real token"
echo "     - Set BRIDGE_WA_DM_ALLOWLIST to allowed phone numbers"
if [[ "$NAME" != "charlie" ]]; then
  echo "     - Update BRIDGE_HEALTH_PORT to avoid collisions (e.g. 8081, 8082)"
fi
echo ""
echo "  2. Start and watch for QR:"
echo "     systemctl --user start nyx-bridge@${NAME}"
echo "     journalctl --user -f -u nyx-bridge@${NAME}"
echo ""
echo "  3. Scan the QR code with the ${NAME} WhatsApp account."
echo ""
echo "  4. Add crew workspace (from gas town root):"
echo "     cd /home/kanaba/gt && gt crew add nyx_one ${NAME}"
if [[ -f "${SCRIPT_DIR}/claude-config/${NAME}/CLAUDE.md" ]]; then
  echo "     cp deploy/claude-config/${NAME}/CLAUDE.md crew/${NAME}/CLAUDE.md"
fi
