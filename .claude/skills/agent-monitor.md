# agent-monitor

Monitor OpenClaw agents (Nyx and PerhitBot) running via systemd.

## Usage

Invoke with `/agent-monitor` to check agent status and logs.

## Quick Status

```bash
# Check both agents
systemctl --user status clawdbot-gateway clawdbot-perhit

# Just active status
systemctl --user status clawdbot-gateway clawdbot-perhit | grep -E "(Active|●)"
```

## View Logs

```bash
# Nyx logs (last 50 lines)
journalctl --user -u clawdbot-gateway -n 50 --no-pager

# PerhitBot logs (last 50 lines)
journalctl --user -u clawdbot-perhit -n 50 --no-pager

# Follow logs in real-time
journalctl --user -u clawdbot-gateway -f
journalctl --user -u clawdbot-perhit -f
```

## Restart Agents

```bash
# Restart both
systemctl --user restart clawdbot-gateway clawdbot-perhit

# Restart one
systemctl --user restart clawdbot-gateway
systemctl --user restart clawdbot-perhit
```

## Check Ports

```bash
# Verify both agents are listening
ss -tlnp | grep -E "(18789|18790)"
```

## Agent Matrix

| Agent | Service | Port | Config |
|-------|---------|------|--------|
| Nyx | clawdbot-gateway.service | 18789 | ~/.openclaw/openclaw.json |
| PerhitBot | clawdbot-perhit.service | 18790 | /data/perhitbot/.openclaw/openclaw.json |

## Common Issues

### Port conflict with Docker
```bash
# Stop Docker container if it's conflicting
docker stop openclaw-perhitbot
systemctl --user restart clawdbot-perhit
```

### Check WhatsApp connection
```bash
journalctl --user -u clawdbot-gateway -n 100 | grep -i whatsapp
journalctl --user -u clawdbot-perhit -n 100 | grep -i whatsapp
```

### Check plugin loading
```bash
journalctl --user -u clawdbot-perhit -n 50 | grep -i "perhit-db"
```

## Notes

- Nyx: Primary agent with Discord + WhatsApp
- PerhitBot: WhatsApp only, has perhit-db plugin for Supabase access
- Both use Groq Whisper for voice transcription
- Config changes require service restart
