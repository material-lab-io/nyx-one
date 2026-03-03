#!/usr/bin/env node
'use strict';
/**
 * nyx-baileys-bridge — Standalone WhatsApp ↔ Claude Code CLI bridge
 *
 * Flow: WhatsApp message → ACL check → conversation history → claude -p → reply
 *
 * Environment variables:
 *   NYX_DATA_DIR          Persistent data dir (credentials + history). Default: /data/nyx
 *   NYX_CLAUDE_WORKDIR    Working dir for claude CLI invocations. Default: /app
 *   NYX_CLAUDE_BIN        Path to claude binary. Default: claude
 *   MAYOR_BRIDGE_URL      If set, enables nyx-to-mayor calls (optional)
 *   MAYOR_BRIDGE_TOKEN    Token for mayor bridge auth (optional)
 *   NYX_WA_DM_ALLOWLIST   Comma-separated phone numbers allowed in DM. Default: from config
 *   NYX_WA_GROUP_POLICY   open|allowlist|deny. Default: open
 *   NYX_WA_GROUPS         JSON: { "groupJid": { requireMention: bool } }
 *   NYX_MAX_HISTORY       Max conversation turns to keep in context. Default: 20
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, isJidGroup } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

// ── Config ────────────────────────────────────────────────────────────────────
const DATA_DIR      = process.env.NYX_DATA_DIR      || '/data/nyx';
const WORKDIR       = process.env.NYX_CLAUDE_WORKDIR || '/app';
const CLAUDE_BIN    = process.env.NYX_CLAUDE_BIN     || 'claude';
const MAX_HISTORY   = parseInt(process.env.NYX_MAX_HISTORY || '20', 10);

const DM_ALLOWLIST  = (process.env.NYX_WA_DM_ALLOWLIST || '+917259620848,+919818452569')
  .split(',').map(s => s.trim()).filter(Boolean);
const GROUP_POLICY  = process.env.NYX_WA_GROUP_POLICY || 'open';
let   GROUPS_CONFIG = {};
try { GROUPS_CONFIG = JSON.parse(process.env.NYX_WA_GROUPS || '{}'); } catch {}

const CREDS_DIR     = path.join(DATA_DIR, 'creds');
const HISTORY_DIR   = path.join(DATA_DIR, 'conversations');

// ── Logger ────────────────────────────────────────────────────────────────────
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// ── System prompt (nyx identity) ─────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Nyx (🌙), Kanaba's personal AI assistant on WhatsApp.
Be helpful, concise, and natural. You are running as a Claude Code agent.
You have access to bash tools and can run commands when useful.
Keep responses focused — WhatsApp is a chat medium, not a document editor.
If you need to send a message to the Gas Town mayor (Kanaba's AI task system),
you can run the command: nyx-to-mayor "subject" "body"`;

// ── ACL ───────────────────────────────────────────────────────────────────────
function isAllowedDM(jid) {
  const phone = '+' + jid.replace(/@.*$/, '');
  if (DM_ALLOWLIST.includes('*')) return true;
  return DM_ALLOWLIST.includes(phone);
}

function isAllowedGroup(jid) {
  if (GROUP_POLICY === 'open') return true;
  if (GROUP_POLICY === 'deny') return false;
  // allowlist
  return jid in GROUPS_CONFIG;
}

function requiresMention(jid, botJid) {
  const cfg = GROUPS_CONFIG[jid];
  if (cfg && cfg.requireMention === false) return false;
  return true; // default: require mention in groups
}

// ── Conversation history ──────────────────────────────────────────────────────
function historyPath(chatId) {
  // Sanitize chatId for use as filename
  const safe = chatId.replace(/[^a-zA-Z0-9+@._-]/g, '_');
  return path.join(HISTORY_DIR, `${safe}.jsonl`);
}

function loadHistory(chatId) {
  const p = historyPath(chatId);
  if (!fs.existsSync(p)) return [];
  try {
    return fs.readFileSync(p, 'utf8')
      .split('\n').filter(Boolean)
      .map(l => JSON.parse(l))
      .slice(-MAX_HISTORY);
  } catch { return []; }
}

function appendHistory(chatId, role, content) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  const line = JSON.stringify({ role, content, ts: new Date().toISOString() });
  fs.appendFileSync(historyPath(chatId), line + '\n');
}

// ── Build prompt with history ─────────────────────────────────────────────────
function buildPrompt(chatId, newMessage, senderName) {
  const history = loadHistory(chatId);
  const lines = [];

  for (const h of history) {
    if (h.role === 'user') {
      lines.push(`User: ${h.content}`);
    } else {
      lines.push(`Nyx: ${h.content}`);
    }
  }
  lines.push(`User (${senderName}): ${newMessage}`);

  return lines.join('\n');
}

// ── Invoke Claude CLI ─────────────────────────────────────────────────────────
function invokeClaude(prompt) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', prompt,
      '--system', SYSTEM_PROMPT,
      '--no-markdown',
    ];

    const child = spawn(CLAUDE_BIN, args, {
      cwd: WORKDIR,
      env: { ...process.env },
      timeout: 120000, // 2 min timeout
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    child.on('close', code => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
      }
    });

    child.on('error', reject);
  });
}

// ── Message handler ───────────────────────────────────────────────────────────
async function handleMessage(sock, msg) {
  const jid  = msg.key.remoteJid;
  const self = msg.key.fromMe;
  if (self) return; // ignore own messages

  // Extract text
  const text = msg.message?.conversation
    || msg.message?.extendedTextMessage?.text
    || msg.message?.imageMessage?.caption
    || msg.message?.videoMessage?.caption
    || '';

  if (!text.trim()) return; // ignore non-text for now

  const isGroup = isJidGroup(jid);
  const botJid  = sock.user?.id || '';

  // ACL checks
  if (isGroup) {
    if (!isAllowedGroup(jid)) return;
    // Check requireMention
    if (requiresMention(jid, botJid)) {
      const botNumber = botJid.replace(/:.*@/, '@');
      if (!text.includes('@' + botNumber.replace('@s.whatsapp.net', ''))) {
        // Also check if mentioned by @tag
        const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        if (!mentioned.includes(botJid) && !mentioned.includes(botJid.replace(/:.*@/, '@'))) {
          return;
        }
      }
    }
  } else {
    if (!isAllowedDM(jid)) {
      logger.info({ jid }, 'DM from non-allowlisted sender, ignoring');
      return;
    }
  }

  // Sender name
  const senderJid = msg.key.participant || jid;
  const senderName = msg.pushName || senderJid.replace(/@.*$/, '');

  logger.info({ jid, sender: senderName, isGroup }, 'Received message: %s', text.slice(0, 80));

  // Send typing indicator
  await sock.sendPresenceUpdate('composing', jid);

  // Store incoming message
  appendHistory(jid, 'user', `${senderName}: ${text}`);

  // Build prompt and call claude
  const prompt = buildPrompt(jid, text, senderName);

  let reply;
  try {
    reply = await invokeClaude(prompt);
  } catch (err) {
    logger.error({ err }, 'Claude invocation failed');
    reply = '⚠️ Sorry, I ran into an error. Please try again.';
  }

  // Store response
  appendHistory(jid, 'assistant', reply);

  // Clear typing, send reply
  await sock.sendPresenceUpdate('paused', jid);
  await sock.sendMessage(jid, { text: reply }, { quoted: msg });

  logger.info({ jid, replyLen: reply.length }, 'Replied');
}

// ── WhatsApp socket setup ─────────────────────────────────────────────────────
async function startBridge() {
  fs.mkdirSync(CREDS_DIR, { recursive: true });
  fs.mkdirSync(HISTORY_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(CREDS_DIR);

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'warn' }), // suppress Baileys internal noise
    printQRInTerminal: true,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      logger.info('QR code generated — scan with charlie account');
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      logger.info({ code, loggedOut }, 'Connection closed');
      if (!loggedOut) {
        logger.info('Reconnecting in 5s...');
        setTimeout(startBridge, 5000);
      } else {
        logger.error('Logged out — delete creds and restart to re-link');
        process.exit(1);
      }
    } else if (connection === 'open') {
      logger.info({ jid: sock.user?.id }, 'WhatsApp connected');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        await handleMessage(sock, msg);
      } catch (err) {
        logger.error({ err }, 'Error handling message');
      }
    }
  });

  return sock;
}

// ── Main ──────────────────────────────────────────────────────────────────────
logger.info({ DATA_DIR, WORKDIR, CLAUDE_BIN }, 'nyx-baileys-bridge starting');
startBridge().catch(err => {
  logger.fatal({ err }, 'Fatal startup error');
  process.exit(1);
});
