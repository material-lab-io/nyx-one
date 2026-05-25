#!/usr/bin/env bash
set -euo pipefail

# cargo-sphere-mom-watcher — polls Linear CAR team for MOM tickets,
# emails Damini the full rolling call-log when the set changes.
#
# Usage:
#   cargo-sphere-mom-watcher.sh            # normal poll (cron mode)
#   cargo-sphere-mom-watcher.sh --install  # add crontab entry idempotently
#   cargo-sphere-mom-watcher.sh --seed     # prime state without sending email
#   cargo-sphere-mom-watcher.sh --force    # send email even if no change

SCRIPT_PATH="$(readlink -f "$0")"
STATE_DIR="${HOME}/.cache/gt"
STATE_FILE="${STATE_DIR}/cargo-sphere-mom-state.json"
LOG_DIR="${HOME}/.local/var/log"
MAYOR_BRIDGE_TOKEN_FILE="${HOME}/.config/gt/mayor-bridge-token"
MAYOR_BRIDGE_PORT="${MAYOR_BRIDGE_PORT:-19000}"
LINEAR_BIN="${LINEAR_BIN:-/home/kanaba/.local/bin/linear}"
GT_BIN="${GT_BIN:-/home/kanaba/.local/bin/gt}"
GT_DIR="${GT_DIR:-/home/kanaba/gt}"

RECIPIENT="damini@materiallab.io"
SUBJECT="Cargo Sphere — meetings call log"

mkdir -p "$STATE_DIR" "$LOG_DIR"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# ── Install ──────────────────────────────────────────────────────────────────

