# whatsapp-link

Link a WhatsApp account to an OpenClaw agent.

## Usage

```
/whatsapp-link nyx
/whatsapp-link perhitbot
```

## Agent Registry

| Agent | Config Path | Service |
|-------|-------------|---------|
| nyx | ~/.openclaw | clawdbot-gateway.service |
| perhitbot | /data/perhitbot/.openclaw | clawdbot-perhit.service |

## Prerequisites

1. Agent service should be stopped during linking
2. WhatsApp must be configured in openclaw.json
3. A phone with WhatsApp installed ready to scan QR

## Linking Procedure

### 1. Stop the agent service
```bash
# For Nyx
systemctl --user stop clawdbot-gateway

# For PerhitBot
systemctl --user stop clawdbot-perhit
```

### 2. Run the link command (interactive)

**Nyx**:
```bash
CLAWDBOT_STATE_DIR=~/.openclaw openclaw whatsapp link
```

**PerhitBot**:
```bash
CLAWDBOT_STATE_DIR=/data/perhitbot/.openclaw openclaw whatsapp link
```

This will:
- Display a QR code in the terminal
- Wait for you to scan with WhatsApp
- Save credentials to `<state-dir>/credentials/whatsapp/default/`

### 3. Scan the QR code
- Open WhatsApp on your phone
- Go to Settings > Linked Devices
- Tap "Link a Device"
- Scan the QR code shown in terminal

### 4. Wait for confirmation
The command will print a success message when linked.

### 5. Restart the agent service
```bash
# For Nyx
systemctl --user start clawdbot-gateway

# For PerhitBot
systemctl --user start clawdbot-perhit
```

### 6. Verify connection
```bash
# Check logs for "Listening for personal WhatsApp messages"
journalctl --user -u clawdbot-gateway -n 50 --no-pager | grep -i whatsapp
journalctl --user -u clawdbot-perhit -n 50 --no-pager | grep -i whatsapp
```

## Docker Alternative

If running in Docker instead of systemd:
```bash
# Stop container
docker stop openclaw-<agent>

# Run link command
docker exec -it openclaw-<agent> openclaw whatsapp link

# Restart container
docker start openclaw-<agent>
```

## Troubleshooting

### QR code not showing
- Ensure terminal supports Unicode
- Try a larger terminal window
- Check if WhatsApp is configured: `jq '.channels.whatsapp' <config-path>/openclaw.json`

### Link fails immediately
- Previous session might be active - logout from WhatsApp Linked Devices first
- Clear old credentials: `rm -rf <state-dir>/credentials/whatsapp/default`

### Disconnects after linking
- WhatsApp rate limiting - wait and try again
- Check internet connectivity
- Ensure agent service is running

## Output Format

```
WhatsApp Link: PerhitBot
========================

1. ✅ Service stopped
2. Running link command...

[QR CODE DISPLAYED HERE]

Scan this QR code with WhatsApp > Settings > Linked Devices

3. ⏳ Waiting for scan...
4. ✅ Successfully linked!
5. ✅ Service restarted
6. ✅ WhatsApp connected

Phone: +91 XXXX XXXX28
Status: Listening for messages
```
