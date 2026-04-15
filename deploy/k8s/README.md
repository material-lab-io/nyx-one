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
