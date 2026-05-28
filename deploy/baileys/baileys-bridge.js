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
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
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
const CLAUDE_MODEL = process.env.BRIDGE_CLAUDE_MODEL   || 'opus[1m]';
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

// ── Dropbox: auto-save received media to durable storage ──────────────────────
// Files ≤ DRIVE_MAX go to Google Drive (shareable link); larger files (up to
// BOX_MAX) are archived to the 20TB storagebox via nyx-store. Every saved file
// is recorded in the nyx-files index so nyx can find it later.
const DRIVE_MAX_BYTES = parseInt(process.env.NYX_DRIVE_MAX_BYTES || String(25 * 1024 * 1024), 10);
// Large files stream to disk (constant memory), so the ceiling is ephemeral disk,
// not pod RAM — set to WhatsApp's own ~2GB media limit.
const BOX_MAX_BYTES   = parseInt(process.env.NYX_BOX_MAX_BYTES   || String(2 * 1024 * 1024 * 1024), 10);
const DROPBOX_FOLDER  = process.env.NYX_DROPBOX_FOLDER || 'Nyx Dropbox';

const CREDS_DIR   = path.join(DATA_DIR, 'creds');
const HISTORY_DIR = path.join(DATA_DIR, 'conversations');

// Phone number pairing: if set, request a pairing code instead of showing QR.
// Format: digits only, with country code, no + (e.g. "919187520828").
const PAIRING_PHONE = process.env.BRIDGE_PAIRING_PHONE || '';

// ── Inbox watcher ingest config ───────────────────────────────────────────────
const INGEST_TOKEN   = process.env.INGEST_TOKEN   || '';
const NYX_OWNER_JID  = process.env.NYX_OWNER_JID  || '';

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
// ── Heartbeat: check for due cron jobs every 60s ──────────────────────────
let heartbeatTimer = null;
let cleanupCounter = 0;
let activeSock     = null;

function startHeartbeat(sock) {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(async () => {
    if (shuttingDown || !waConnected) return;
    try {
      const { stdout } = await execFileAsync('nyx-memory', ['cron', 'due'], { timeout: 10_000 });
      const jobs = JSON.parse(stdout || '[]');
      for (const job of jobs) {
        try {
          if (job.payload_kind === 'message') {
            await sock.sendMessage(job.chat_jid, { text: job.payload });
          } else if (job.payload_kind === 'prompt') {
            const reply = await invokeClaude(job.payload);
            if (reply.trim() === 'SKIP') {
              logger.info({ jobId: job.id }, 'heartbeat skipped due to SKIP marker');
            } else {
              await sock.sendMessage(job.chat_jid, { text: reply });
            }
          }
          execFile('nyx-memory', ['cron', 'done', String(job.id), '--status', 'ok']);
        } catch (err) {
          logger.error({ err, jobId: job.id }, 'Cron job execution failed');
          execFile('nyx-memory', ['cron', 'done', String(job.id), '--status', 'error']);
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') logger.warn({ err: err.message }, 'Heartbeat check failed');
    }
    // Periodic cleanup every 6 hours (360 ticks at 60s each)
    cleanupCounter++;
    if (cleanupCounter >= 360) {
      cleanupCounter = 0;
      execFile('nyx-memory', ['cleanup'], { timeout: 10_000 }, (err) => {
        if (err && err.code !== 'ENOENT') logger.warn({ err: err.message }, 'Periodic cleanup failed');
        else logger.info('Periodic scratch note cleanup completed');
      });
    }
  }, 60_000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — draining in-flight requests (up to 310s)');
  shuttingDown = true;
  stopHeartbeat();
  stopAuthCheck();
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

// ── Periodic auth health check + live token swap ─────────────────────────────
const AUTH_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const AUTH_PROBE_TIMEOUT_MS  = 10 * 1000;
let authCheckTimer = null;

function probeClaudeToken(token, label) {
  return new Promise((resolve) => {
    const proc = spawn(CLAUDE_BIN, ['-p', 'ping', '--output-format', 'text'], {
      env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve({ ok: false, label, reason: 'timeout' }); }, AUTH_PROBE_TIMEOUT_MS);
    let err = '';
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, label, reason: err.split('\n')[0] || '' });
    });
  });
}

