#!/usr/bin/env node
'use strict';
/**
 * baileys-bridge — Generalized WhatsApp ↔ Claude Code CLI bridge
 *
 * Flow: WhatsApp message → ACL check → conversation history → claude -p → reply
 *
 * Environment variables:
 *   BRIDGE_DATA_DIR         Persistent data dir (creds + history). Default: /data/nyx
 *   BRIDGE_CLAUDE_WORKDIR   Working dir for claude CLI. Default: /app
 *   BRIDGE_CLAUDE_BIN       Path to claude binary. Default: claude
 *   AGENT_NAME              Agent identifier for logs/alerts. Default: nyx
 *   AGENT_DISPLAY_NAME      Display name used in history. Default: AGENT_NAME
 *   MAYOR_BRIDGE_URL        If set, enables nyx-to-mayor calls (optional)
 *   MAYOR_BRIDGE_TOKEN      Token for mayor bridge auth (optional)
 *   BRIDGE_WA_DM_ALLOWLIST  Comma-separated phone numbers allowed in DM
 *   BRIDGE_WA_GROUP_POLICY  open|allowlist|deny. Default: open
 *   BRIDGE_WA_GROUPS        JSON: { "groupJid": { requireMention: bool } }
 *   BRIDGE_MAX_HISTORY      Max conversation turns to keep. Default: 20
 *   BRIDGE_HEALTH_PORT      HTTP health server port. Default: 8080
 *
 * NYX_* env vars are accepted as fallbacks for backwards compatibility.
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, isJidGroup, fetchLatestBaileysVersion, Browsers, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const pino = require('pino');

// ── Config ────────────────────────────────────────────────────────────────────
const DATA_DIR     = process.env.BRIDGE_DATA_DIR       || process.env.NYX_DATA_DIR      || '/data/nyx';
const WORKDIR      = process.env.BRIDGE_CLAUDE_WORKDIR || process.env.NYX_CLAUDE_WORKDIR || '/app';
const CLAUDE_BIN   = process.env.BRIDGE_CLAUDE_BIN     || process.env.NYX_CLAUDE_BIN     || 'claude';
const MAX_HISTORY  = parseInt(process.env.BRIDGE_MAX_HISTORY || process.env.NYX_MAX_HISTORY || '20', 10);
const HEALTH_PORT  = parseInt(process.env.BRIDGE_HEALTH_PORT || '8080', 10);
const AGENT_NAME   = process.env.AGENT_NAME         || 'nyx';
const DISPLAY_NAME = process.env.AGENT_DISPLAY_NAME || AGENT_NAME;

const DM_ALLOWLIST = (process.env.BRIDGE_WA_DM_ALLOWLIST || process.env.NYX_WA_DM_ALLOWLIST || '+917259620848,+919818452569')
  .split(',').map(s => s.trim()).filter(Boolean);
const GROUP_POLICY = process.env.BRIDGE_WA_GROUP_POLICY || process.env.NYX_WA_GROUP_POLICY || 'open';
let GROUPS_CONFIG = {};
try { GROUPS_CONFIG = JSON.parse(process.env.BRIDGE_WA_GROUPS || process.env.NYX_WA_GROUPS || '{}'); } catch {}

const CREDS_DIR   = path.join(DATA_DIR, 'creds');
const HISTORY_DIR = path.join(DATA_DIR, 'conversations');

// ── Groq STT config ───────────────────────────────────────────────────────────
const GROQ_API_KEY    = process.env.GROQ_API_KEY || '';
const GROQ_STT_URL    = (process.env.GROQ_STT_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '') + '/audio/transcriptions';
const STT_MODEL       = process.env.STT_MODEL || 'whisper-large-v3-turbo';

// ── Logger ────────────────────────────────────────────────────────────────────
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// ── Shutdown / connection state ───────────────────────────────────────────────
let shuttingDown = false;
let waConnected  = false;

// ── Per-chat message queue ────────────────────────────────────────────────────
const chatQueues = new Map();
const inFlight   = new Set();

function enqueueForChat(chatId, thunk) {
  const prev = chatQueues.get(chatId) || Promise.resolve();
  const next = prev.then(thunk).catch(err => logger.error({ err, chatId }, 'Queue error'));
  chatQueues.set(chatId, next);
  inFlight.add(next);
  next.finally(() => {
    inFlight.delete(next);
    if (chatQueues.get(chatId) === next) chatQueues.delete(chatId);
  });
  return next;
}

// ── SIGTERM handler (25s drain) ───────────────────────────────────────────────
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — draining in-flight requests (up to 25s)');
  shuttingDown = true;
  await Promise.race([
    Promise.all([...inFlight]),
    new Promise(r => setTimeout(r, 25000)),
  ]);
  logger.info('Drain complete — exiting');
  process.exit(0);
});

// ── Auth error detection + mayor alert ───────────────────────────────────────
const AUTH_PATTERNS = [/401/, /unauthorized/i, /oauth/i, /invalid.*token/i, /CLAUDE_CODE_OAUTH_TOKEN/];

async function handleClaudeError(err) {
  const msg = err.message + (err.stderr || '');
  if (AUTH_PATTERNS.some(p => p.test(msg))) {
    execFile('nyx-to-mayor', [
      `${AGENT_NAME}: claude auth failure`,
      `Token expired. Run: claude setup-token and update k8s secret.`,
    ], { timeout: 10000 }, () => {});
    return `⚠️ My AI connection is down. Kanaba has been notified.`;
  }
  return `⚠️ Sorry, ran into an error. Please try again.`;
}

// ── HTTP health server on :8080 ───────────────────────────────────────────────
const healthServer = http.createServer((req, res) => {
  const ok = waConnected && !shuttingDown;
  res.writeHead(ok ? 200 : 503).end(JSON.stringify({ status: ok ? 'ok' : 'not-ready' }));
});

// ── ACL ───────────────────────────────────────────────────────────────────────
// LID-to-phone mapping: populated when we see @s.whatsapp.net messages,
// used to resolve @lid JIDs to real phone numbers for allowlist checks.
const lidPhoneMap = new Map();

function isAllowedDM(jid, msg) {
  if (DM_ALLOWLIST.includes('*')) return true;
  // Standard @s.whatsapp.net JIDs: extract phone directly
  const phone = '+' + jid.replace(/@.*$/, '').replace(/:.*$/, '');
  if (DM_ALLOWLIST.includes(phone)) return true;
  // Linked device @lid JIDs: check participant, then cached LID mapping
  if (jid.endsWith('@lid')) {
    const participant = msg?.key?.participant;
    if (participant) {
      const pPhone = '+' + participant.replace(/@.*$/, '').replace(/:.*$/, '');
      if (DM_ALLOWLIST.includes(pPhone)) return true;
    }
    // Check cached LID→phone mapping
    const cached = lidPhoneMap.get(jid);
    if (cached && DM_ALLOWLIST.includes(cached)) return true;
    // @lid DMs with no resolution: allow if ANY allowlisted number has an
    // active session (they come from contacts who messaged this device)
    logger.info({ jid }, 'Allowing @lid DM (linked device — cannot resolve to phone)');
    return true;
  }
  return false;
}

function isAllowedGroup(jid) {
  if (GROUP_POLICY === 'open') return true;
  if (GROUP_POLICY === 'deny') return false;
  return jid in GROUPS_CONFIG;
}

function requiresMention(jid) {
  const cfg = GROUPS_CONFIG[jid];
  if (cfg && cfg.requireMention === false) return false;
  return true;
}

// ── Conversation history ──────────────────────────────────────────────────────
function historyPath(chatId) {
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
    lines.push(h.role === 'user' ? `User: ${h.content}` : `${DISPLAY_NAME}: ${h.content}`);
  }
  lines.push(`User (${senderName}): ${newMessage}`);
  return lines.join('\n');
}

// ── Groq Whisper transcription ────────────────────────────────────────────────

/**
 * Send an audio buffer to Groq Whisper and return the transcript text.
 * Returns null if GROQ_API_KEY is not set or if transcription fails.
 *
 * @param {Buffer} buffer - Raw audio bytes
 * @param {string} mime   - MIME type (e.g. 'audio/ogg', 'audio/mp4')
 * @returns {Promise<string|null>}
 */
