#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="bots"
APP_LABEL="app=nyx"
DEPLOY_NAME="nyx"
DATA_MOUNT="/data/nyx"
CREDS_PATH="${DATA_MOUNT}/creds"
HEALTH_PORT="8080"
PVC_NAME="nyx-data-pvc"
SECRET_NAME="nyx-secrets"
SECRET_KEY="whatsapp-creds-json"

info()  { echo "[nyx-repair] $*" >&2; }
die()   { echo "[nyx-repair] ERROR: $*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
nyx-repair.sh — Nyx WhatsApp bridge repair runbook

USAGE:
  nyx-repair.sh status                Show pod state, logs, creds, health
  nyx-repair.sh clear-creds           Wipe creds on PVC + empty secret, restart
  nyx-repair.sh pair <phone>          Set pairing phone, capture code, persist creds to secret
  nyx-repair.sh recover <phone>       clear-creds → pair (end-to-end re-link)
  nyx-repair.sh -h | --help           Show this help

EXIT CODES:
  0  Success
  1  Nyx is broken / unhealthy
  2  User error (bad args)
  3  Cluster error (kubectl missing/unreachable)
USAGE
  exit "${1:-0}"
}

preflight() {
  command -v kubectl &>/dev/null || { echo "[nyx-repair] kubectl not found" >&2; exit 3; }
  kubectl cluster-info &>/dev/null 2>&1 || { echo "[nyx-repair] cluster unreachable" >&2; exit 3; }
}