function notifyOwnerOfAuthFailure(r1, r2) {
  if (!activeSock || !waConnected || !NYX_OWNER_JID) return;
  const t2 = r2 ? `, token-2=${r2.reason}` : '';
  const text = `⚠️ nyx auth failing: token-1=${r1.reason}${t2}. Bridge continues with last working token.`;
  activeSock.sendMessage(NYX_OWNER_JID, { text }).catch(() => {});
}

async function authHealthCheck() {
  if (!waConnected || shuttingDown) return;
  if (process.env.ANTHROPIC_API_KEY) return;

  const primary  = process.env.CLAUDE_CODE_OAUTH_TOKEN || '';
  const fallback = process.env.CLAUDE_CODE_OAUTH_TOKEN_2 || '';
  if (!primary) return;

  const r = await probeClaudeToken(primary, 'token-1');
  if (r.ok) {
    logger.info({ label: r.label }, 'auth probe healthy');
    return;
  }

  logger.warn({ result: r }, 'primary token probe failed; trying fallback');
  if (!fallback) {
    logger.error('no CLAUDE_CODE_OAUTH_TOKEN_2 set; cannot swap');
    notifyOwnerOfAuthFailure(r);
    return;
  }

  const r2 = await probeClaudeToken(fallback, 'token-2');
  if (r2.ok) {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = fallback;
    logger.info('auth swap to token-2 succeeded');
    return;
  }

  logger.error({ r, r2 }, 'both tokens failed; escalating to owner');
  notifyOwnerOfAuthFailure(r, r2);
}

function startAuthCheck() {
  if (authCheckTimer) return;
  authCheckTimer = setInterval(() => {
    authHealthCheck().catch(e => logger.error({ err: e }, 'authHealthCheck threw'));
  }, AUTH_CHECK_INTERVAL_MS);
}

function stopAuthCheck() {
  if (authCheckTimer) { clearInterval(authCheckTimer); authCheckTimer = null; }
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
// Handles:
//   GET  /                — health (tiered startup states)
//   POST /ingest/email    — inbox notification from nyx-gmail-watcher (host-side)
//                           queues a Claude-judged alert via nyx-memory cron
function handleIngestEmail(req, res) {
  if (!INGEST_TOKEN) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end('INGEST_TOKEN not configured');
    return;
  }
  if (req.headers['authorization'] !== `Bearer ${INGEST_TOKEN}`) {
    res.writeHead(401, { 'Content-Type': 'text/plain' }).end('Unauthorized');
    return;
  }
  if (!NYX_OWNER_JID) {
    logger.warn('NYX_OWNER_JID unset — cannot schedule inbox alert');
    res.writeHead(202, { 'Content-Type': 'text/plain' }).end('no owner jid; skipped');
    return;
  }
  let body = '';
  req.on('data', d => { body += d; if (body.length > 256 * 1024) { req.destroy(); } });
  req.on('end', () => {
    let payload;
    try { payload = JSON.parse(body); }
    catch (e) { res.writeHead(400, { 'Content-Type': 'text/plain' }).end('bad json'); return; }
    const { msg_id, from: fromAddr, subject, snippet } = payload;
    if (!msg_id) {
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end('msg_id required');
      return;
    }
    const prompt =
`INBOX NOTIFICATION: A new email arrived in nyx@materiallab.io.
From:    ${fromAddr || '(unknown)'}
Subject: ${subject || '(no subject)'}
Snippet: ${(snippet || '').slice(0, 400)}
Message ID: ${msg_id}

You can fetch the full email with: nyx-email read ${msg_id}

Decide whether this is important enough to notify Kanaba on WhatsApp RIGHT NOW
(urgent, financial, legal, from someone he cares about, an email awaiting his
reply, a ticket/security alert). If YES, reply with a concise WhatsApp
notification (1-3 short lines; lead with the subject and key ask). If the
email is promotional, a newsletter, automated/noise, or otherwise low-priority,
reply with EXACTLY the single word: SKIP`;
    const jobName = ('inbox-' + msg_id).slice(0, 80);
    // Schedule 2s from now in UTC ISO-8601 (no fractional seconds / no Z — matches parse_time).
    // The heartbeat runs every 60s and picks up any job whose next_run_at <= now().
    const runAt = new Date(Date.now() + 2_000).toISOString().replace(/\.\d+Z$/, '');
    execFile('nyx-memory', [
      'cron', 'add',
      '--name', jobName,
      '--at', runAt,
      '--prompt', prompt,
      '--chat', NYX_OWNER_JID,
    ], { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) logger.error({ err: err.message, stderr: (stderr || '').slice(0, 200) }, 'failed to schedule inbox alert');
      else logger.info({ jobName, from: (fromAddr || '').slice(0, 60) }, 'scheduled inbox alert');
    });
    res.writeHead(202, { 'Content-Type': 'text/plain' }).end('queued');
  });
  req.on('error', () => {
    if (!res.writableEnded) res.writeHead(400, { 'Content-Type': 'text/plain' }).end('bad request');
  });
}

