# Kubernetes Deployment

Manifests for deploying nyx (Claude Code + Baileys) and perhitbot (openclaw) in the `bots` namespace.

## ⚠️ Token Safety — Read Before Doing Anything

`nyx-claude-token` is a **separate, long-lived secret** (valid ~1 year) managed independently
from all other setup steps. It is **never** in `nyx-secret.yaml` and is **never** touched by
`kubectl apply -f deploy/k8s/`.

**The only safe way to update it:**
```bash
claude setup-token          # interactive — generates a 1-year token
./deploy/k8s/rotate-nyx-token.sh <token>   # updates secret + restarts pod
```

**Never do this** — it installs a short-lived (~8h) access token that causes auth failures:
```bash
# ❌ WRONG — this is the short-lived OAuth access token
kubectl create secret generic nyx-claude-token -n bots \
  --from-literal=oauth-token="$(cat ~/.claude/.credentials.json | jq -r '.claudeAiOauth.accessToken')"
```

**Safe operations that do NOT affect the token:**
- `kubectl apply -f deploy/k8s/nyx-secret.yaml` — only touches `nyx-secrets`
- `kubectl apply -f deploy/k8s/nyx.yaml` — only touches deployment + PVC
- `docker build` + `kubectl rollout restart` — pod reads existing secret, no change
- Any image rebuild or code update

---

## Apply Order (fresh cluster)

```bash
# 1. Namespace first
kubectl apply -f deploy/k8s/namespace.yaml

# 2. nyx-secrets (WhatsApp, Linear, Groq, mayor-bridge)
#    Edit nyx-secret.yaml: replace REPLACE_WITH_* placeholders first
kubectl apply -f deploy/k8s/nyx-secret.yaml

# 3. nyx-claude-token — DO THIS SEPARATELY, not with the others
claude setup-token
./deploy/k8s/rotate-nyx-token.sh <token-from-above>

# 4. Deployments (includes PVC)
kubectl apply -f deploy/k8s/nyx.yaml
kubectl apply -f deploy/k8s/perhitbot.yaml
```

## Verify

```bash
kubectl -n bots get pods
kubectl -n bots logs -f <pod-name>   # first line should be "[nyx] claude auth OK"
kubectl -n bots get secret nyx-claude-token -o jsonpath='{.metadata.annotations}'
```

## Routine Operations

### Rebuild image + redeploy (safe — token unaffected)

```bash
cd <repo-root>
docker build -t nyx-claude:latest -f deploy/docker/Dockerfile.nyx-claude .
kubectl rollout restart deployment/nyx -n bots
kubectl rollout status deployment/nyx -n bots
```

### Rotate Claude token (annual, or after auth failures)

```bash
claude setup-token
./deploy/k8s/rotate-nyx-token.sh <token>
```

### Update nyx-secrets (WhatsApp ACL, Linear key, etc.)

```bash
# Edit deploy/k8s/nyx-secret.yaml then:
kubectl apply -f deploy/k8s/nyx-secret.yaml
kubectl rollout restart deployment/nyx -n bots   # pick up new env vars
```

## Secret Setup (fresh cluster only)

### nyx WhatsApp credentials (`whatsapp-creds-json`)

After pairing nyx with the charlie WhatsApp account on first run:

```bash
cat /data/nyx/creds/creds.json | base64 -w0
# Paste into nyx-secret.yaml: whatsapp-creds-json
```

### Mayor bridge token

Must match `MAYOR_BRIDGE_TOKEN` in `/data/mayor-bridge/secrets.env` on the host.

## Design Notes

- **Recreate strategy** — ReadWriteOnce PVC for session files. RollingUpdate would leave the old pod holding the volume.
- **PVC at `/data/nyx`** — Baileys creds + conversation history survive pod restarts.
- **Claude auth via `CLAUDE_CODE_OAUTH_TOKEN`** — injected from `nyx-claude-token` secret. NOT from `credentials.json`.
- **Mayor bridge** — runs on the host as a systemd service, not inside the container.

---

## Imperative deploy state (apply after `nyx.yaml`)

`nyx.yaml` deploys the bare pod + PVC + env vars. The live deployment additionally has
**five configMaps** and an extended set of **volumes / volumeMounts** that were created
imperatively and are not yet captured in the manifest. Until they are, run these after
any `kubectl apply -f nyx.yaml` to restore parity with prod:

