#!/usr/bin/env python3
"""
nyx-gmail-watcher — Pull Gmail Pub/Sub notifications → POST summaries to Nyx bridge.

Responsibilities:
  1. Register (and renew) a Gmail users().watch() for the nyx@materiallab.io inbox.
  2. Long-poll the Pub/Sub pull subscription (ADC required for pubsub auth).
  3. For each notification, fetch the delta via history.list() and POST each
     new INBOX message as a summary to http://localhost:8080/ingest/email
     on the Nyx bridge (hostNetwork → localhost works because the Nyx pod
     shares the host network namespace).

Auth model:
  - Gmail ops (watch, history, messages): reuse sailor's token_nyx.json
    via gmail.auth.get_credentials('nyx'). Refresh happens automatically.
  - Pub/Sub pull: Application Default Credentials
    (`gcloud auth application-default login` on the host, once).

State:
  /data/nyx-watcher/state.json — persists last_history_id + watch_expiry
  for crash recovery and to avoid re-processing messages.
"""

import base64
import json
import logging
import os
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from urllib import error, request

import google.auth
from googleapiclient.discovery import build

# Reuse sailor's Gmail auth — token_nyx.json is already authorized for nyx@materiallab.io.
sys.path.insert(0, '/home/kanaba/gt/sailor/crew/sailor/founding-sales-skills/material-lab')
from gmail.auth import get_credentials as get_gmail_creds

# ── Config ────────────────────────────────────────────────────────────────────

GCP_PROJECT     = os.environ.get('GCP_PROJECT', 'ace-ripsaw-485511-v6')
SUBSCRIPTION    = os.environ.get('GMAIL_SUBSCRIPTION', 'nyx-gmail-sub')
PUBSUB_TOPIC    = os.environ.get(
    'GMAIL_PUBSUB_TOPIC',
    f'projects/{GCP_PROJECT}/topics/gog-gmail-watch',
)
NYX_BRIDGE_URL  = os.environ.get('NYX_BRIDGE_URL', 'http://localhost:8080')
INGEST_TOKEN    = os.environ.get('INGEST_TOKEN', '')

STATE_DIR  = os.environ.get('WATCHER_STATE_DIR', '/data/nyx-watcher')
STATE_PATH = os.path.join(STATE_DIR, 'state.json')

SUBSCRIPTION_PATH = f'projects/{GCP_PROJECT}/subscriptions/{SUBSCRIPTION}'

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
)
log = logging.getLogger('nyx-gmail-watcher')

# ── State ─────────────────────────────────────────────────────────────────────

_state_lock = threading.Lock()


def load_state():
    if os.path.exists(STATE_PATH):
        try:
            with open(STATE_PATH) as f:
                return json.load(f)
        except Exception as e:
            log.warning(f'failed to load state: {e}')
    return {}


def save_state(state):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = STATE_PATH + '.tmp'
    with _state_lock:
        with open(tmp, 'w') as f:
            json.dump(state, f, indent=2)
        os.replace(tmp, STATE_PATH)


# ── Service builders ──────────────────────────────────────────────────────────

def build_gmail_service():
    creds = get_gmail_creds('nyx')
    if creds is None:
        raise RuntimeError(
            'No valid Gmail credentials for nyx — '
            'ensure sailor has token_nyx.json (re-run sailor OAuth for nyx).'
        )
    return build('gmail', 'v1', credentials=creds, cache_discovery=False)


def build_pubsub_service():
    # ADC (gcloud auth application-default login) with pubsub scope.
    creds, _ = google.auth.default(scopes=['https://www.googleapis.com/auth/pubsub'])
    return build('pubsub', 'v1', credentials=creds, cache_discovery=False)


# ── Gmail watch lifecycle ─────────────────────────────────────────────────────

