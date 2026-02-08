# whatsapp-status

Check WhatsApp connection status for OpenClaw agents.

## Usage

```
/whatsapp-status           # Check all agents
/whatsapp-status nyx       # Check specific agent
/whatsapp-status perhitbot
```

## Agent Registry

| Agent | Service | Config Path |
|-------|---------|-------------|
| nyx | clawdbot-gateway.service | ~/.openclaw/openclaw.json |
| perhitbot | clawdbot-perhit.service | /data/perhitbot/.openclaw/openclaw.json |

## Check Procedure

### 1. Check WhatsApp config exists
```bash
# Nyx
jq '.channels.whatsapp' ~/.openclaw/openclaw.json

# PerhitBot
jq '.channels.whatsapp' /data/perhitbot/.openclaw/openclaw.json
```

### 2. Check credentials directory
```bash
# Nyx
ls -la ~/.openclaw/credentials/whatsapp/default/ 2>/dev/null

# PerhitBot
ls -la /data/perhitbot/.openclaw/credentials/whatsapp/default/ 2>/dev/null
```

### 3. Check connection status in logs
```bash
# Look for connection messages (last 200 lines)
journalctl --user -u clawdbot-gateway -n 200 --no-pager | grep -iE "whatsapp|baileys|listening for personal"
journalctl --user -u clawdbot-perhit -n 200 --no-pager | grep -iE "whatsapp|baileys|listening for personal"
```

Key indicators:
- **Connected**: "Listening for personal WhatsApp messages"
- **Disconnected**: "WhatsApp disconnected", "connection closed"
- **Linking needed**: "Scan QR code", "waiting for QR"

### 4. Check for recent WhatsApp errors
```bash
journalctl --user -u clawdbot-gateway -n 100 --no-pager | grep -i "whatsapp.*error\|baileys.*error"
journalctl --user -u clawdbot-perhit -n 100 --no-pager | grep -i "whatsapp.*error\|baileys.*error"
```

## Output Format

```
WhatsApp Status
===============

Nyx (clawdbot-gateway):
  Config: ✅ present
  Credentials: ✅ linked
  Connection: ✅ listening
  Last activity: 2026-02-08 10:30:15

PerhitBot (clawdbot-perhit):
  Config: ✅ present
  Credentials: ✅ linked
  Connection: ⚠️ disconnected (5 min ago)
  Last error: "Connection lost - reconnecting"
```

## Common Issues

### No credentials found
Run `/whatsapp-link <agent>` to link the account.

### Disconnected frequently
- Check internet connectivity
- WhatsApp may have rate-limited the session
- Try unlinking and relinking

### Baileys errors
- Update openclaw to latest version
- Clear credentials and relink: `rm -rf <config>/credentials/whatsapp/default`