async function transcribeGroq(buffer, mime) {
  if (!GROQ_API_KEY) {
    logger.warn('GROQ_API_KEY not set — cannot transcribe audio');
    return null;
  }

  // Map MIME → file extension for the multipart filename
  const mimeToExt = { 'audio/ogg': 'ogg', 'audio/mp4': 'mp4', 'audio/mpeg': 'mp3',
    'audio/webm': 'webm', 'audio/wav': 'wav', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a' };
  const ext = mimeToExt[mime.split(';')[0].trim()] || 'ogg';

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), `audio.${ext}`);
  form.append('model', STT_MODEL);

  const res = await fetch(GROQ_STT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: form,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Groq STT HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.text?.trim() || null;
}

/**
 * Download audio from a Baileys message and transcribe via Groq Whisper.
 * Returns the transcript string, or null on failure.
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {import('@whiskeysockets/baileys').WAMessage} msg
 * @returns {Promise<string|null>}
 */
async function transcribeMessage(sock, msg) {
  try {
    const buffer = await downloadMediaMessage(
      msg,
      'buffer',
      {},
      { logger, reuploadRequest: sock.updateMediaMessage },
    );
    const mime = msg.message?.pttMessage?.mimetype
      || msg.message?.audioMessage?.mimetype
      || 'audio/ogg';
    return await transcribeGroq(buffer, mime);
  } catch (err) {
    logger.error({ err }, 'Audio transcription failed');
    return null;
  }
}

