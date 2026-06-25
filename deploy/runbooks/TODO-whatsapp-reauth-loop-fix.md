# TODO: nyx-repair.sh can't break the 401-logout CrashLoop (dead creds persist in secret)

**Filed:** 2026-06-25 by crew/nyx (bd create blocked by Dolt schema-migration error; recorded here instead)

## Root cause (caused a 2-day outage, 365 restarts 2026-06-23..25)
On WhatsApp 401 `loggedOut`, `baileys-bridge.js` wipes PVC creds (`/data/nyx/creds`) and `process.exit(1)`.
But `entrypoint-bridge.sh` re-bootstraps `creds.json` from secret `nyx-secrets/whatsapp-creds-json`
whenever the PVC file is missing. If the secret still holds the dead/logged-out creds, every restart
restores them -> instant re-login -> 401 -> wipe -> CrashLoopBackOff forever.

The pairing path (`if PAIRING_PHONE && !state.creds.registered`) only fires when creds are NOT
registered. Dead creds are still `registered:true`, so `BRIDGE_PAIRING_PHONE` never triggers and
`nyx-repair.sh recover` (clears PVC only, not the secret) CANNOT self-heal.

## Manual fix applied 2026-06-25
1. `kubectl patch secret nyx-secrets -n bots --type merge -p '{"data":{"whatsapp-creds-json":""}}'`  (empty dead creds)
2. `kubectl set env deployment/nyx -n bots BRIDGE_PAIRING_PHONE=919187520828`  (force pairing-code mode)
3. Captured pairing code from logs, entered on phone (WhatsApp > Linked Devices > Link with phone number)
4. After "WhatsApp connected": persisted fresh `/data/nyx/creds/creds.json` back into the secret
5. `kubectl set env deployment/nyx -n bots BRIDGE_PAIRING_PHONE-`  (clean state); validated clean restart

## Fix needed
- `nyx-repair.sh clear-creds`/`recover` must ALSO empty (or re-pair+persist) the `whatsapp-creds-json`
  secret key, not just the PVC.
- After a successful pair, auto-persist fresh `creds.json` back into the secret so restarts survive.
- Add a guard: `pair` should empty the secret first so the entrypoint doesn't re-bootstrap dead creds.
