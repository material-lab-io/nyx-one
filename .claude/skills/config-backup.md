# config-backup

Backup OpenClaw agent configurations.

## Usage

```
/config-backup              # Backup all agents
/config-backup nyx          # Backup specific agent
/config-backup perhitbot
```

## Agent Registry

| Agent | Config Path |
|-------|-------------|
| nyx | ~/.openclaw/ |
| perhitbot | /data/perhitbot/.openclaw/ |

## Backup Location

All backups go to: `~/.openclaw/backups/<YYYY-MM-DD>/<agent>/`

## Backup Procedure

### 1. Create backup directory
```bash
BACKUP_DATE=$(date +%Y-%m-%d)
mkdir -p ~/.openclaw/backups/${BACKUP_DATE}/nyx
mkdir -p ~/.openclaw/backups/${BACKUP_DATE}/perhitbot
```

### 2. Backup Nyx
```bash
BACKUP_DIR=~/.openclaw/backups/${BACKUP_DATE}/nyx

# Core config
cp ~/.openclaw/openclaw.json ${BACKUP_DIR}/
cp ~/.openclaw/agent-matrix.json ${BACKUP_DIR}/ 2>/dev/null || true

# Credentials (sensitive - copy structure, not contents)
mkdir -p ${BACKUP_DIR}/credentials
cp -r ~/.openclaw/credentials/whatsapp ${BACKUP_DIR}/credentials/ 2>/dev/null || true
cp -r ~/.openclaw/credentials/discord ${BACKUP_DIR}/credentials/ 2>/dev/null || true

# Extensions list
ls ~/.openclaw/extensions/ > ${BACKUP_DIR}/extensions.txt 2>/dev/null || true
```

### 3. Backup PerhitBot
```bash
BACKUP_DIR=~/.openclaw/backups/${BACKUP_DATE}/perhitbot

# Core config
cp /data/perhitbot/.openclaw/openclaw.json ${BACKUP_DIR}/

# Credentials
mkdir -p ${BACKUP_DIR}/credentials
cp -r /data/perhitbot/.openclaw/credentials/whatsapp ${BACKUP_DIR}/credentials/ 2>/dev/null || true

# Supabase env (sensitive)
cp /data/perhitbot/.openclaw/.env.perhit-db ${BACKUP_DIR}/ 2>/dev/null || true

# Extensions list
ls /data/perhitbot/.openclaw/extensions/ > ${BACKUP_DIR}/extensions.txt 2>/dev/null || true
```

### 4. Create backup manifest
```bash
BACKUP_DIR=~/.openclaw/backups/${BACKUP_DATE}

echo "Backup created: $(date -Iseconds)" > ${BACKUP_DIR}/manifest.txt
echo "" >> ${BACKUP_DIR}/manifest.txt
echo "Nyx files:" >> ${BACKUP_DIR}/manifest.txt
ls -la ${BACKUP_DIR}/nyx/ >> ${BACKUP_DIR}/manifest.txt
echo "" >> ${BACKUP_DIR}/manifest.txt
echo "PerhitBot files:" >> ${BACKUP_DIR}/manifest.txt
ls -la ${BACKUP_DIR}/perhitbot/ >> ${BACKUP_DIR}/manifest.txt
```

## Output Format

```
Config Backup Complete
======================

Backup location: ~/.openclaw/backups/2026-02-08/

Nyx:
  ✅ openclaw.json
  ✅ agent-matrix.json
  ✅ credentials/whatsapp/
  ✅ credentials/discord/

PerhitBot:
  ✅ openclaw.json
  ✅ credentials/whatsapp/
  ✅ .env.perhit-db

Manifest: ~/.openclaw/backups/2026-02-08/manifest.txt
```

## List Existing Backups

```bash
ls -la ~/.openclaw/backups/
```

## Retention

Backups are not auto-pruned. To clean old backups:
```bash
# Remove backups older than 30 days
find ~/.openclaw/backups -maxdepth 1 -type d -mtime +30 -exec rm -rf {} \;
```
