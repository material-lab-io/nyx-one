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

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

if ! command -v kubectl &>/dev/null; then
  echo "kubectl not found" >&2; exit 0
fi
if ! kubectl cluster-info &>/dev/null 2>&1; then
  echo "no kubeconfig or cluster unreachable" >&2; exit 0
fi

read_state() {
  if [ -f "$STATE_FILE" ]; then
    cat "$STATE_FILE"
  else
    echo '{}'
  fi
}

write_state() { echo "$1" > "$STATE_FILE"; }

jq_or_default() {
  local json="$1" key="$2" default="$3"
  echo "$json" | jq -r "$key // \"$default\"" 2>/dev/null || echo "$default"
}

now=$(date +%s)

pod_json=$(kubectl get pods -n "$NAMESPACE" -l "$APP_LABEL" -o json 2>/dev/null || echo '{"items":[]}')
pod_count=$(echo "$pod_json" | jq '.items | length')

state=$(read_state)

if [ "$pod_count" -eq 0 ]; then
  log "CRITICAL: no nyx pod found in namespace $NAMESPACE"
  symptom="pod-missing"
  symptom_hash=$(echo -n "$symptom" | md5sum | cut -d' ' -f1)
  last_hash=$(jq_or_default "$state" '.last_symptom_hash' '')
  last_ts=$(jq_or_default "$state" '.last_escalation_ts' '0')
  if [ "$symptom_hash" != "$last_hash" ] || [ $((now - last_ts)) -ge $ESCALATE_COOLDOWN ]; then
    cd "$GT_DIR/mayor/rig" 2>/dev/null && \
      gt escalate -s CRITICAL "nyx: pod missing from namespace $NAMESPACE — no pods with label $APP_LABEL" || true
    state=$(echo "$state" | jq --arg h "$symptom_hash" --argjson t "$now" \
      '. + {last_symptom_hash: $h, last_escalation_ts: $t}')
  fi
  write_state "$state"
  exit 0
fi

# Take youngest pod if multiple exist
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

# HTTP health probe
health_code=0
health_code=$(kubectl exec -n "$NAMESPACE" "$pod_name" -- \
  curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:${HEALTH_PORT}/" 2>/dev/null) || health_code=0

log "health_probe=$health_code"

# Load previous state
prev_restarts=$(jq_or_default "$state" '.restart_count' '0')
prev_restart_ts=$(jq_or_default "$state" '.restart_check_ts' "$now")
unhealthy_streak=$(jq_or_default "$state" '.unhealthy_streak' '0')

# Restart delta check
restart_delta=$((restart_count - prev_restarts))
if [ "$restart_delta" -lt 0 ]; then restart_delta=0; fi
restart_window=$((now - prev_restart_ts))

# Determine severity
severity=""
symptom=""

if [ "$pod_phase" != "Running" ]; then
  pod_start_epoch=$(date -d "$pod_start" +%s 2>/dev/null || echo "$now")
  age_seconds=$((now - pod_start_epoch))
  if [ "$age_seconds" -gt 300 ]; then
    severity="HIGH"
    symptom="not-running phase=$pod_phase for ${age_seconds}s"
  fi
fi

if [ "$restart_delta" -ge "$RESTART_THRESHOLD" ] && [ "$restart_window" -le 900 ]; then
  severity="HIGH"
  symptom="restart-storm delta=$restart_delta in ${restart_window}s"
fi

if [ "$health_code" -ge 200 ] && [ "$health_code" -lt 300 ]; then
  unhealthy_streak=0
else
  unhealthy_streak=$((unhealthy_streak + 1))
  if [ "$unhealthy_streak" -ge "$CONSECUTIVE_UNHEALTHY_THRESHOLD" ]; then
    severity="HIGH"
    symptom="unhealthy-probe streak=$unhealthy_streak last_code=$health_code"
  fi
fi

# Update state
state=$(jq -n \
  --argjson rc "$restart_count" \
  --argjson ts "$now" \
  --argjson us "$unhealthy_streak" \
  --arg lsh "$(jq_or_default "$state" '.last_symptom_hash' '')" \
  --argjson let "$(jq_or_default "$state" '.last_escalation_ts' '0')" \
  '{restart_count: $rc, restart_check_ts: $ts, unhealthy_streak: $us, last_symptom_hash: $lsh, last_escalation_ts: ($let | tonumber)}')

# Escalate if needed (with de-spam)
if [ -n "$severity" ] && [ -n "$symptom" ]; then
  symptom_hash=$(echo -n "$symptom" | md5sum | cut -d' ' -f1)
  last_hash=$(echo "$state" | jq -r '.last_symptom_hash // ""')
  last_ts=$(echo "$state" | jq -r '.last_escalation_ts // 0')

  if [ "$symptom_hash" != "$last_hash" ] || [ $((now - last_ts)) -ge $ESCALATE_COOLDOWN ]; then
    log "ESCALATING: severity=$severity symptom='$symptom'"
    cd "$GT_DIR/mayor/rig" 2>/dev/null && \
      gt escalate -s "$severity" "nyx: $symptom (pod=$pod_name, restarts=$restart_count, last_health=$health_code, age=$(( (now - $(date -d "$pod_start" +%s 2>/dev/null || echo "$now")) ))s)" || true
    state=$(echo "$state" | jq --arg h "$symptom_hash" --argjson t "$now" \
      '. + {last_symptom_hash: $h, last_escalation_ts: $t}')
  else
    log "suppressed escalation (de-spam): same symptom within cooldown"
  fi
else
  log "healthy"
fi

write_state "$state"

# --install: add crontab entry
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
fi
