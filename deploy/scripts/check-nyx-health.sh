#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="bots"
APP_LABEL="app=nyx"
HEALTH_PORT="8080"
STATE_DIR="/var/lib/gt"
[ -w "$STATE_DIR" ] 2>/dev/null || STATE_DIR="${HOME}/.local/state/gt"
mkdir -p "$STATE_DIR"
STATE_FILE="${STATE_DIR}/nyx-health-state.json"
ESCALATE_COOLDOWN=14400  # 4 hours
RESTART_THRESHOLD=3
CONSECUTIVE_UNHEALTHY_THRESHOLD=3
GT_DIR="${HOME}/gt"
MAYOR_BRIDGE_TOKEN_FILE="${HOME}/.config/gt/mayor-bridge-token"
MAYOR_BRIDGE_CANONICAL="/home/kanaba/gt/nyx_one/crew/nyx/deploy/mayor-bridge/mayor-bridge.js"
STALE_DAYS=7

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

read_state() {
  if [ -f "$STATE_FILE" ]; then
    cat "$STATE_FILE"
  else
    echo '{"escalations":{}}'
  fi
}

write_state() { echo "$1" > "$STATE_FILE"; }

jq_or_default() {
  local json="$1" key="$2" default="$3"
  echo "$json" | jq -r "$key // \"$default\"" 2>/dev/null || echo "$default"
}

# Per-symptom de-spam: returns 0 (should escalate) or 1 (suppressed)
should_escalate() {
  local sym_hash="$1"
  local last_ts
  last_ts=$(echo "$state" | jq -r ".escalations[\"$sym_hash\"] // 0" 2>/dev/null || echo "0")
  if [ $((now - last_ts)) -ge $ESCALATE_COOLDOWN ]; then
    return 0
  fi
  return 1
}

record_escalation() {
  local sym_hash="$1"
  state=$(echo "$state" | jq --arg h "$sym_hash" --argjson t "$now" '.escalations[$h] = $t')
}

do_escalate() {
  local sev="$1" msg="$2" symptom="$3"
  local sym_hash
  sym_hash=$(echo -n "$symptom" | md5sum | cut -d' ' -f1)
  if should_escalate "$sym_hash"; then
    log "ESCALATING: severity=$sev symptom='$symptom'"
    cd "$GT_DIR/mayor/rig" 2>/dev/null && \
      gt escalate -s "$sev" "$msg" || true
    record_escalation "$sym_hash"
  else
    log "suppressed escalation (de-spam): '$symptom' within cooldown"
  fi
}

now=$(date +%s)
state=$(read_state)

# Migrate old state format (single hash/ts) to new per-symptom format
if ! echo "$state" | jq -e '.escalations' &>/dev/null; then
  old_hash=$(jq_or_default "$state" '.last_symptom_hash' '')
  old_ts=$(jq_or_default "$state" '.last_escalation_ts' '0')
  if [ -n "$old_hash" ] && [ "$old_ts" != "0" ]; then
    state=$(echo "$state" | jq --arg h "$old_hash" --argjson t "$old_ts" '. + {escalations: {($h): $t}}')
  else
    state=$(echo "$state" | jq '. + {escalations: {}}')
  fi
fi

# ── Nyx pod health ────────────────────────────────────────────────────────────

