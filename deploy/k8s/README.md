# Kubernetes Deployment

Manifests for deploying nyx (Claude Code + Baileys) and perhitbot (openclaw) in the `bots` namespace.

## Apply Order

```bash
# 1. Namespace first
kubectl apply -f deploy/k8s/namespace.yaml

# 2. Secrets — fill in real values before applying
#    Edit nyx-secret.yaml: replace REPLACE_WITH_* placeholders
#    See "Secret setup" below for how to generate values
kubectl apply -f deploy/k8s/nyx-secret.yaml
kubectl apply -f deploy/k8s/perhitbot-secret.yaml

# 3. Deployments (includes PVC in same file)
kubectl apply -f deploy/k8s/nyx.yaml
kubectl apply -f deploy/k8s/perhitbot.yaml
```

## Verify

```bash
kubectl -n bots get pods
kubectl -n bots describe pod <pod-name>
kubectl -n bots logs -f <pod-name>
```

## Secret Setup

### nyx WhatsApp credentials (`whatsapp-creds-json`)

After pairing nyx with the charlie WhatsApp account on first run:

```bash
# Copy creds from container/data dir
cat /data/nyx/creds/creds.json | base64 -w0
# Paste into nyx-secret.yaml: whatsapp-creds-json
```

### Claude Code credentials (`nyx-claude-creds`)

```bash
# Authenticate on host first:
claude auth login

# Then extract:
kubectl create secret generic nyx-claude-creds \
  -n bots \
  --from-file=credentials.json=$HOME/.claude/credentials.json
```

Or manually base64-encode and add to `nyx-secret.yaml`.

### Mayor bridge token

Must match `MAYOR_BRIDGE_TOKEN` in `/data/mayor-bridge/secrets.env` on the host.

## Image Build

Build the nyx image from repo root:

```bash
docker build -t nyx-claude:latest -f deploy/docker/Dockerfile.nyx-claude .
```

Then update the `image:` field in `nyx.yaml` to your registry path and push.

## Design Notes

- **Recreate strategy** — ReadWriteOnce PVC for session files. RollingUpdate would leave the old pod holding the volume.
- **PVC at `/data/nyx`** — Baileys creds + conversation history survive pod restarts.
- **Claude credentials via secret** — `~/.claude/credentials.json` mounted from k8s secret.
- **No HTTP port** — nyx-claude doesn't expose an HTTP endpoint; health check uses `pgrep`.
- **Mayor bridge** — runs on the host as a systemd service (`deploy/mayor-bridge/mayor-bridge.service`), not inside the container.