if [ "${1:-}" = "--install" ]; then
  CRON_LINE="*/10 * * * * ${SCRIPT_PATH} >> ${LOG_DIR}/cargo-sphere-mom.log 2>&1"
  if crontab -l 2>/dev/null | grep -qF "cargo-sphere-mom-watcher"; then
    log "Crontab entry already exists — skipping"
    crontab -l | grep "cargo-sphere-mom"
  else
    (crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -
    log "Installed crontab: $CRON_LINE"
  fi
  exit 0
fi

FORCE=false
SEED=false
[ "${1:-}" = "--force" ] && FORCE=true
[ "${1:-}" = "--seed" ]  && SEED=true

# ── Fetch MOM tickets ────────────────────────────────────────────────────────

log "Polling CAR team for MOM tickets..."

RAW=$(LINEAR_TEAM_KEY=CAR "$LINEAR_BIN" list --status all --limit 200 2>&1) || {
  log "ERROR: linear list failed: $RAW"
  exit 1
}

MOM_IDS=$(echo "$RAW" | jq -r '.issues[] | select(.title | test("^MOM —|^Meeting Notes")) | .identifier' 2>/dev/null) || {
  log "ERROR: jq parse failed"
  exit 1
}

if [ -z "$MOM_IDS" ]; then
  log "No MOM tickets found — nothing to do"
  exit 0
fi

log "Found MOM tickets: $(echo $MOM_IDS | tr '\n' ' ')"

# ── Fetch each ticket and compute state hash ─────────────────────────────────

TICKETS_JSON="[]"
HASH_INPUT=""

for id in $MOM_IDS; do
  TICKET=$(LINEAR_TEAM_KEY=CAR "$LINEAR_BIN" get "$id" 2>&1) || {
    log "WARNING: linear get $id failed — skipping"
    continue
  }
  TICKETS_JSON=$(echo "$TICKETS_JSON" | jq --argjson t "$TICKET" '. + [$t]')
  UPDATED=$(echo "$TICKET" | jq -r '.updatedAt // .createdAt // ""')
  HASH_INPUT="${HASH_INPUT}${id}:${UPDATED}\n"
done

CURRENT_HASH=$(printf "$HASH_INPUT" | sort | sha256sum | cut -d' ' -f1)

# ── Compare against state ────────────────────────────────────────────────────

PREV_HASH=""
if [ -f "$STATE_FILE" ]; then
  PREV_HASH=$(jq -r '.hash // ""' "$STATE_FILE" 2>/dev/null || echo "")
fi

if [ "$SEED" = true ]; then
  jq -n --arg h "$CURRENT_HASH" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{hash: $h, seeded_at: $t, last_sent_at: null}' > "$STATE_FILE"
  log "State seeded (hash=$CURRENT_HASH). No email sent."
  exit 0
fi

if [ "$FORCE" = false ] && [ "$CURRENT_HASH" = "$PREV_HASH" ]; then
  log "No change (hash=$CURRENT_HASH) — skipping"
  exit 0
fi

log "Change detected (prev=${PREV_HASH:-<none>} → curr=$CURRENT_HASH)"

# ── Build the email body ─────────────────────────────────────────────────────

TMPFILE=$(mktemp /tmp/cargo-sphere-mom-XXXXXX.md)
trap 'rm -f "$TMPFILE"' EXIT

# Sort tickets by meeting date (extracted from title or createdAt), most recent first
# Group the 2026-05-04 tickets (CAR-34/35/36) into one meeting entry
build_email() {
  cat <<'HEADER'
Hi Damini,

Here's the latest Cargo Sphere meetings call log, covering all meeting records on file.

---

HEADER

  # Parse tickets into meeting groups by date
  # We need to deduplicate meetings that have multiple tickets for the same date
  local dates_seen=""
  local meeting_num=0

  # Sort by createdAt descending (most recent first)
  local sorted
  sorted=$(echo "$TICKETS_JSON" | jq -c 'sort_by(.createdAt) | reverse | .[]')

  while IFS= read -r ticket; do
    local id title desc url created
    id=$(echo "$ticket" | jq -r '.identifier')
    title=$(echo "$ticket" | jq -r '.title')
    desc=$(echo "$ticket" | jq -r '.description // ""')
    url=$(echo "$ticket" | jq -r '.url // ""')
    created=$(echo "$ticket" | jq -r '.createdAt // ""')

    # Extract date from title if possible (YYYY-MM-DD pattern)
    local meeting_date
    meeting_date=$(echo "$title" | grep -oP '\d{4}-\d{2}-\d{2}' || echo "${created:0:10}")

    # Skip if we already have a richer entry for this date
    if echo "$dates_seen" | grep -qF "$meeting_date"; then
      continue
    fi
    dates_seen="${dates_seen} ${meeting_date}"
    meeting_num=$((meeting_num + 1))

    # Find all ticket IDs for this date
    local date_tickets
    date_tickets=$(echo "$TICKETS_JSON" | jq -r --arg d "$meeting_date" \
      '[.[] | select((.title | test($d)) or ((.createdAt // "")[:10] == $d)) | .identifier] | join(", ")')
    local date_urls
    date_urls=$(echo "$TICKETS_JSON" | jq -r --arg d "$meeting_date" \
      '[.[] | select((.title | test($d)) or ((.createdAt // "")[:10] == $d)) | .url // empty] | first // ""')

    # Pick the richest description among tickets for this date
    local best_desc
    best_desc=$(echo "$TICKETS_JSON" | jq -r --arg d "$meeting_date" \
      '[.[] | select((.title | test($d)) or ((.createdAt // "")[:10] == $d)) | .description // ""] | sort_by(length) | last')

    echo "## Meeting ${meeting_num}: ${meeting_date}"
    echo ""
    echo "**Linear tickets:** ${date_tickets}"
    [ -n "$date_urls" ] && echo "**Link:** ${date_urls}"
    echo ""

    if [ -n "$best_desc" ] && [ "$best_desc" != "null" ]; then
      # Strip the top-level heading if present (we already have our own)
      echo "$best_desc" | sed '1{/^# /d;}'
    else
      echo "*No detailed notes available for this meeting.*"
    fi

    echo ""
    echo "---"
    echo ""
  done <<< "$sorted"

  cat <<'FOOTER'
**Note:** This is an automated summary generated from Linear CAR team records. It updates whenever a new meeting record is filed or an existing one is edited.

Best,
Nyx
FOOTER
}

build_email > "$TMPFILE"

# ── Send email via mayor-bridge ──────────────────────────────────────────────

MB_TOKEN=""
if [ -f "$MAYOR_BRIDGE_TOKEN_FILE" ]; then
  MB_TOKEN=$(cat "$MAYOR_BRIDGE_TOKEN_FILE")
fi

if [ -z "$MB_TOKEN" ]; then
  log "ERROR: No mayor-bridge token at $MAYOR_BRIDGE_TOKEN_FILE"
  exit 1
fi

BODY_CONTENT=$(cat "$TMPFILE")

SEND_RESULT=$(node -e "
const http = require('http');
const body = JSON.stringify({
  to: $(jq -Rn --arg r "$RECIPIENT" '$r'),
  subject: $(jq -Rn --arg s "$SUBJECT" '$s'),
  body: $(jq -Rn --arg b "$BODY_CONTENT" '$b')
});
const req = http.request({
  hostname: '127.0.0.1',
  port: ${MAYOR_BRIDGE_PORT},
  path: '/email/send',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ${MB_TOKEN}',
    'Content-Length': Buffer.byteLength(body)
  }
}, res => {
  let data = '';
  res.on('data', d => data += d);
  res.on('end', () => {
    process.stdout.write(data);
    process.exit(res.statusCode >= 200 && res.statusCode < 300 ? 0 : 1);
  });
});
req.on('error', e => { process.stderr.write(e.message + '\n'); process.exit(1); });
req.write(body);
req.end();
" 2>&1) || {
  log "ERROR: email send failed: $SEND_RESULT"
  "$GT_BIN" escalate -s HIGH "cargo-sphere automation: nyx-email send failed: ${SEND_RESULT:0:200}" 2>/dev/null || true
  exit 1
}

MSG_ID=$(echo "$SEND_RESULT" | jq -r '.stdout // ""' 2>/dev/null | grep -oP 'message_id\t\K\S+' || echo "unknown")

log "Email sent to $RECIPIENT (message-id: $MSG_ID)"

# ── Update state ─────────────────────────────────────────────────────────────

jq -n --arg h "$CURRENT_HASH" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg m "$MSG_ID" \
  '{hash: $h, last_sent_at: $t, last_message_id: $m}' > "$STATE_FILE"

log "State updated (hash=$CURRENT_HASH)"