get_pod_name() {
  local name
  name=$(kubectl get pods -n "$NAMESPACE" -l "$APP_LABEL" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
  [ -n "$name" ] || die "no nyx pod found in namespace $NAMESPACE"
  echo "$name"
}

# Empty the WhatsApp creds in the secret. Without this, the entrypoint
# re-bootstraps stale/logged-out creds from the secret on every restart, which
# defeats a PVC-only clear and produces an unbreakable 401-logout CrashLoop.
clear_secret_creds() {
  info "Emptying secret ${SECRET_NAME}/${SECRET_KEY} (stops re-bootstrap of dead creds)..."
  kubectl patch secret "$SECRET_NAME" -n "$NAMESPACE" --type merge \
    -p "{\"data\":{\"${SECRET_KEY}\":\"\"}}" >/dev/null
  info "Secret creds emptied."
}

# Persist the live, freshly-paired creds.json from the pod's PVC back into the
# secret, so a future pod reschedule (PVC loss) bootstraps GOOD creds instead of
# forcing a manual re-pair.
persist_creds_to_secret() {
  local pod creds_b64
  pod=$(get_pod_name)
  creds_b64=$(kubectl exec -n "$NAMESPACE" "$pod" -- cat "${CREDS_PATH}/creds.json" 2>/dev/null | base64 -w0) || true
  if [ -z "$creds_b64" ]; then
    info "WARN: could not read ${CREDS_PATH}/creds.json from pod — secret NOT updated."
    info "      Fresh creds live on the PVC; re-pair will be needed if the PVC is lost."
    return 1
  fi
  info "Persisting fresh creds.json back into secret ${SECRET_NAME}/${SECRET_KEY}..."
  kubectl patch secret "$SECRET_NAME" -n "$NAMESPACE" --type merge \
    -p "{\"data\":{\"${SECRET_KEY}\":\"${creds_b64}\"}}" >/dev/null
  info "Secret updated with fresh creds."
}

cmd_status() {
  preflight
  local pod
  pod=$(get_pod_name)

  info "=== Pod Info ==="
  kubectl get pod -n "$NAMESPACE" "$pod" -o wide 2>&1 | sed 's/^/  /'

  local phase ready restarts age
  phase=$(kubectl get pod -n "$NAMESPACE" "$pod" -o jsonpath='{.status.phase}')
  ready=$(kubectl get pod -n "$NAMESPACE" "$pod" -o jsonpath='{.status.containerStatuses[0].ready}')
  restarts=$(kubectl get pod -n "$NAMESPACE" "$pod" -o jsonpath='{.status.containerStatuses[0].restartCount}')
  age=$(kubectl get pod -n "$NAMESPACE" "$pod" -o jsonpath='{.metadata.creationTimestamp}')
  info "phase=$phase ready=$ready restarts=$restarts created=$age"

  info ""
  info "=== Last 50 Log Lines ==="
  kubectl logs -n "$NAMESPACE" "$pod" --tail=50 2>&1 | sed 's/^/  /'

  info ""
  info "=== Creds Directory ==="
  kubectl exec -n "$NAMESPACE" "$pod" -- ls -la "$CREDS_PATH" 2>/dev/null | sed 's/^/  /' || info "  NO_CREDS (directory missing)"

  info ""
  info "=== Health Endpoint ==="
  local health_body health_code
  health_body=$(kubectl exec -n "$NAMESPACE" "$pod" -- curl -s --max-time 5 "http://localhost:${HEALTH_PORT}/" 2>/dev/null) || health_body="(unreachable)"
  health_code=$(kubectl exec -n "$NAMESPACE" "$pod" -- curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:${HEALTH_PORT}/" 2>/dev/null) || health_code="000"
  info "  HTTP $health_code"
  echo "$health_body" | sed 's/^/  /' >&2

  info ""
  info "=== Active Token ==="
  local token_env
  token_env=$(kubectl get deployment -n "$NAMESPACE" "$DEPLOY_NAME" -o jsonpath='{.spec.template.spec.containers[0].env}' 2>/dev/null | \
    jq -r '[.[] | select(.name | test("TOKEN|CLAUDE")) | .name] | join(", ")' 2>/dev/null) || token_env="(could not read)"
  info "  Token env vars present: ${token_env:-none}"

  if [ "$phase" = "Running" ] && [ "$ready" = "true" ]; then
    info ""
    info "Status: HEALTHY"
    return 0
  else
    info ""
    info "Status: UNHEALTHY (phase=$phase ready=$ready)"
    return 1
  fi
}

cmd_clear_creds() {
  preflight
  info "Wiping creds at $CREDS_PATH via busybox debug pod..."

  local run_name="clear-creds-$$"
  local overrides
  overrides=$(cat <<OJSON
{
  "spec": {
    "containers": [{
      "name": "clear-creds",
      "image": "busybox:latest",
      "command": ["sh", "-c", "rm -rf ${CREDS_PATH} && echo CLEARED"],
      "volumeMounts": [{
        "name": "nyx-data",
        "mountPath": "${DATA_MOUNT}"
      }]
    }],
    "volumes": [{
      "name": "nyx-data",
      "persistentVolumeClaim": {
        "claimName": "${PVC_NAME}"
      }
    }],
    "restartPolicy": "Never"
  }
}
OJSON
)

  kubectl run -n "$NAMESPACE" --restart=Never --rm -i "$run_name" \
    --image=busybox:latest --overrides="$overrides" \
    -- sh -c "rm -rf ${CREDS_PATH} && echo CLEARED" 2>&1

  # Also empty the secret — otherwise the entrypoint re-bootstraps the dead
  # creds onto the freshly-wiped PVC and the 401-logout loop continues.
  clear_secret_creds

  info "Restarting deployment..."
  kubectl rollout restart deployment/"$DEPLOY_NAME" -n "$NAMESPACE"
  kubectl rollout status deployment/"$DEPLOY_NAME" -n "$NAMESPACE" --timeout=120s
  info "Creds cleared and pod restarted."
}

cmd_pair() {
  local phone="${1:-}"
  [ -n "$phone" ] || { echo "[nyx-repair] Usage: nyx-repair.sh pair <phone-number>" >&2; exit 2; }

  if ! [[ "$phone" =~ ^[0-9]{10,15}$ ]]; then
    die "Invalid phone number: '$phone'. Must be 10-15 digits with country code, no +."
  fi

  preflight

  info "Setting BRIDGE_PAIRING_PHONE=$phone on deployment..."
  kubectl set env deployment/"$DEPLOY_NAME" -n "$NAMESPACE" "BRIDGE_PAIRING_PHONE=$phone"

  info "Waiting for rollout..."
  kubectl rollout status deployment/"$DEPLOY_NAME" -n "$NAMESPACE" --timeout=60s

  info "Tailing logs for pairing code (timeout 90s)..."
  local code=""
  local start_ts
  start_ts=$(date +%s)

  while true; do
    local now
    now=$(date +%s)
    local elapsed=$((now - start_ts))
    [ "$elapsed" -lt 90 ] || break

    local line
    line=$(kubectl logs -n "$NAMESPACE" -l "$APP_LABEL" --tail=20 2>/dev/null | \
      grep -oP '>>> WhatsApp pairing code for [^:]+: \K[A-Z0-9-]+' | tail -1) || true

    if [ -n "$line" ]; then
      code="$line"
      break
    fi
    sleep 3
  done

  if [ -z "$code" ]; then
    info "Timed out waiting for pairing code. Check logs manually."
    info "The BRIDGE_PAIRING_PHONE env var is still set — re-run pair to try again."
    exit 1
  fi

  # Print code prominently to stdout (pipe-able)
  echo ""
  echo "=========================================="
  echo "  PAIRING CODE:  $code"
  echo "=========================================="
  echo ""
  info "Enter this code on your phone: WhatsApp > Linked Devices > Link a Device > Link with phone number"

  info "Waiting for WhatsApp connection (timeout 2 min)..."
  start_ts=$(date +%s)
  local connected=false

  while true; do
    local now
    now=$(date +%s)
    local elapsed=$((now - start_ts))
    [ "$elapsed" -lt 120 ] || break

    if kubectl logs -n "$NAMESPACE" -l "$APP_LABEL" --tail=20 2>/dev/null | grep -q "WhatsApp connected"; then
      connected=true
      break
    fi
    sleep 5
  done

  if $connected; then
    info "WhatsApp connected! Persisting fresh creds to secret..."
    persist_creds_to_secret || true
    info "Cleaning up env var..."
    kubectl set env deployment/"$DEPLOY_NAME" -n "$NAMESPACE" "BRIDGE_PAIRING_PHONE-"
    info "Done. Nyx is paired and running."
  else
    info "Pairing not confirmed within 2 min."
    info "BRIDGE_PAIRING_PHONE is still set — if pairing succeeds later, run:"
    info "  kubectl set env deployment/$DEPLOY_NAME -n $NAMESPACE BRIDGE_PAIRING_PHONE-"
    exit 1
  fi
}

cmd_recover() {
  local phone="${1:-}"
  [ -n "$phone" ] || { echo "[nyx-repair] Usage: nyx-repair.sh recover <phone-number>" >&2; exit 2; }

  info "=== RECOVER: Full re-link sequence ==="
  info "Step 1/2: Clearing creds..."
  cmd_clear_creds

  info ""
  info "Waiting for pod to settle (10s)..."
  sleep 10

  info "Step 2/2: Pairing..."
  cmd_pair "$phone"
}

case "${1:-}" in
  status)      cmd_status ;;
  clear-creds) cmd_clear_creds ;;
  pair)        cmd_pair "${2:-}" ;;
  recover)     cmd_recover "${2:-}" ;;
  -h|--help)   usage 0 ;;
  "")          usage 2 ;;
  *)           echo "[nyx-repair] Unknown command: $1" >&2; usage 2 ;;
esac
