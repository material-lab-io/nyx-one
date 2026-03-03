# Nyx Baileys Bridge

Standalone WhatsApp bridge for Nyx. Receives messages via Baileys and routes them through the Claude Code CLI.

## How it works

```
WhatsApp (charlie account)
  ↓ Baileys WebSocket
baileys-bridge.js
  ↓ ACL check (DM allowlist + group policy)
  ↓ Load per-chat conversation history
claude -p "<history + message>" --system "<nyx identity>"
  ↑ response text
  ↓ Append to history
WhatsApp (reply)
```

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure credentials

Set `NYX_DATA_DIR` (default: `/data/nyx`). The bridge stores:
- `$NYX_DATA_DIR/creds/` — Baileys auth state (WhatsApp session)
- `$NYX_DATA_DIR/conversations/` — Per-chat history (JSONL)

### 3. Authenticate Claude Code

Claude Code must be authenticated before the bridge can invoke it:

```bash
claude auth login
```

For container deployments, mount `~/.claude` as a volume so credentials persist.

### 4. First run (QR scan)

On first startup with a fresh `creds/` directory, a QR code will be printed to the terminal. Scan it with the **charlie** WhatsApp account.

```bash
node baileys-bridge.js
```

After scanning, credentials are saved and future restarts reconnect automatically.

## Restoring credentials from secret

If `WHATSAPP_CREDS_JSON` is set (base64-encoded `creds.json`), the entrypoint script extracts it before starting the bridge:

```bash
echo "$WHATSAPP_CREDS_JSON" | base64 -d > $NYX_DATA_DIR/creds/creds.json
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NYX_DATA_DIR` | `/data/nyx` | Persistent data directory |
| `NYX_CLAUDE_WORKDIR` | `/app` | Working dir for claude CLI |
| `NYX_CLAUDE_BIN` | `claude` | Path to claude binary |
| `NYX_WA_DM_ALLOWLIST` | `+917259620848,+919818452569` | Allowed DM senders |
| `NYX_WA_GROUP_POLICY` | `open` | open/allowlist/deny |
| `NYX_WA_GROUPS` | `{}` | JSON group config (requireMention etc) |
| `NYX_MAX_HISTORY` | `20` | Max conversation turns in context |
| `MAYOR_BRIDGE_URL` | — | If set, enables nyx-to-mayor HTTP calls |
| `MAYOR_BRIDGE_TOKEN` | — | Token for mayor bridge |
| `LOG_LEVEL` | `info` | Pino log level |

## Running with systemd

See `deploy/systemd/nyx-baileys.service`.

## Running with Docker

See `deploy/docker/`.