def ensure_watch(gmail_svc, state):
    """Register or renew Gmail Pub/Sub watch if expiring within 24h."""
    now = datetime.now(timezone.utc)
    expiry_str = state.get('watch_expiry')
    needs_renew = True
    if expiry_str:
        try:
            expiry = datetime.fromisoformat(expiry_str)
            if expiry.tzinfo is None:
                expiry = expiry.replace(tzinfo=timezone.utc)
            if expiry > now + timedelta(hours=24):
                needs_renew = False
        except Exception:
            pass

    if not needs_renew:
        return

    log.info(f'registering gmail watch on {PUBSUB_TOPIC}')
    result = gmail_svc.users().watch(userId='me', body={
        'topicName': PUBSUB_TOPIC,
        'labelIds': ['INBOX'],
    }).execute()
    state['watch_history_id'] = str(result.get('historyId', ''))
    exp_ms = int(result['expiration'])
    state['watch_expiry'] = datetime.fromtimestamp(exp_ms / 1000, tz=timezone.utc).isoformat()
    # Seed last_history_id on first registration so we don't replay all inbox history.
    if not state.get('last_history_id'):
        state['last_history_id'] = state['watch_history_id']
    save_state(state)
    log.info(f'watch registered; expires {state["watch_expiry"]}')


def watch_renewal_thread(state):
    """Renew Gmail watch every 12 hours (watches auto-expire at ~7 days)."""
    while True:
        time.sleep(12 * 3600)
        try:
            gmail = build_gmail_service()
            ensure_watch(gmail, state)
        except Exception as e:
            log.error(f'watch renewal failed: {e}')


# ── Message processing ────────────────────────────────────────────────────────

def _extract_plain_body(payload):
    """Walk MIME tree for first text/plain part."""
    if not payload:
        return ''
    mime = payload.get('mimeType', '')
    body = payload.get('body', {})
    if mime == 'text/plain' and body.get('data'):
        try:
            return base64.urlsafe_b64decode(body['data']).decode('utf-8', 'replace')
        except Exception:
            return ''
    for part in payload.get('parts', []) or []:
        txt = _extract_plain_body(part)
        if txt:
            return txt
    return ''


def fetch_message_summary(gmail_svc, msg_id):
    """Return a dict with msg_id, from, to, subject, snippet, body (first 1500 chars)."""
    try:
        msg = gmail_svc.users().messages().get(
            userId='me', id=msg_id, format='full'
        ).execute()
    except Exception as e:
        log.warning(f'fetch {msg_id} failed: {e}')
        return None

    headers = {
        h['name'].lower(): h['value']
        for h in msg.get('payload', {}).get('headers', [])
    }
    body_text = _extract_plain_body(msg.get('payload', {}))
    return {
        'msg_id':  msg_id,
        'from':    headers.get('from', ''),
        'to':      headers.get('to', ''),
        'subject': headers.get('subject', '(no subject)'),
        'snippet': msg.get('snippet', '')[:500],
        'body':    body_text[:1500],
    }


def post_to_nyx(summary):
    body = json.dumps(summary).encode('utf-8')
    req = request.Request(
        NYX_BRIDGE_URL.rstrip('/') + '/ingest/email',
        data=body,
        headers={
            'Content-Type':  'application/json',
            'Authorization': 'Bearer ' + INGEST_TOKEN,
        },
        method='POST',
    )
    try:
        with request.urlopen(req, timeout=15) as resp:
            resp.read()
            return resp.status
    except error.HTTPError as e:
        log.warning(f'nyx bridge HTTP {e.code}: {e.read()[:200]!r}')
        return e.code
    except Exception as e:
        log.warning(f'nyx bridge unreachable: {e}')
        return None


