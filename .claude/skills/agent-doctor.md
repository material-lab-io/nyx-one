# agent-doctor

Run comprehensive health checks on OpenClaw agents.

## Usage

```
/agent-doctor          # Check all agents
/agent-doctor nyx      # Check specific agent
/agent-doctor perhitbot
```

## Agent Registry

| Agent | Service | Config Path | Port |
|-------|---------|-------------|------|
| nyx | clawdbot-gateway.service | ~/.openclaw/openclaw.json | 18789 |
| perhitbot | clawdbot-perhit.service | /data/perhitbot/.openclaw/openclaw.json | 18790 |

## Health Check Procedure

For each agent, run these checks and report results:

### 1. Service Status
```bash
systemctl --user is-active clawdbot-gateway  # nyx
systemctl --user is-active clawdbot-perhit   # perhitbot
```

### 2. Port Listening
```bash
ss -tlnp | grep 18789  # nyx
ss -tlnp | grep 18790  # perhitbot
```

### 3. Config Validation
```bash
# Nyx
CLAWDBOT_STATE_DIR=~/.openclaw openclaw doctor --json 2>/dev/null || \
  CLAWDBOT_STATE_DIR=~/.openclaw openclaw doctor

# PerhitBot
CLAWDBOT_STATE_DIR=/data/perhitbot/.openclaw openclaw doctor --json 2>/dev/null || \
  CLAWDBOT_STATE_DIR=/data/perhitbot/.openclaw openclaw doctor
```

### 4. Channel Status (from doctor output)
- Discord: Look for "discord: connected" or "discord: enabled"
- WhatsApp: Look for "whatsapp: connected" or "Listening for personal WhatsApp"

### 5. Plugin Status (PerhitBot only)
```bash
journalctl --user -u clawdbot-perhit -n 100 --no-pager | grep -i "perhit-db\|extension"
```

### 6. Recent Errors
```bash
journalctl --user -u clawdbot-gateway -n 50 --no-pager -p err 2>/dev/null || \
  journalctl --user -u clawdbot-gateway -n 50 --no-pager | grep -i error

journalctl --user -u clawdbot-perhit -n 50 --no-pager -p err 2>/dev/null || \
  journalctl --user -u clawdbot-perhit -n 50 --no-pager | grep -i error
```

## Output Format

Present results as a summary table:

```
┌─────────────┬─────────────┬────────────┬──────────┬───────────┬──────────┐
│ Agent       │ Service     │ Port       │ Discord  │ WhatsApp  │ Errors   │
├─────────────┼─────────────┼────────────┼──────────┼───────────┼──────────┤
│ Nyx         │ ✅ active   │ ✅ 18789   │ ✅       │ ✅        │ 0        │
│ PerhitBot   │ ✅ active   │ ✅ 18790   │ ⬜ n/a   │ ✅        │ 2        │
└─────────────┴─────────────┴────────────┴──────────┴───────────┴──────────┘
```

Then show detailed issues if any errors found.

## Troubleshooting

If doctor fails:
1. Check if openclaw is installed: `which openclaw`
2. Verify config exists at the expected path
3. Check service logs for startup errors