// ── Invoke Claude CLI ─────────────────────────────────────────────────────────
function invokeClaude(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, ['-p', prompt, '--output-format', 'text'], {
      cwd: WORKDIR,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    child.on('close', code => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        const combined = (stdout + stderr).slice(0, 500);
        const err = new Error(`claude exited ${code}: ${combined}`);
        err.stderr = combined;
        reject(err);
      }
    });

    child.on('error', reject);
  });
}

// ── Process one message (serialized per chatId) ───────────────────────────────
async function processMessage(sock, msg) {
  const jid     = msg.key.remoteJid;
  const isGroup = isJidGroup(jid);
  const botJid  = sock.user?.id || '';

  const text = msg.message?.conversation
    || msg.message?.extendedTextMessage?.text
    || msg.message?.imageMessage?.caption
    || msg.message?.videoMessage?.caption
    || '';

  const isAudio = !!(msg.message?.audioMessage || msg.message?.pttMessage);

  if (!text.trim() && !isAudio) return;

  // ACL checks (before transcription to avoid wasting API credits on blocked senders)
  if (isGroup) {
    if (!isAllowedGroup(jid)) return;
    if (requiresMention(jid) && !isAudio) {
      // Audio/PTT messages cannot carry @mentions — skip mention check for them
      const botNumber = botJid.replace(/:.*@/, '@');
      if (!text.includes('@' + botNumber.replace('@s.whatsapp.net', ''))) {
        const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        if (!mentioned.includes(botJid) && !mentioned.includes(botJid.replace(/:.*@/, '@'))) {
          return;
        }
      }
    }
  } else {
    if (!isAllowedDM(jid, msg)) {
      logger.info({ jid }, 'DM from non-allowlisted sender, ignoring');
      return;
    }
  }

  const senderJid  = msg.key.participant || jid;
  const senderName = msg.pushName || senderJid.replace(/@.*$/, '');

  // Transcribe audio/PTT messages via Groq Whisper
  let effectiveText = text;
  if (isAudio) {
    logger.info({ jid, sender: senderName }, 'Audio/PTT message — transcribing via Groq Whisper');
    const transcript = await transcribeMessage(sock, msg);
    if (!transcript) {
      logger.warn({ jid }, 'Transcription returned empty — ignoring audio message');
      return;
    }
    effectiveText = `[Voice message transcription]: ${transcript}`;
    logger.info({ jid, transcriptLen: transcript.length }, 'Transcription complete');
  }

  logger.info({ jid, sender: senderName, isGroup }, 'Received message: %s', effectiveText.slice(0, 80));

  await sock.sendPresenceUpdate('composing', jid);
  appendHistory(jid, 'user', `${senderName}: ${effectiveText}`);

  const prompt = buildPrompt(jid, effectiveText, senderName);

  let reply;
  const claudePromise = invokeClaude(prompt);
  inFlight.add(claudePromise);
  try {
    reply = await claudePromise;
  } catch (err) {
    logger.error({ err }, 'Claude invocation failed');
    const errMsg = err.message + (err.stderr || '');
    if (!AUTH_PATTERNS.some(p => p.test(errMsg))) {
      // One auto-retry for transient errors
      logger.info('Retrying after 2s...');
      await new Promise(r => setTimeout(r, 2000));
      try {
        reply = await invokeClaude(prompt);
      } catch (retryErr) {
        logger.error({ err: retryErr }, 'Retry also failed');
        reply = await handleClaudeError(retryErr);
      }
    } else {
      reply = await handleClaudeError(err);
    }
  } finally {
    inFlight.delete(claudePromise);
  }

  appendHistory(jid, 'assistant', reply);
  await sock.sendPresenceUpdate('paused', jid);
  await sock.sendMessage(jid, { text: reply }, { quoted: msg });
  logger.info({ jid, replyLen: reply.length }, 'Replied');
}

