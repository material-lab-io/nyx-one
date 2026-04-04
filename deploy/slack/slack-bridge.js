#!/usr/bin/env node
'use strict';
/**
 * slack-bridge — Slack ↔ Claude Code CLI bridge (Princess)
 *
 * Flow: Slack message → ACL check → conversation history → claude -p → reply
 *
 * Environment variables:
 *   SLACK_BOT_TOKEN         Bot OAuth token (xoxb-...)
 *   SLACK_APP_TOKEN         App-level token for Socket Mode (xapp-...)
 *   BRIDGE_DATA_DIR         Persistent data dir. Default: /data/princess
 *   BRIDGE_CLAUDE_WORKDIR   Working dir for claude CLI. Default: /app
 *   BRIDGE_CLAUDE_BIN       Path to claude binary. Default: claude
 *   AGENT_NAME              Agent identifier. Default: princess
 *   AGENT_DISPLAY_NAME      Display name in history. Default: AGENT_NAME
 *   BRIDGE_SLACK_ALLOWLIST  Slack user IDs (U...) comma-separated, or "*" for open
 *   BRIDGE_MAX_HISTORY      Max conversation turns. Default: 20
 *   MAYOR_BRIDGE_URL        Optional mayor bridge endpoint
 *   MAYOR_BRIDGE_TOKEN      Mayor bridge auth token
 */

const { App } = require('@slack/bolt');
const { execFile, spawn } = require('child_process');
const fs   = require('fs');
const http = require('http');
const path = require('path');
const pino = require('pino');

// ── Config ────────────────────────────────────────────────────────────────────
const DATA_DIR     = process.env.BRIDGE_DATA_DIR       || '/data/princess';
const WORKDIR      = process.env.BRIDGE_CLAUDE_WORKDIR || '/app';
const CLAUDE_BIN   = process.env.BRIDGE_CLAUDE_BIN     || 'claude';
const MAX_HISTORY  = parseInt(process.env.BRIDGE_MAX_HISTORY || '20', 10);
const AGENT_NAME   = process.env.AGENT_NAME         || 'princess';
const DISPLAY_NAME = process.env.AGENT_DISPLAY_NAME || AGENT_NAME;

const ALLOWLIST_RAW = process.env.BRIDGE_SLACK_ALLOWLIST || '';
const ALLOWLIST     = ALLOWLIST_RAW.split(',').map(s => s.trim()).filter(Boolean);

const HISTORY_DIR = path.join(DATA_DIR, 'conversations');

// ── Logger ────────────────────────────────────────────────────────────────────
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// ── Shutdown / connection state ───────────────────────────────────────────────
let shuttingDown  = false;
let slackConnected = false;

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
http.createServer((req, res) => {
  const ok = slackConnected && !shuttingDown;
  res.writeHead(ok ? 200 : 503).end(JSON.stringify({ status: ok ? 'ok' : 'not-ready' }));
}).listen(8080, () => {
  logger.info('Health server listening on :8080');
});

// ── ACL ───────────────────────────────────────────────────────────────────────
function isAllowed(userId) {
  if (ALLOWLIST.includes('*') || ALLOWLIST.length === 0) return true;
  return ALLOWLIST.includes(userId);
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

// ── Invoke Claude CLI ─────────────────────────────────────────────────────────
function invokeClaude(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, ['-p', prompt, '--no-markdown'], {
      cwd: WORKDIR,
      env: { ...process.env },
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
        const err = new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`);
        err.stderr = stderr;
        reject(err);
      }
    });

    child.on('error', reject);
  });
}

// ── Process one Slack message (serialized per chatId) ────────────────────────
async function processSlackMessage({ message, say, client }) {
  if (shuttingDown) return;

  const userId  = message.user;
  const text    = message.text || '';
  // Use channel+thread as chatId for thread-aware history
  const chatId  = message.thread_ts
    ? `${message.channel}-${message.thread_ts}`
    : message.channel;

  if (!userId || !text.trim()) return;

  // ACL check
  if (!isAllowed(userId)) {
    logger.info({ userId }, 'Message from non-allowlisted user, ignoring');
    return;
  }

  // Resolve display name
  let senderName = userId;
  try {
    const info = await client.users.info({ user: userId });
    senderName = info.user?.real_name || info.user?.name || userId;
  } catch { /* use userId as fallback */ }

  logger.info({ chatId, sender: senderName }, 'Received message: %s', text.slice(0, 80));

  appendHistory(chatId, 'user', `${senderName}: ${text}`);
  const prompt = buildPrompt(chatId, text, senderName);

  let reply;
  const claudePromise = invokeClaude(prompt);
  inFlight.add(claudePromise);
  try {
    reply = await claudePromise;
  } catch (err) {
    logger.error({ err }, 'Claude invocation failed');
    const errMsg = err.message + (err.stderr || '');
    if (!AUTH_PATTERNS.some(p => p.test(errMsg))) {
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

  appendHistory(chatId, 'assistant', reply);

  // Reply in thread if message is in a thread, otherwise start one
  await say({
    text: reply,
    thread_ts: message.thread_ts || message.ts,
  });

  logger.info({ chatId, replyLen: reply.length }, 'Replied');
}

// ── Slack App setup ───────────────────────────────────────────────────────────
async function startBridge() {
  const app = new App({
    token:     process.env.SLACK_BOT_TOKEN,
    appToken:  process.env.SLACK_APP_TOKEN,
    socketMode: true,
  });

  // Handle DMs and mentions
  app.message(async ({ message, say, client }) => {
    // Only handle DMs or channel messages that mention the bot
    const isDM = message.channel_type === 'im';
    const botUserId = (await client.auth.test()).user_id;
    const isMention = message.text?.includes(`<@${botUserId}>`);

    if (!isDM && !isMention) return;
    if (message.subtype) return; // ignore bot messages, edits, etc.

    enqueueForChat(
      message.thread_ts ? `${message.channel}-${message.thread_ts}` : message.channel,
      () => processSlackMessage({ message, say, client }),
    );
  });

  await app.start();
  slackConnected = true;
  logger.info('Slack connected (Socket Mode)');

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    logger.info('SIGTERM received — draining in-flight requests (up to 25s)');
    shuttingDown = true;
    await Promise.race([
      Promise.all([...inFlight]),
      new Promise(r => setTimeout(r, 25000)),
    ]);
    await app.stop();
    logger.info('Drain complete — exiting');
    process.exit(0);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
fs.mkdirSync(HISTORY_DIR, { recursive: true });
logger.info({ DATA_DIR, WORKDIR, CLAUDE_BIN, AGENT_NAME }, `${AGENT_NAME}-slack-bridge starting`);
startBridge().catch(err => {
  logger.fatal({ err }, 'Fatal startup error');
  process.exit(1);
});
