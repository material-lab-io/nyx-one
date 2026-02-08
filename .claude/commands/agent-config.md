# agent-config

Toggle features on/off for OpenClaw agents via config editing.

## Usage

```
/agent-config nyx memorySearch off
/agent-config perhitbot browser on
/agent-config nyx discord off
```

## Agent Registry

| Agent | Config Path | Service |
|-------|-------------|---------|
| nyx | ~/.openclaw/openclaw.json | clawdbot-gateway.service |
| perhitbot | /data/perhitbot/.openclaw/openclaw.json | clawdbot-perhit.service |

## Supported Features

| Feature | Config Path | Values |
|---------|-------------|--------|
| memorySearch | `agents.defaults.memorySearch.enabled` | true/false |
| browser | `tools.browser.enabled` | true/false |
| audio | `tools.media.audio.enabled` | true/false |
| discord | `channels.discord.enabled` | true/false |
| whatsapp | `channels.whatsapp.dmPolicy` | "open"/"allowlist"/"closed" |

## Procedure

### 1. Validate inputs
- Agent must be "nyx" or "perhitbot"
- Feature must be in supported list
- Value must be valid for feature type

### 2. Read current config
```bash
# Nyx
cat ~/.openclaw/openclaw.json

# PerhitBot
cat /data/perhitbot/.openclaw/openclaw.json
```

### 3. Modify config with jq

**memorySearch**:
```bash
# Turn off
jq '.agents.defaults.memorySearch.enabled = false' ~/.openclaw/openclaw.json > /tmp/config.json && \
  mv /tmp/config.json ~/.openclaw/openclaw.json

# Turn on
jq '.agents.defaults.memorySearch.enabled = true' ~/.openclaw/openclaw.json > /tmp/config.json && \
  mv /tmp/config.json ~/.openclaw/openclaw.json
```

**browser**:
```bash
jq '.tools.browser.enabled = false' ~/.openclaw/openclaw.json > /tmp/config.json && \
  mv /tmp/config.json ~/.openclaw/openclaw.json
```

**audio**:
```bash
jq '.tools.media.audio.enabled = false' ~/.openclaw/openclaw.json > /tmp/config.json && \
  mv /tmp/config.json ~/.openclaw/openclaw.json
```

**discord**:
```bash
jq '.channels.discord.enabled = false' ~/.openclaw/openclaw.json > /tmp/config.json && \
  mv /tmp/config.json ~/.openclaw/openclaw.json
```

**whatsapp** (special - uses dmPolicy, not enabled):
```bash
# closed = disabled
jq '.channels.whatsapp.dmPolicy = "closed"' ~/.openclaw/openclaw.json > /tmp/config.json && \
  mv /tmp/config.json ~/.openclaw/openclaw.json

# on = allowlist (respects allowFrom list)
jq '.channels.whatsapp.dmPolicy = "allowlist"' ~/.openclaw/openclaw.json > /tmp/config.json && \
  mv /tmp/config.json ~/.openclaw/openclaw.json
```

### 4. Restart service
```bash
# After Nyx config change
systemctl --user restart clawdbot-gateway

# After PerhitBot config change
systemctl --user restart clawdbot-perhit
```

### 5. Verify change
```bash
systemctl --user status clawdbot-gateway
systemctl --user status clawdbot-perhit
```

## Output Format

```
Config Change: Nyx
==================

Feature: memorySearch
Old value: true
New value: false

Config updated: ~/.openclaw/openclaw.json
Service restarted: clawdbot-gateway.service

Status: ✅ active (running)
```

## Safety

- Always backup before modifying: `/config-backup nyx`
- Verify config is valid JSON after edit
- Check service starts correctly after restart

## Error Handling

If service fails to start after config change:
1. Check logs: `journalctl --user -u <service> -n 50`
2. Validate JSON: `jq . <config-path>`
3. Restore from backup if needed: `/config-restore`
