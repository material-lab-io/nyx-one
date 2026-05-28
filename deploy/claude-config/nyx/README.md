# nyx Claude Code config

`CLAUDE.md` is nyx's identity + capability brief, baked into the container image at
`/app/CLAUDE.md` (Dockerfile `COPY`) and also mounted at runtime from the
`nyx-claude-md` configMap so updates can ship without a rebuild.

## Local-only files (gitignored)

Two files in this directory contain personal data and are deliberately **not** in git:

- **`contacts.json`** — Kanaba's personal contacts (names, phones, emails,
  relationships). Used by nyx when resolving "send this to X" requests.
- **`wiki-seed/`** — seed knowledge that bootstraps nyx's memory vault on first run
  (people, projects, decisions). Treated as PII.

Both are present on the live nyx PVC. Inside the running pod:

- `contacts.json` is consumed at agent invocation; nothing copies it onto the PVC
  automatically — the working copy lives next to the source on the host (`crew/nyx/...`)
  and is read by helpers / referenced by `CLAUDE.md`.
- The wiki-seed contents are merged into `/data/nyx/memory/vault/` on the PVC and
  evolve over time as nyx writes to memory.

## Restoring on a fresh deployment

There is **no automated PVC backup** today. If the PVC is lost, the seeded vault is
gone unless restored from a manual snapshot. If you need to recover or rebootstrap:

1. Re-place `contacts.json` and `wiki-seed/` in this directory on the host (from a
   manual backup or by rebuilding by hand).
2. The bridge will read `contacts.json` directly on next invocation.
3. Seed the vault inside the pod:
   ```bash
   POD=$(kubectl get pods -n bots -l app=nyx -o jsonpath='{.items[0].metadata.name}')
   kubectl cp deploy/claude-config/nyx/wiki-seed/ bots/$POD:/data/nyx/memory/vault/
   ```

This is fragile by design (PII shouldn't be in git). Automating PVC backup is a tracked
follow-up — see `deploy/k8s/README.md` "Deferred resilience work".
