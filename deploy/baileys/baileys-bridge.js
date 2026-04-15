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
const { randomUUID } = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const pino = require('pino');
const { transcribeAudio, DEFAULT_GROQ_STT_BASE_URL, DEFAULT_STT_MODEL } = require('./stt');

// ── Config ────────────────────────────────────────────────────────────────────
const DATA_DIR     = process.env.BRIDGE_DATA_DIR       || process.env.NYX_DATA_DIR      || '/data/nyx';
const WORKDIR      = process.env.BRIDGE_CLAUDE_WORKDIR || process.env.NYX_CLAUDE_WORKDIR || '/app';
const CLAUDE_BIN   = process.env.BRIDGE_CLAUDE_BIN     || process.env.NYX_CLAUDE_BIN     || 'claude';
const MAX_HISTORY  = parseInt(process.env.BRIDGE_MAX_HISTORY || process.env.NYX_MAX_HISTORY || '10', 10);
const HEALTH_PORT  = parseInt(process.env.BRIDGE_HEALTH_PORT || '8080', 10);
const AGENT_NAME   = process.env.AGENT_NAME         || 'nyx';
const DISPLAY_NAME = process.env.AGENT_DISPLAY_NAME || AGENT_NAME;

const DM_ALLOWLIST = (process.env.BRIDGE_WA_DM_ALLOWLIST || process.env.NYX_WA_DM_ALLOWLIST || '+917259620848,+919818452569')
  .split(',').map(s => s.trim()).filter(Boolean);
const GROUP_POLICY = process.env.BRIDGE_WA_GROUP_POLICY || process.env.NYX_WA_GROUP_POLICY || 'open';
let GROUPS_CONFIG = {};
try { GROUPS_CONFIG = JSON.parse(process.env.BRIDGE_WA_GROUPS || process.env.NYX_WA_GROUPS || '{}'); } catch {}

const TMP_DIR = '/app/tmp';

const CREDS_DIR   = path.join(DATA_DIR, 'creds');
const HISTORY_DIR = path.join(DATA_DIR, 'conversations');

// ── Groq STT config ───────────────────────────────────────────────────────────
const GROQ_API_KEY      = process.env.GROQ_API_KEY || '';
const GROQ_STT_BASE_URL = process.env.GROQ_STT_BASE_URL || DEFAULT_GROQ_STT_BASE_URL;
const STT_MODEL         = process.env.STT_MODEL || DEFAULT_STT_MODEL;

// ── Logger ────────────────────────────────────────────────────────────────────
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// ── Startup tracking + health timing constants ────────────────────────────────
// Ported from OpenClaw (src/gateway/process.ts): tiered startup, zombie detection.
const STARTUP_TIME_MS     = Date.now();
const QUICK_CHECK_MS      = 5_000;    // First 5s: quick-starting phase
const STARTUP_TIMEOUT_MS  = 180_000;  // Up to 180s: starting phase (matches OpenClaw)
const ZOMBIE_THRESHOLD_MS = 120_000;  // >2min without WA connection = zombie