const healthServer = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/ingest/email') {
    return handleIngestEmail(req, res);
  }

  // ── Send message endpoint ────────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/send') {
    if (!waConnected) {
      res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'not connected' }));
      return;
    }
    let body = '';
    req.on('data', d => { body += d; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', async () => {
      try {
        const { jid, text } = JSON.parse(body);
        if (!jid || !text) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'jid and text required' })); return; }
        await activeSock.sendMessage(jid, { text });
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'sent', jid }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Default: health endpoint
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
    const child = spawn(CLAUDE_BIN, ['-p', prompt, '--model', CLAUDE_MODEL, '--output-format', 'text', '--dangerously-skip-permissions', '--max-turns', '100'], {
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

// ── Streaming media download (constant memory, for large files) ───────────────
// Streams WhatsApp media straight to disk instead of buffering it in RAM, so the
// size ceiling is ephemeral disk, not the pod's memory limit. Returns bytes written.
// Aborts (and deletes the partial file) if it would exceed maxBytes.
async function streamDownloadToFile(msg, sock, tmpPath, maxBytes) {
  fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
  const stream = await downloadMediaMessage(
    msg, 'stream', {}, { logger, reuploadRequest: sock.updateMediaMessage });
  let bytes = 0;
  try {
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(tmpPath);
      stream.on('data', chunk => {
        bytes += chunk.length;
        if (maxBytes && bytes > maxBytes) {
          stream.destroy();
          ws.destroy();
          reject(new Error(`exceeds cap (${maxBytes} bytes)`));
        }
      });
      stream.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', resolve);
      stream.pipe(ws);
    });
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
  return bytes;
}

// ── Dropbox: save a downloaded media file to durable storage + index it ───────
// Best-effort: returns a short note to append to the prompt so nyx can confirm
// to the user with a link. Never throws.
async function archiveMedia(media, who) {
  const { tmpPath, origName, mime, sizeBytes, caption } = media;
  const sizeMB = (sizeBytes / 1024 / 1024).toFixed(1);
  try {
    let backend, location = '', link = '';
    if (sizeBytes <= DRIVE_MAX_BYTES) {
      backend = 'drive';
      const { stdout } = await execFileAsync(
        'nyx-drive', ['upload', tmpPath, '--name', origName, '--folder', DROPBOX_FOLDER],
        { timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
      try {
        const j = JSON.parse(stdout);
        const o = Array.isArray(j) ? j[0] : (j.files ? j.files[0] : j);
        location = (o && o.id) || '';
        link = (o && (o.webViewLink || o.link || o.url)) || '';
      } catch {}
    } else {
      backend = 'box';
      const { stdout } = await execFileAsync(
        'nyx-store', ['upload', tmpPath, '--name', origName],
        { timeout: 900000, maxBuffer: 1 * 1024 * 1024 });
      try { location = (JSON.parse(stdout).box_path) || ''; } catch {}
    }

    const addArgs = ['add',
      '--orig-name', origName,
      '--backend', backend,
      '--location', location || 'unknown',
      '--mime', mime || '',
      '--size', String(sizeBytes || 0),
      '--sender', who.senderName || '',
      '--sender-jid', who.senderJid || '',
      '--chat', who.chatJid || ''];
    if (link) addArgs.push('--link', link);
    if (caption) addArgs.push('--caption', caption);
    try { await execFileAsync('nyx-files', addArgs, { timeout: 15000 }); }
    catch (e) { logger.warn({ err: e.message }, 'nyx-files index failed'); }

    if (backend === 'drive') {
      return link
        ? `\n[Auto-saved to Drive: ${link} — confirm to the user it's saved and share this link.]`
        : `\n[Auto-saved to Drive folder "${DROPBOX_FOLDER}" — confirm to the user it's saved.]`;
    }
    return `\n[Auto-archived to storagebox (${sizeMB}MB — too large for a direct WhatsApp link). Indexed for retrieval; tell the user it's saved. A shareable link can be generated later with: nyx-store promote "${location}".]`;
  } catch (err) {
    logger.error({ err: err.message, origName }, 'archiveMedia failed');
    return `\n[Note: could not auto-save "${origName}" (${sizeMB}MB) — tell the user the file wasn't saved.]`;
  }
}

// ── Media content extraction ──────────────────────────────────────────────────
// Returns { content: string, tempFiles: string[], media: object|null }
// `media` (when set) is a downloaded file to auto-save: { tmpPath, origName,
// mime, sizeBytes, caption }. tempFiles are cleaned up after Claude responds.
// sock is passed for audio to enable media reupload on stale messages.
async function extractContent(msg, sock) {
  const m = msg.message;
  if (!m) return { content: '', tempFiles: [], media: null };

  // Plain text
  const text = m.conversation || m.extendedTextMessage?.text || '';
  if (text) return { content: text, tempFiles: [], media: null };

  // Audio / Voice note — delegate to transcribeMessage (handles MIME + reupload)
  if (m.audioMessage || m.pttMessage) {
    if (!GROQ_API_KEY) {
      return { content: '[voice note - transcription unavailable]', tempFiles: [], media: null };
    }
    const transcript = await transcribeMessage(sock, msg);
    if (!transcript) {
      return { content: '[voice note - could not transcribe]', tempFiles: [], media: null };
    }
    return { content: `[Voice note transcript]: ${transcript}`, tempFiles: [], media: null };
  }

  // Image — always downloaded (and auto-saved); agent can Read it during its turn
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
        media: { tmpPath, origName: `image-${Date.now()}.jpg`, mime: m.imageMessage.mimetype || 'image/jpeg', sizeBytes: buf.length, caption },
      };
    } catch (err) {
      logger.error({ err }, 'Image download failed');
      return { content: caption || '[image - could not download]', tempFiles: [], media: null };
    }
  }

  // Video — stream to disk + auto-save up to BOX_MAX (declared size gates the cap)
  if (m.videoMessage) {
    const caption = m.videoMessage.caption || '';
    const fileLength = m.videoMessage.fileLength ? Number(m.videoMessage.fileLength) : 0;
    if (fileLength === 0 || fileLength <= BOX_MAX_BYTES) {
      const ext = ((m.videoMessage.mimetype || 'video/mp4').split('/')[1] || 'mp4').split(';')[0];
      const tmpPath = path.join(TMP_DIR, `${randomUUID()}.${ext}`);
      try {
        const bytes = await streamDownloadToFile(msg, sock, tmpPath, BOX_MAX_BYTES);
        return {
          content: `User sent a video${caption ? ` Caption: ${caption}` : ''}`,
          tempFiles: [tmpPath],
          media: { tmpPath, origName: `video-${Date.now()}.${ext}`, mime: m.videoMessage.mimetype || 'video/mp4', sizeBytes: bytes, caption },
        };
      } catch (err) {
        logger.error({ err: err.message }, 'Video download failed');
        return { content: `User sent a video${caption ? ` Caption: ${caption}` : ''} — could not save`, tempFiles: [], media: null };
      }
    }
    const sizePart = ` — ${(fileLength / 1024 / 1024).toFixed(1)}MB, too large to auto-save (>${(BOX_MAX_BYTES / 1024 / 1024 / 1024).toFixed(0)}GB)`;
    return { content: `User sent a video${caption ? ` Caption: ${caption}` : ''}${sizePart}`, tempFiles: [], media: null };
  }

  // Document — stream to disk + auto-save up to BOX_MAX
  if (m.documentMessage) {
    const { fileName = 'document', mimetype = 'application/octet-stream', fileLength, caption = '' } = m.documentMessage;
    const declared = fileLength ? Number(fileLength) : 0;
    if (declared === 0 || declared <= BOX_MAX_BYTES) {
      const tmpPath = path.join(TMP_DIR, `${randomUUID()}-${fileName}`);
      try {
        const bytes = await streamDownloadToFile(msg, sock, tmpPath, BOX_MAX_BYTES);
        return {
          content: `User sent a document: ${fileName} (${mimetype}), saved at ${tmpPath}`,
          tempFiles: [tmpPath],
          media: { tmpPath, origName: fileName, mime: mimetype, sizeBytes: bytes, caption },
        };
      } catch (err) {
        logger.error({ err: err.message }, 'Document download failed');
        return { content: `User sent a document: ${fileName} (${mimetype}) — could not save`, tempFiles: [], media: null };
      }
    }
    const sizePart = ` — ${(declared / 1024 / 1024).toFixed(1)}MB, too large to auto-save (>${(BOX_MAX_BYTES / 1024 / 1024 / 1024).toFixed(0)}GB)`;
    return { content: `User sent a document: ${fileName} (${mimetype})${sizePart}`, tempFiles: [], media: null };
  }

  return { content: '', tempFiles: [], media: null };
}