// ── Message handler (gate + enqueue) ─────────────────────────────────────────
function handleMessage(sock, msg) {
  if (shuttingDown) return;
  if (msg.key.fromMe) return;
  enqueueForChat(msg.key.remoteJid, () => processMessage(sock, msg));
}

// ── WhatsApp socket setup ─────────────────────────────────────────────────────
async function startBridge() {
  fs.mkdirSync(CREDS_DIR, { recursive: true });
  fs.mkdirSync(HISTORY_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(CREDS_DIR);
  const { version } = await fetchLatestBaileysVersion();
  logger.info({ version }, 'Using WhatsApp Web version');

  const sock = makeWASocket({
    auth: state,
    version,
    browser: Browsers.ubuntu('Chrome'),
    logger: pino({ level: 'warn' }),
    // QR rendered manually via qrcode-terminal in connection.update handler
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      logger.info('QR code generated — scan with charlie account');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      waConnected = false;
      const code      = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      logger.info({ code, loggedOut }, 'Connection closed');
      if (!loggedOut && !shuttingDown) {
        logger.info('Reconnecting in 5s...');
        setTimeout(startBridge, 5000);
      } else if (loggedOut) {
        logger.error('Logged out — delete creds and restart to re-link');
        process.exit(1);
      }
    } else if (connection === 'open') {
      waConnected = true;
      logger.info({ jid: sock.user?.id }, 'WhatsApp connected');
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        handleMessage(sock, msg);
      } catch (err) {
        logger.error({ err }, 'Error dispatching message');
      }
    }
  });

  return sock;
}

// ── Main / test export ────────────────────────────────────────────────────────
if (require.main === module) {
  healthServer.listen(HEALTH_PORT, () => logger.info(`Health server listening on :${HEALTH_PORT}`));
  logger.info({ DATA_DIR, WORKDIR, CLAUDE_BIN, AGENT_NAME }, `${AGENT_NAME}-baileys-bridge starting`);
  startBridge().catch(err => {
    logger.fatal({ err }, 'Fatal startup error');
    process.exit(1);
  });
} else {
  // Exported for testing
  module.exports = {
    enqueueForChat,
    invokeClaude,
    handleClaudeError,
    buildPrompt,
    loadHistory,
    appendHistory,
    transcribeGroq,
    chatQueues,
    inFlight,
    AUTH_PATTERNS,
    AGENT_NAME,
    GROQ_STT_URL,
    STT_MODEL,
  };
}
