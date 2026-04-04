#!/bin/bash
# backup-wa-creds.sh — Backup live WhatsApp credentials from pod to k8s secret
# Run this after a successful QR scan or periodically to keep backup current.
#
# Usage: ./backup-wa-creds.sh
set -euo pipefail

NAMESPACE="${1:-bots}"
POD=$(kubectl get pod -n "$NAMESPACE" -l app=nyx -o jsonpath='{.items[0].metadata.name}')

if [ -z "$POD" ]; then
  echo "ERROR: No nyx pod found in namespace $NAMESPACE"
  exit 1
fi

echo "Backing up WhatsApp creds from $POD..."

# Create tar.gz inside the pod
kubectl exec -n "$NAMESPACE" "$POD" -- sh -c "cd /data/nyx && tar czf /tmp/creds-backup.tar.gz creds/"

# Copy to local temp
TMPFILE=$(mktemp /tmp/nyx-creds-XXXXXX.tar.gz)
kubectl cp "$NAMESPACE/$POD:/tmp/creds-backup.tar.gz" "$TMPFILE"

FILE_COUNT=$(kubectl exec -n "$NAMESPACE" "$POD" -- sh -c "ls /data/nyx/creds/ | wc -l")
FILE_SIZE=$(stat --format=%s "$TMPFILE" 2>/dev/null || stat -f%z "$TMPFILE")

# Update k8s secret
kubectl create secret generic nyx-wa-creds-backup -n "$NAMESPACE" \
  --from-file=creds-backup.tar.gz="$TMPFILE" \
  --dry-run=client -o yaml | kubectl apply -f -

rm -f "$TMPFILE"

echo "Backup complete: $FILE_COUNT files, ${FILE_SIZE} bytes → nyx-wa-creds-backup secret"