def process_notification(gmail_svc, state, new_history_id):
    start = state.get('last_history_id')
    if not start:
        # No baseline — seed from notification itself; next push delivers deltas.
        state['last_history_id'] = str(new_history_id)
        save_state(state)
        log.info(f'seeded last_history_id={new_history_id}')
        return

    # Idempotency: skip if notification is older than what we processed.
    try:
        if int(new_history_id) <= int(start):
            log.info(f'skipping stale historyId {new_history_id} (last={start})')
            return
    except (ValueError, TypeError):
        pass

    new_ids = []
    page_token = None
    try:
        while True:
            r = gmail_svc.users().history().list(
                userId='me',
                startHistoryId=str(start),
                historyTypes=['messageAdded'],
                labelId='INBOX',
                pageToken=page_token,
            ).execute()
            for rec in r.get('history', []):
                for added in rec.get('messagesAdded', []):
                    mid = added.get('message', {}).get('id')
                    if mid:
                        new_ids.append(mid)
            page_token = r.get('nextPageToken')
            if not page_token:
                break
    except Exception as e:
        err_str = str(e)
        if '404' in err_str or 'Not Found' in err_str:
            # startHistoryId fell off the 7-day window; reset to the new one.
            log.warning(f'startHistoryId {start} expired; resetting to {new_history_id}')
            state['last_history_id'] = str(new_history_id)
            save_state(state)
            return
        log.error(f'history.list failed: {e}')
        return

    # Deduplicate preserving order.
    seen = set()
    unique = [m for m in new_ids if not (m in seen or seen.add(m))]
    log.info(f'history delta: {len(unique)} new message(s)')

    for mid in unique:
        summary = fetch_message_summary(gmail_svc, mid)
        if not summary:
            continue
        # Skip messages we sent ourselves (they also land in INBOX if we email ourselves).
        from_lower = summary.get('from', '').lower()
        if 'nyx@materiallab.io' in from_lower:
            log.info(f'skipping self-sent msg {mid}')
            continue
        log.info(
            f'ingest msg={mid} from={summary.get("from","")[:60]!r} '
            f'subj={summary.get("subject","")[:80]!r}'
        )
        post_to_nyx(summary)

    state['last_history_id'] = str(new_history_id)
    save_state(state)


# ── Pub/Sub pull loop ─────────────────────────────────────────────────────────

def pull_loop(pubsub_svc, gmail_svc, state):
    log.info(f'pulling from {SUBSCRIPTION_PATH}')
    backoff = 1
    while True:
        try:
            resp = pubsub_svc.projects().subscriptions().pull(
                subscription=SUBSCRIPTION_PATH,
                body={'maxMessages': 10, 'returnImmediately': False},
            ).execute(num_retries=3)
            backoff = 1
        except Exception as e:
            log.error(f'pull error: {e}; sleeping {backoff}s')
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)
            continue

        received = resp.get('receivedMessages', [])
        if not received:
            continue

        ack_ids = [m['ackId'] for m in received]
        for m in received:
            try:
                data_b64 = m['message'].get('data', '')
                data = json.loads(base64.b64decode(data_b64).decode('utf-8'))
                email_addr = data.get('emailAddress', '')
                hist_id    = data.get('historyId')
                log.info(f'pubsub msg: {email_addr} historyId={hist_id}')
                if hist_id:
                    process_notification(gmail_svc, state, hist_id)
            except Exception as e:
                log.error(f'processing failed: {e}')

        try:
            pubsub_svc.projects().subscriptions().acknowledge(
                subscription=SUBSCRIPTION_PATH,
                body={'ackIds': ack_ids},
            ).execute()
        except Exception as e:
            log.error(f'ack failed: {e}')


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    if not INGEST_TOKEN:
        log.error('INGEST_TOKEN not set — refusing to start')
        sys.exit(1)

    state = load_state()
    gmail = build_gmail_service()
    ensure_watch(gmail, state)

    pubsub = build_pubsub_service()

    renew = threading.Thread(target=watch_renewal_thread, args=(state,), daemon=True)
    renew.start()

    pull_loop(pubsub, gmail, state)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        log.info('interrupted; exiting')
