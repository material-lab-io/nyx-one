# agent-logs

Search and filter agent logs.

## Usage

```
/agent-logs nyx              # Last 50 lines for nyx
/agent-logs perhitbot        # Last 50 lines for perhitbot
/agent-logs nyx error        # Filter by keyword
/agent-logs perhitbot whatsapp
```

## Agent Registry

| Agent | Service |
|-------|---------|
| nyx | clawdbot-gateway.service |
| perhitbot | clawdbot-perhit.service |

## Filter Keywords

| Filter | Grep Pattern |
|--------|--------------|
| error | `error\|Error\|ERROR\|failed\|Failed` |
| whatsapp | `whatsapp\|WhatsApp\|baileys\|Baileys` |
| discord | `discord\|Discord` |
| plugin | `extension\|plugin\|perhit-db` |
| perhit-db | `perhit-db\|supabase\|Supabase` |
| memory | `memory\|embedding\|llama` |
| voice | `voice\|audio\|whisper\|transcri` |

## Commands

### Basic log viewing
```bash
# Nyx - last 50 lines
journalctl --user -u clawdbot-gateway -n 50 --no-pager

# PerhitBot - last 50 lines
journalctl --user -u clawdbot-perhit -n 50 --no-pager
```

### With filter
```bash
# Nyx with error filter
journalctl --user -u clawdbot-gateway -n 200 --no-pager | grep -iE "error|Error|ERROR|failed|Failed"

# PerhitBot with whatsapp filter
journalctl --user -u clawdbot-perhit -n 200 --no-pager | grep -iE "whatsapp|WhatsApp|baileys|Baileys"
```

### Follow logs in real-time
```bash
journalctl --user -u clawdbot-gateway -f
journalctl --user -u clawdbot-perhit -f
```

### Time-based queries
```bash
# Last hour
journalctl --user -u clawdbot-gateway --since "1 hour ago" --no-pager

# Since specific time
journalctl --user -u clawdbot-perhit --since "2026-02-08 10:00:00" --no-pager

# Today only
journalctl --user -u clawdbot-gateway --since today --no-pager
```

## Output Format

When presenting logs:
1. Show the command used
2. Present relevant log lines (truncate if > 50 lines)
3. Highlight errors in the summary
4. Suggest next steps if issues found

Example:
```
Agent Logs: Nyx (error filter)
==============================

Command: journalctl --user -u clawdbot-gateway -n 200 --no-pager | grep -iE "error"

Found 3 errors:

Feb 08 10:15:32 host openclaw[1234]: Error: Connection timeout
Feb 08 10:15:45 host openclaw[1234]: WhatsApp error: Rate limited
Feb 08 10:16:01 host openclaw[1234]: Reconnection failed

Suggestion: Check WhatsApp connection with /whatsapp-status
```

## Troubleshooting

### No logs found
- Service might not be running: `systemctl --user status <service>`
- Logs might be rotated: `journalctl --user -u <service> --no-pager | head`

### Too many logs
- Use more specific filters
- Add time constraints with `--since`