// ── Process one message (serialized per chatId) ───────────────────────────────
async function processMessage(sock, msg) {
  const jid     = msg.key.remoteJid;
  const isGroup = isJidGroup(jid);
  const botJid  = sock.user?.id || '';

  // Extract content — async (may transcribe audio or download media)
  let { content, tempFiles, media } = await extractContent(msg, sock);

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

  // Auto-save any received file to durable storage + index, then tell the agent
  // where it landed so it can confirm to the user with a link.
  if (media) {
    const note = await archiveMedia(media, { senderName, senderJid, chatJid: jid });
    content += note;
  }

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
    markOnlineOnConnect: false,
    usePairingCode: !!PAIRING_PHONE,
    getMessage: async (key) => {
      logger.debug({ key }, 'getMessage called (retry/re-key request)');
      return { conversation: '' };
    },
  });

  activeSock = sock;
  sock.ev.on('creds.update', saveCreds);

  // Request pairing code with retry — WS needs to be open before the call succeeds.
  if (PAIRING_PHONE && !state.creds.registered) {
    const phone = PAIRING_PHONE.replace(/\D/g, '');
    const requestWithRetry = (attempt = 0) => {
      sock.requestPairingCode(phone).then(code => {
        logger.info(`PAIRING CODE: ${code}`);
        process.stdout.write(`\n\n>>> WhatsApp pairing code for ${phone}: ${code} <<<\n\n`);
      }).catch(err => {
        if (attempt < 8) {
          setTimeout(() => requestWithRetry(attempt + 1), 1000 * (attempt + 1));
        } else {
          logger.error({ err }, 'Failed to get pairing code after retries');
        }
      });
    };
    setTimeout(() => requestWithRetry(), 500);
  }

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr && !PAIRING_PHONE) {
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
        logger.error({ credsDir: CREDS_DIR }, 'Logged out — wiping creds to force fresh re-pair on next start');
        try { fs.rmSync(CREDS_DIR, { recursive: true, force: true }); } catch (e) { logger.error({ err: e }, 'failed to wipe creds dir'); }
        process.exit(1);
      }
    } else if (connection === 'open') {
      waConnected = true;
      logger.info({ jid: sock.user?.id }, 'WhatsApp connected');
      startHeartbeat(sock);
      startAuthCheck();
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
    probeClaudeToken,
    AGENT_NAME,
    STARTUP_TIME_MS,
    QUICK_CHECK_MS,
    STARTUP_TIMEOUT_MS,
    ZOMBIE_THRESHOLD_MS,
  };
}