```bash
# 1. ConfigMaps that back the live subPath mounts (built from this repo)
cd <repo-root>
kubectl create configmap nyx-bridge-code -n bots \
  --from-file=baileys-bridge.js=deploy/baileys/baileys-bridge.js \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl create configmap nyx-to-linear-code -n bots \
  --from-file=nyx-to-linear=deploy/mayor-bridge/nyx-to-linear \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl create configmap nyx-store-code -n bots \
  --from-file=nyx-store=deploy/mayor-bridge/nyx-store \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl create configmap nyx-files-code -n bots \
  --from-file=nyx-files=deploy/mayor-bridge/nyx-files \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl create configmap nyx-claude-md -n bots \
  --from-file=CLAUDE.md=deploy/claude-config/nyx/CLAUDE.md \
  --dry-run=client -o yaml | kubectl apply -f -

# 2. Patch the deployment with the configMap volumes + mounts the live pod has
kubectl -n bots patch deployment nyx --type=strategic -p '{
  "spec": {"template": {"spec": {
    "containers": [{
      "name": "nyx",
      "volumeMounts": [
        {"name": "bridge-code",        "mountPath": "/app/baileys-bridge.js",      "subPath": "baileys-bridge.js"},
        {"name": "nyx-to-linear-code", "mountPath": "/usr/local/bin/nyx-to-linear","subPath": "nyx-to-linear"},
        {"name": "nyx-store-code",     "mountPath": "/usr/local/bin/nyx-store",    "subPath": "nyx-store"},
        {"name": "nyx-files-code",     "mountPath": "/usr/local/bin/nyx-files",    "subPath": "nyx-files"},
        {"name": "claude-md",          "mountPath": "/app/CLAUDE.md",              "subPath": "CLAUDE.md"}
      ]
    }],
    "volumes": [
      {"name": "bridge-code",        "configMap": {"name": "nyx-bridge-code",    "defaultMode": 420}},
      {"name": "nyx-to-linear-code", "configMap": {"name": "nyx-to-linear-code", "defaultMode": 493}},
      {"name": "nyx-store-code",     "configMap": {"name": "nyx-store-code",     "defaultMode": 493}},
      {"name": "nyx-files-code",     "configMap": {"name": "nyx-files-code",     "defaultMode": 493}},
      {"name": "claude-md",          "configMap": {"name": "nyx-claude-md",      "defaultMode": 420}}
    ]
  }}}
}'

# 3. Memory headroom for buffering ≤ 100 MB media uploads
kubectl -n bots set resources deployment/nyx \
  --limits=memory=2Gi --requests=memory=512Mi
```

### Building & loading the image (this node has no `nerdctl`)

`docker build` writes to docker's own image store; the kubelet (containerd CRI) does
**not** see those tags. To make a freshly built image available to the pod:

```bash
docker build --provenance=false --sbom=false \
  -t nyx-claude:latest -f deploy/docker/Dockerfile.nyx-claude .
docker save -o /tmp/nyx-claude.tar nyx-claude:latest
sudo ctr -n k8s.io images import /tmp/nyx-claude.tar
rm /tmp/nyx-claude.tar
kubectl -n bots rollout restart deployment/nyx
```

The `--provenance=false --sbom=false` flags matter — without them buildkit emits an OCI
index that `ctr import` mangles into a `"nyx claude"` tag (with a space) and CRI keeps
the old `:latest`.

## Deferred resilience work (tracked here so it isn't forgotten)

These gaps mean a totally fresh cluster + machine cannot rebuild nyx from this repo
alone without the steps above (and some human inputs). Worth automating later:

- **ConfigMaps → repo manifests** — capture the five configMaps as YAML so they're
  GitOps-managed instead of imperative.
- **`nyx.yaml` reconciliation** — fold the volumes / mounts / 2Gi memory back into the
  manifest so the WARNING comment can be removed and `kubectl apply` is non-destructive.
- **WhatsApp creds backup** — `backup-wa-creds.sh` runs by hand; the
  `nyx-wa-creds-backup` secret on this cluster is stale by weeks. Re-pairing requires
  Kanaba's phone, so this is the hardest-to-recover datum on the system. Add a CronJob.
- **PVC backup** — `/data/nyx/` (Baileys creds, conversations, memory vault, files.db)
  has no ongoing backup. `files.db` (dropbox index) is rebuildable from Drive +
  storagebox listings; the memory vault is not.
- **Secrets bootstrap docs** — no `env.example` for the eight `nyx-secrets` keys or for
  the host-side `mayor-bridge` `secrets.env` (keys observed: `MAYOR_BRIDGE_TOKEN`,
  `INGEST_TOKEN`, `NYX_BRIDGE_URL`, `GCP_PROJECT`, `GMAIL_SUBSCRIPTION`,
  `GMAIL_PUBSUB_TOPIC`, `GOG_KEYRING_PASSWORD`).
- **`nyx-gmail-watcher.service` not installed** on the GT2 host — the unit file is
  committed under `deploy/mayor-bridge/` but `systemctl` doesn't know about it; install
  + enable to actually deliver inbox alerts.
- **Sibling checkouts** — `nyx_one/mayor/rig` (1 file) and `nyx_one/refinery/rig`
  (5 files) have their own divergent uncommitted state. They are not the deployment
  source (which is `crew/nyx`) but worth a separate sweep.
