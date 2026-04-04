#!/bin/bash
# scan-qr.sh — print WhatsApp QR code for nyx in bots namespace
# Run this script, scan the QR with charlie's WhatsApp, then ctrl-c
set -e

echo "[scan-qr] Exec into nyx pod..."
kubectl exec -n bots deployment/nyx -- node -e "
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');

const CREDS_DIR = '/data/nyx/creds';
fs.mkdirSync(CREDS_DIR, { recursive: true });

async function run() {
  const { state, saveCreds } = await useMultiFileAuthState(CREDS_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
    if (qr) {
      qrcode.generate(qr, { small: true }, function(str) {
        process.stdout.write('\n=== Scan with charlie WhatsApp account ===\n\n');
        process.stdout.write(str);
        process.stdout.write('\n=== Waiting for scan... (ctrl-c to cancel) ===\n');
      });
    }
    if (connection === 'open') {
      console.log('\n[OK] WhatsApp connected! Creds saved to PVC.');
      process.exit(0);
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === 401) {
        console.error('[ERR] Logged out — restart pod to re-link');
        process.exit(1);
      }
    }
  });
}

run().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
"
