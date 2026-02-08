# config-restore

Restore OpenClaw agent configuration from backup.

## Usage

```
/config-restore 2026-02-07              # Restore all agents from date
/config-restore 2026-02-07 nyx          # Restore specific agent
/config-restore 2026-02-07 perhitbot
/config-restore latest                  # Restore from most recent backup
```

## Agent Registry

| Agent | Config Path | Service |
|-------|-------------|---------|
| nyx | ~/.openclaw/ | clawdbot-gateway.service |
| perhitbot | /data/perhitbot/.openclaw/ | clawdbot-perhit.service |

## Backup Location

Backups stored at: `~/.openclaw/backups/<YYYY-MM-DD>/<agent>/`

## Restore Procedure

### 1. List available backups
```bash
ls -la ~/.openclaw/backups/
```

### 2. Verify backup contents
```bash
# Check what's in the backup
cat ~/.openclaw/backups/<date>/manifest.txt

# Verify JSON is valid
jq . ~/.openclaw/backups/<date>/nyx/openclaw.json
jq . ~/.openclaw/backups/<date>/perhitbot/openclaw.json
```

### 3. Stop affected services
```bash
# For Nyx
systemctl --user stop clawdbot-gateway

# For PerhitBot
systemctl --user stop clawdbot-perhit
```

### 4. Create safety backup of current config
```bash
# Before restoring, backup current state
mkdir -p ~/.openclaw/backups/pre-restore-$(date +%Y%m%d-%H%M%S)
cp ~/.openclaw/openclaw.json ~/.openclaw/backups/pre-restore-$(date +%Y%m%d-%H%M%S)/nyx-openclaw.json
cp /data/perhitbot/.openclaw/openclaw.json ~/.openclaw/backups/pre-restore-$(date +%Y%m%d-%H%M%S)/perhitbot-openclaw.json
```

### 5. Restore Nyx config
```bash
BACKUP_DATE=2026-02-07

# Core config
cp ~/.openclaw/backups/${BACKUP_DATE}/nyx/openclaw.json ~/.openclaw/openclaw.json

# Agent matrix (if exists)
cp ~/.openclaw/backups/${BACKUP_DATE}/nyx/agent-matrix.json ~/.openclaw/ 2>/dev/null || true

# Credentials (optional - careful with WhatsApp, may need relink)
# cp -r ~/.openclaw/backups/${BACKUP_DATE}/nyx/credentials/* ~/.openclaw/credentials/
```

### 6. Restore PerhitBot config
```bash
BACKUP_DATE=2026-02-07

# Core config
cp ~/.openclaw/backups/${BACKUP_DATE}/perhitbot/openclaw.json /data/perhitbot/.openclaw/openclaw.json

# Supabase env (if exists)
cp ~/.openclaw/backups/${BACKUP_DATE}/perhitbot/.env.perhit-db /data/perhitbot/.openclaw/ 2>/dev/null || true
```

### 7. Restart services
```bash
# For Nyx
systemctl --user start clawdbot-gateway

# For PerhitBot
systemctl --user start clawdbot-perhit
```

### 8. Verify restoration
```bash
# Check services are running
systemctl --user status clawdbot-gateway clawdbot-perhit

# Run doctor
/agent-doctor
```

## Output Format

```
Config Restore: 2026-02-07
==========================

Backup found: ~/.openclaw/backups/2026-02-07/

Pre-restore backup created: ~/.openclaw/backups/pre-restore-20260208-143022/

Restoring Nyx:
  ✅ Stopped service
  ✅ Restored openclaw.json
  ✅ Restored agent-matrix.json
  ⏭️  Skipped credentials (relink if needed)
  ✅ Started service
  ✅ Service healthy

Restoring PerhitBot:
  ✅ Stopped service
  ✅ Restored openclaw.json
  ✅ Restored .env.perhit-db
  ⏭️  Skipped credentials (relink if needed)
  ✅ Started service
  ✅ Service healthy

All agents restored successfully.
```

## Restore Options

### Restore only config (recommended)
Just restores openclaw.json - safest option, keeps current credentials.

### Restore with credentials
Also restores credentials/ directory - WhatsApp may need relink if phone changed.

### Full restore
Everything including extensions list - use only when completely broken.

## Rollback

If restore causes issues:
```bash
# Restore from pre-restore backup
cp ~/.openclaw/backups/pre-restore-<timestamp>/nyx-openclaw.json ~/.openclaw/openclaw.json
cp ~/.openclaw/backups/pre-restore-<timestamp>/perhitbot-openclaw.json /data/perhitbot/.openclaw/openclaw.json
systemctl --user restart clawdbot-gateway clawdbot-perhit
```
