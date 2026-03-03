# Deployment Configs

## Agents

| Agent | Stack | Status |
|-------|-------|--------|
| **Nyx** | Claude Code + Baileys-direct | Migrated (see `baileys/`, `claude-config/`) |
| **PerhitBot** | OpenClaw + Baileys | Still on openclaw |

## Structure

```
deploy/
├── baileys/                      # Nyx: standalone Baileys bridge
│   ├── baileys-bridge.js         # WhatsApp ↔ claude CLI bridge
│   ├── package.json
│   └── README.md
├── claude-config/                # Nyx: Claude Code identity
│   └── CLAUDE.md                 # Nyx identity + instructions
├── systemd/                      # Systemd service files
│   ├── nyx-baileys.service       # Nyx bridge (new stack)
│   ├── clawdbot-gateway.service  # Nyx legacy (openclaw, kept for reference)
│   └── clawdbot-perhit.service   # PerhitBot (openclaw)
├── agents/                       # OpenClaw configs (legacy / perhitbot)
│   ├── nyx.openclaw.json         # Nyx openclaw config (archived — not active)
│   └── perhitbot.openclaw.json   # PerhitBot openclaw config
├── mayor-bridge/                 # Mayor mail bridge (shared)
│   ├── mayor-bridge.js           # HTTP adapter: container → gt mail → Mayor
│   ├── mayor-bridge.service      # Systemd unit
│   └── nyx-to-mayor              # Helper script
├── docker/                       # Docker deployment
│   ├── Dockerfile.nyx-claude     # Nyx: Claude Code + Baileys image
│   ├── Dockerfile                # Legacy: OpenClaw multi-tenant image
│   ├── docker-compose.yml        # Compose: nyx (new) + perhitbot (openclaw)
│   ├── entrypoint-nyx.sh         # Nyx container startup
│   └── secrets.env.example       # Template for /data/nyx/secrets.env
└── k8s/                          # Kubernetes manifests
    ├── namespace.yaml
    ├── nyx.yaml                  # Nyx deployment (Claude Code + Baileys)
    ├── nyx-secret.yaml           # Nyx secrets template
    ├── perhitbot.yaml
    ├── perhitbot-secret.yaml
    └── README.md
```

## Setup

### 1. Install systemd services

```bash
# Copy service files
cp deploy/systemd/*.service ~/.config/systemd/user/

# Edit and add your API keys
nano ~/.config/systemd/user/clawdbot-gateway.service
nano ~/.config/systemd/user/clawdbot-perhit.service

# Reload and enable
systemctl --user daemon-reload
systemctl --user enable clawdbot-gateway clawdbot-perhit
```

### 2. Setup agent configs

```bash
# Nyx (default location)
cp deploy/agents/nyx.openclaw.json ~/.openclaw/openclaw.json

# PerhitBot (separate data dir)
mkdir -p /data/perhitbot/.openclaw
cp deploy/agents/perhitbot.openclaw.json /data/perhitbot/.openclaw/openclaw.json
```

### 3. Required secrets (replace placeholders)

In systemd service files:
- `sk-ant-YOUR_ANTHROPIC_KEY` - Anthropic API key
- `gsk_YOUR_GROQ_KEY` - Groq API key (for Whisper STT)
- `YOUR_DISCORD_BOT_TOKEN` - Discord bot token

In openclaw.json:
- `lin_api_YOUR_LINEAR_KEY` - Linear API key (optional)

### 4. Start services

```bash
systemctl --user start clawdbot-gateway clawdbot-perhit
systemctl --user status clawdbot-gateway clawdbot-perhit
```

## Key Configuration Notes

### Session Scope (PerhitBot)
PerhitBot uses `session.dmScope: "per-channel-peer"` to include phone numbers in session keys. This is required for the perhit-db plugin authorization.

### WhatsApp DM Policy
Both agents use `dmPolicy: "allowlist"` - only numbers in `allowFrom` can DM.

### Docker to Systemd Migration
If migrating from Docker, fix file ownership:
```bash
sudo chown -R $USER /data/perhitbot/.openclaw/
```

See MEMORY.md for the full "Docker→Systemd File Ownership Bug" documentation.

## Ports

| Agent     | Port  | Description |
|-----------|-------|-------------|
| Nyx       | 18789 | Primary agent |
| PerhitBot | 18790 | Perhit student DB |

---

## Docker Multi-Tenant Setup

For running multiple isolated tenants, see `docker/README.md`.

```bash
cd deploy/docker

# Build image
./build-image.sh

# Provision tenant
./provision-tenant.sh acme --anthropic-key sk-ant-xxx

# Add to compose and start
./add-to-compose.sh acme 18791
docker compose up -d acme

# Link WhatsApp
./link-whatsapp.sh acme
```

Each tenant gets:
- Isolated container with own credentials
- Separate WhatsApp/Discord sessions
- Resource limits (2 CPU, 2GB RAM)
- Security hardening (dropped caps, no-new-privileges)