check_nyx_pod() {
  if ! command -v kubectl &>/dev/null; then
    log "kubectl not found — skipping pod checks"
    return
  fi
  if ! kubectl cluster-info &>/dev/null 2>&1; then
    log "cluster unreachable — skipping pod checks"
    return
  fi

  local pod_json pod_count
  pod_json=$(kubectl get pods -n "$NAMESPACE" -l "$APP_LABEL" -o json 2>/dev/null || echo '{"items":[]}')
  pod_count=$(echo "$pod_json" | jq '.items | length')

  if [ "$pod_count" -eq 0 ]; then
    log "CRITICAL: no nyx pod found in namespace $NAMESPACE"
    do_escalate CRITICAL \
      "nyx: pod missing from namespace $NAMESPACE — no pods with label $APP_LABEL" \
      "nyx-pod-missing"
    return
  fi

  local pod_info pod_name pod_phase pod_ready restart_count pod_start
  pod_info=$(echo "$pod_json" | jq -r '[.items[] | {
    name: .metadata.name,
    phase: .status.phase,
    ready: (if (.status.containerStatuses // [] | length) > 0 then (.status.containerStatuses[0].ready // false) else false end),
    restartCount: (if (.status.containerStatuses // [] | length) > 0 then (.status.containerStatuses[0].restartCount // 0) else 0 end),
    startTime: .metadata.creationTimestamp
  }] | sort_by(.startTime) | last')

  pod_name=$(echo "$pod_info" | jq -r '.name')
  pod_phase=$(echo "$pod_info" | jq -r '.phase')
  pod_ready=$(echo "$pod_info" | jq -r '.ready')
  restart_count=$(echo "$pod_info" | jq -r '.restartCount')
  pod_start=$(echo "$pod_info" | jq -r '.startTime')

  log "pod=$pod_name phase=$pod_phase ready=$pod_ready restarts=$restart_count start=$pod_start"

  local health_code=0
  health_code=$(kubectl exec -n "$NAMESPACE" "$pod_name" -- \
    curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:${HEALTH_PORT}/" 2>/dev/null) || health_code=0
  log "health_probe=$health_code"

  local prev_restarts prev_restart_ts unhealthy_streak
  prev_restarts=$(jq_or_default "$state" '.restart_count' '0')
  prev_restart_ts=$(jq_or_default "$state" '.restart_check_ts' "$now")
  unhealthy_streak=$(jq_or_default "$state" '.unhealthy_streak' '0')

  local restart_delta=$((restart_count - prev_restarts))
  if [ "$restart_delta" -lt 0 ]; then restart_delta=0; fi
  local restart_window=$((now - prev_restart_ts))

  if [ "$pod_phase" != "Running" ]; then
    local pod_start_epoch age_seconds
    pod_start_epoch=$(date -d "$pod_start" +%s 2>/dev/null || echo "$now")
    age_seconds=$((now - pod_start_epoch))
    if [ "$age_seconds" -gt 300 ]; then
      do_escalate HIGH \
        "nyx: not-running phase=$pod_phase for ${age_seconds}s (pod=$pod_name, restarts=$restart_count)" \
        "nyx-not-running"
    fi
  fi

  if [ "$restart_delta" -ge "$RESTART_THRESHOLD" ] && [ "$restart_window" -le 900 ]; then
    do_escalate HIGH \
      "nyx: restart-storm delta=$restart_delta in ${restart_window}s (pod=$pod_name, restarts=$restart_count, last_health=$health_code)" \
      "nyx-restart-storm"
  fi

  if [ "$health_code" -ge 200 ] && [ "$health_code" -lt 300 ]; then
    unhealthy_streak=0
  else
    unhealthy_streak=$((unhealthy_streak + 1))
    if [ "$unhealthy_streak" -ge "$CONSECUTIVE_UNHEALTHY_THRESHOLD" ]; then
      do_escalate HIGH \
        "nyx: unhealthy-probe streak=$unhealthy_streak last_code=$health_code (pod=$pod_name, restarts=$restart_count)" \
        "nyx-unhealthy-probe"
    fi
  fi

  state=$(echo "$state" | jq \
    --argjson rc "$restart_count" \
    --argjson ts "$now" \
    --argjson us "$unhealthy_streak" \
    '. + {restart_count: $rc, restart_check_ts: $ts, unhealthy_streak: $us}')
}

# ── Mayor-bridge health ──────────────────────────────────────────────────────

check_mayor_bridge() {
  log "--- mayor-bridge checks ---"

  # 1. systemd unit active
  local svc_state
  svc_state=$(systemctl is-active mayor-bridge 2>/dev/null || echo "inactive")
  log "mayor-bridge systemd=$svc_state"
  if [ "$svc_state" != "active" ]; then
    do_escalate HIGH \
      "mayor-bridge: systemd unit not active (state=$svc_state)" \
      "mayor-bridge-not-active"
    return
  fi

  # 2. Port 19000 listening
  if ! ss -tln | grep -q ':19000 '; then
    log "mayor-bridge: port 19000 not listening"
    do_escalate HIGH \
      "mayor-bridge: port 19000 not listening despite systemd=active" \
      "mayor-bridge-port-down"
    return
  fi
  log "mayor-bridge port=19000 listening"

  # 3. Smoke test: POST /drive/list
  if [ -f "$MAYOR_BRIDGE_TOKEN_FILE" ]; then
    local token smoke_body smoke_code
    token=$(cat "$MAYOR_BRIDGE_TOKEN_FILE")
    smoke_code=$(curl -s -o /tmp/mayor-bridge-smoke.$$ -w '%{http_code}' --max-time 10 \
      -X POST http://localhost:19000/drive/list \
      -H "Authorization: Bearer $token" \
      -H "Content-Type: application/json" \
      -d '{"max":1}' 2>/dev/null) || smoke_code=0
    smoke_body=$(cat /tmp/mayor-bridge-smoke.$$ 2>/dev/null || echo "")
    rm -f /tmp/mayor-bridge-smoke.$$

    log "mayor-bridge smoke_test=$smoke_code"

    if [ "$smoke_body" = "Not found" ]; then
      do_escalate HIGH \
        "mayor-bridge: stale build (no /drive endpoints — HTTP body='Not found')" \
        "mayor-bridge-stale-no-drive"
    elif [ "$smoke_code" -lt 200 ] || [ "$smoke_code" -ge 300 ]; then
      do_escalate HIGH \
        "mayor-bridge: /drive/list returned HTTP $smoke_code" \
        "mayor-bridge-drive-error"
    else
      log "mayor-bridge /drive/list OK"
    fi
  else
    log "mayor-bridge: token file not found at $MAYOR_BRIDGE_TOKEN_FILE — skipping smoke test"
  fi

  # 4. Version/mtime assertion
  local pid js_path running_mtime canonical_mtime age_diff
  pid=$(systemctl show mayor-bridge -p MainPID --value 2>/dev/null || echo "0")
  if [ "$pid" != "0" ] && [ -d "/proc/$pid" ]; then
    js_path=$(tr '\0' '\n' < "/proc/$pid/cmdline" 2>/dev/null | grep '\.js$' | head -1) || js_path=""
    if [ -n "$js_path" ] && [ -f "$js_path" ]; then
      running_mtime=$(stat -c '%Y' "$js_path" 2>/dev/null || echo "0")
    else
      running_mtime=0
    fi
  else
    running_mtime=0
  fi

  if [ -f "$MAYOR_BRIDGE_CANONICAL" ]; then
    canonical_mtime=$(stat -c '%Y' "$MAYOR_BRIDGE_CANONICAL" 2>/dev/null || echo "0")
  else
    canonical_mtime=0
  fi

  if [ "$running_mtime" -gt 0 ] && [ "$canonical_mtime" -gt 0 ]; then
    age_diff=$((canonical_mtime - running_mtime))
    local stale_threshold=$((STALE_DAYS * 86400))
    if [ "$age_diff" -gt "$stale_threshold" ]; then
      local running_date canonical_date
      running_date=$(date -d "@$running_mtime" +%Y-%m-%d 2>/dev/null || echo "$running_mtime")
      canonical_date=$(date -d "@$canonical_mtime" +%Y-%m-%d 2>/dev/null || echo "$canonical_mtime")
      do_escalate HIGH \
        "mayor-bridge: stale build (running mtime=$running_date, canonical mtime=$canonical_date, delta=${age_diff}s)" \
        "mayor-bridge-stale-mtime"
    else
      log "mayor-bridge version mtime OK (delta=${age_diff}s)"
    fi
  else
    log "mayor-bridge: could not compare mtimes (running=$running_mtime, canonical=$canonical_mtime)"
  fi

  log "mayor-bridge healthy"
}

# ── Run all checks ───────────────────────────────────────────────────────────

check_nyx_pod
check_mayor_bridge

# Summary
nyx_healthy=true
echo "$state" | jq -e '.unhealthy_streak > 0' &>/dev/null && nyx_healthy=false
if $nyx_healthy; then
  log "all checks passed"
else
  log "issues detected (see above)"
fi

write_state "$state"

# --install: add crontab entry + document token setup
if [ "${1:-}" = "--install" ]; then
  SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  LOG_PATH="/var/log/nyx-health.log"
  if ! touch "$LOG_PATH" 2>/dev/null; then
    LOG_PATH="${HOME}/.local/var/log/nyx-health.log"
    mkdir -p "$(dirname "$LOG_PATH")"
  fi
  CRON_LINE="*/5 * * * * ${SCRIPT_PATH} >> ${LOG_PATH} 2>&1"
  if crontab -l 2>/dev/null | grep -qF "check-nyx-health.sh"; then
    log "--install: crontab entry already exists"
  else
    (crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -
    log "--install: crontab entry added"
  fi
  # Token setup reminder
  if [ ! -f "$MAYOR_BRIDGE_TOKEN_FILE" ]; then
    log "--install: NOTE — mayor-bridge smoke test requires token at $MAYOR_BRIDGE_TOKEN_FILE"
    log "  Run: mkdir -p ~/.config/gt && sudo grep '^MAYOR_BRIDGE_TOKEN=' /data/mayor-bridge/secrets.env | cut -d= -f2- > ~/.config/gt/mayor-bridge-token && chmod 600 ~/.config/gt/mayor-bridge-token"
  fi
fi