// ── Shutdown / connection state ───────────────────────────────────────────────
let shuttingDown        = false;
let waConnected         = false;
let lastClaudeLatencyMs = null; // Updated after each successful claude invocation

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
  logger.info('SIGTERM received — draining in-flight requests (up to 310s)');
  shuttingDown = true;
  await Promise.race([
    Promise.all([...inFlight]),
    new Promise(r => setTimeout(r, 310000)),
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

// ── Tiered health state (ported from OpenClaw process.ts) ────────────────────
//
// States (adapted from OpenClaw zombie-detection + graduated startup logic):
//   quick-starting  — first 5s after launch; WA handshake not yet attempted
//   starting        — 5s–180s; within normal startup window
//   zombie          — >120s without WA connection; port-not-listening equivalent
//   connected       — waConnected=true; fully operational
//   shutting_down   — SIGTERM received; draining in-flight messages
//
// HTTP status codes:
//   200 — connected (healthy)
//   202 — starting / quick-starting (not yet ready, but expected)
//   503 — zombie / shutting_down / unexpected not-ready
function getHealthStatus() {
  const uptimeMs = Date.now() - STARTUP_TIME_MS;

  if (shuttingDown)  return { state: 'shutting_down',  httpStatus: 503, ok: false };
  if (waConnected)   return { state: 'connected',       httpStatus: 200, ok: true  };

  // Not connected — classify by age (mirrors OpenClaw's quick-check / full-timeout logic)
  if (uptimeMs <= QUICK_CHECK_MS)     return { state: 'quick-starting', httpStatus: 202, ok: false };
  if (uptimeMs <= STARTUP_TIMEOUT_MS) return { state: 'starting',       httpStatus: 202, ok: false };

  // Past full startup window (STARTUP_TIMEOUT_MS) without WA connection = zombie.
  // (OpenClaw: "process is old > 2min [ZOMBIE_THRESHOLD_MS], treating as zombie")
  return { state: 'zombie', httpStatus: 503, ok: false };
}

// ── HTTP health server on :8080 ───────────────────────────────────────────────
const healthServer = http.createServer((req, res) => {
  const { state, httpStatus, ok } = getHealthStatus();
  const uptimeMs = Date.now() - STARTUP_TIME_MS;

  const body = {
    status:       state,
    ok,
    uptime_ms:    uptimeMs,
    wa_connected: waConnected,
    in_flight:    inFlight.size,
    shutting_down: shuttingDown,
    ...(lastClaudeLatencyMs !== null && { last_claude_latency_ms: lastClaudeLatencyMs }),
  };

  res.writeHead(httpStatus, { 'Content-Type': 'application/json' })
     .end(JSON.stringify(body));
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
const MAX_ENTRY_CHARS = 800; // truncate long history entries to keep context bounded

function buildPrompt(chatId, newMessage, senderName) {
  const history = loadHistory(chatId);
  const lines = [];
  for (const h of history) {
    const body = h.content.length > MAX_ENTRY_CHARS
      ? h.content.slice(0, MAX_ENTRY_CHARS) + '…[truncated]'
      : h.content;
    lines.push(h.role === 'user' ? `User: ${body}` : `${DISPLAY_NAME}: ${body}`);
  }
  lines.push(`User (${senderName}): ${newMessage}`);
  return lines.join('\n');
}

// ── Groq Whisper transcription ────────────────────────────────────────────────

/**
 * Download audio from a Baileys message and transcribe via Groq Whisper.
 * Returns the transcript string, or null on failure or missing API key.
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {import('@whiskeysockets/baileys').WAMessage} msg
 * @returns {Promise<string|null>}
 */
async function transcribeMessage(sock, msg) {
  if (!GROQ_API_KEY) {
    logger.warn('GROQ_API_KEY not set — cannot transcribe audio');
    return null;
  }
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
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
      const result = await transcribeAudio({
        buffer, mime, apiKey: GROQ_API_KEY, baseUrl: GROQ_STT_BASE_URL, model: STT_MODEL,
      });
      return result.text;
    } catch (err) {
      const isRetryable = err?.code === 'ETIMEDOUT' || err?.code === 'ECONNRESET'
        || err?.code === 'ENOTFOUND' || err?.code === 'UND_ERR_CONNECT_TIMEOUT'
        || (err?.message && /timeout|socket hang up/i.test(err.message));
      if (isRetryable && attempt < maxRetries) {
        const delay = attempt * 2000; // 2s, 4s
        logger.warn({ err: err.code || err.message, attempt, delay }, 'Media download failed, retrying');
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      logger.error({ err, attempt }, 'Audio transcription failed');
      return null;
    }
  }
  return null;
}

// ── Invoke Claude CLI ─────────────────────────────────────────────────────────
function invokeClaude(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, ['-p', prompt, '--output-format', 'text', '--dangerously-skip-permissions', '--max-turns', '15'], {
      cwd: WORKDIR,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300000,
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

// ── Media content extraction ──────────────────────────────────────────────────
// Returns { content: string, tempFiles: string[] }
// tempFiles are cleaned up after Claude responds.
// sock is passed for audio to enable media reupload on stale messages.
async function extractContent(msg, sock) {
  const m = msg.message;
  if (!m) return { content: '', tempFiles: [] };

  // Plain text
  const text = m.conversation || m.extendedTextMessage?.text || '';
  if (text) return { content: text, tempFiles: [] };

  // Audio / Voice note — delegate to transcribeMessage (handles MIME + reupload)
  if (m.audioMessage || m.pttMessage) {
    if (!GROQ_API_KEY) {
      return { content: '[voice note - transcription unavailable]', tempFiles: [] };
    }
    const transcript = await transcribeMessage(sock, msg);
    if (!transcript) {
      return { content: '[voice note - could not transcribe]', tempFiles: [] };
    }
    return { content: `[Voice note transcript]: ${transcript}`, tempFiles: [] };
  }

  // Image
  if (m.imageMessage) {
    const caption = m.imageMessage.caption || '';
    try {
      const buf = await downloadMediaMessage(msg, 'buffer', {});
      const tmpPath = path.join(TMP_DIR, `${randomUUID()}.jpg`);
      fs.mkdirSync(TMP_DIR, { recursive: true });
      fs.writeFileSync(tmpPath, buf);
      const captionPart = caption ? ` Caption: ${caption}` : '';
      return {
        content: `User sent an image, saved at ${tmpPath}.${captionPart}`,
        tempFiles: [tmpPath],
      };
    } catch (err) {
      logger.error({ err }, 'Image download failed');
      return { content: caption || '[image - could not download]', tempFiles: [] };
    }
  }

  // Video (no download — too large, no ffmpeg)
  if (m.videoMessage) {
    const caption = m.videoMessage.caption || '';
    return { content: `[Video message]${caption ? ` Caption: ${caption}` : ''}`, tempFiles: [] };
  }

  // Document
  if (m.documentMessage) {
    const { fileName = 'document', mimetype = 'application/octet-stream', fileLength } = m.documentMessage;
    const sizeBytes = fileLength ? Number(fileLength) : 0;
    const MAX_DOC = 5 * 1024 * 1024;
    if (sizeBytes > 0 && sizeBytes <= MAX_DOC) {
      try {
        const buf = await downloadMediaMessage(msg, 'buffer', {});
        const tmpPath = path.join(TMP_DIR, `${randomUUID()}-${fileName}`);
        fs.mkdirSync(TMP_DIR, { recursive: true });
        fs.writeFileSync(tmpPath, buf);
        return {
          content: `User sent a document: ${fileName} (${mimetype}), saved at ${tmpPath}`,
          tempFiles: [tmpPath],
        };
      } catch (err) {
        logger.error({ err }, 'Document download failed');
        return { content: `User sent a document: ${fileName} (${mimetype}) — could not download`, tempFiles: [] };
      }
    }
    const sizePart = sizeBytes ? ` — ${(sizeBytes / 1024 / 1024).toFixed(1)}MB, too large to download` : '';
    return { content: `User sent a document: ${fileName} (${mimetype})${sizePart}`, tempFiles: [] };
  }

  return { content: '', tempFiles: [] };
}

// ── Process one message (serialized per chatId) ───────────────────────────────
async function processMessage(sock, msg) {
  const jid     = msg.key.remoteJid;
  const isGroup = isJidGroup(jid);
  const botJid  = sock.user?.id || '';

  // Extract content — async (may transcribe audio or download media)
  const { content, tempFiles } = await extractContent(msg, sock);

  if (!content.trim()) return;

  // ACL checks
  if (isGroup) {
    if (!isAllowedGroup(jid)) {
      for (const f of tempFiles) { try { fs.unlinkSync(f); } catch {} }
      return;
    }
    if (requiresMention(jid)) {
      // Use caption/text for @mention detection; audio/media carry mentions in contextInfo
      const mentionText = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.imageMessage?.caption
        || msg.message?.videoMessage?.caption
        || msg.message?.documentMessage?.caption
        || '';
      const botNumber = botJid.replace(/:.*@/, '@');
      if (!mentionText.includes('@' + botNumber.replace('@s.whatsapp.net', ''))) {
        const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        if (!mentioned.includes(botJid) && !mentioned.includes(botJid.replace(/:.*@/, '@'))) {
          for (const f of tempFiles) { try { fs.unlinkSync(f); } catch {} }
          return;
        }
      }
    }
  } else {
    if (!isAllowedDM(jid, msg)) {
      logger.info({ jid }, 'DM from non-allowlisted sender, ignoring');
      for (const f of tempFiles) { try { fs.unlinkSync(f); } catch {} }
      return;
    }
  }

  const senderJid  = msg.key.participant || jid;
  const senderName = msg.pushName || senderJid.replace(/@.*$/, '');

  logger.info({ jid, sender: senderName, isGroup }, 'Received message: %s', content.slice(0, 80));

  await sock.sendPresenceUpdate('composing', jid);
  appendHistory(jid, 'user', `${senderName}: ${content}`);

  const prompt = buildPrompt(jid, content, senderName);

  let reply;
  const claudeStart   = Date.now();
  const claudePromise = invokeClaude(prompt);
  inFlight.add(claudePromise);
  try {
    reply = await claudePromise;
    lastClaudeLatencyMs = Date.now() - claudeStart;
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
    // Cleanup temp media files after Claude has processed them
    for (const f of tempFiles) { try { fs.unlinkSync(f); } catch {} }
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
    logger: pino({ level: 'info' }),
    // QR rendered manually via qrcode-terminal in connection.update handler
    markOnlineOnConnect: false,
    // Needed for retry/re-key when group message decryption fails
    getMessage: async (key) => {
      logger.debug({ key }, 'getMessage called (retry/re-key request)');
      return { conversation: '' };
    },
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
      // Re-announce presence to all groups to restore routing after reconnect
      sock.groupFetchAllParticipating().then(groups => {
        const jids = Object.keys(groups);
        logger.info({ count: jids.length }, 'Subscribing to group presence');
        return Promise.allSettled(jids.map(jid => sock.presenceSubscribe(jid)));
      }).catch(err => logger.warn({ err }, 'Group presence subscribe failed'));
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    const groups = messages.filter(m => m.key.remoteJid?.endsWith('@g.us'));
    if (groups.length) logger.info({ type, jids: groups.map(m => m.key.remoteJid), stubs: groups.map(m => m.messageStubType) }, 'group msg upsert');
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
    getHealthStatus,
    chatQueues,
    inFlight,
    AUTH_PATTERNS,
    AGENT_NAME,
    STARTUP_TIME_MS,
    QUICK_CHECK_MS,
    STARTUP_TIMEOUT_MS,
    ZOMBIE_THRESHOLD_MS,
  };
}
