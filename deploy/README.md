# Deployment Configs

Reference configurations for running OpenClaw agents on Linux with systemd.

## Structure

```
deploy/
├── systemd/
│   ├── clawdbot-gateway.service  # Nyx agent (port 18789)
│   └── clawdbot-perhit.service   # PerhitBot agent (port 18790)
└── agents/
    ├── nyx.openclaw.json         # Nyx config
    └── perhitbot.openclaw.json   # PerhitBot config
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
