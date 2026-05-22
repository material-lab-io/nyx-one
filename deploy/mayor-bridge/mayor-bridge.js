#!/usr/bin/env node
// mayor-bridge — HTTP adapter: container → host services
//
// Endpoints (all POST, all Bearer-auth with MAYOR_BRIDGE_TOKEN):
//   /mail                       gt mail to mayor (or direct agent route)
//   /email/send                 gog gmail send (with optional attachment)
//   /email/list                 gog gmail messages search
//   /email/read                 gog gmail get
//   /email/reply                gog gmail send --reply-to-message-id
//   /drive/upload               gog drive upload (decodes base64 payload)
//   /drive/list                 gog drive search
//   /drive/search               alias of /drive/list
//   /drive/download             gog drive download → returns base64
//   /drive/share                gog drive share
//   /gog                        escape hatch: run any gog subcommand
//
// All gog endpoints run under GOG_ACCOUNT (default: nyx@materiallab.io).

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { randomUUID } = require('crypto');

const PORT         = parseInt(process.env.MAYOR_BRIDGE_PORT || '19000', 10);
const TOKEN        = process.env.MAYOR_BRIDGE_TOKEN;
const GT_DIR       = process.env.GT_DIR || '/home/kanaba/gt';
const GOG_BIN      = process.env.GOG_BIN || '/home/kanaba/k8s/openclaw-base/gog';
const GOG_ACCOUNT  = process.env.GOG_ACCOUNT || 'nyx@materiallab.io';
const GOG_TIMEOUT  = parseInt(process.env.GOG_TIMEOUT_MS || '90000', 10);
const GOG_MAX_BUF  = 50 * 1024 * 1024; // 50MB (covers ≤25MB Drive files + base64 overhead)
const ALLOWED_FROM = ['nyx', 'princess', 'sailor', 'gymbo', 'perhit'];
const DIRECT_ROUTES = new Set(['cargo_spear/luna', 'sailor/sailor', 'gymbo/coach']);

if (!TOKEN) { console.error('MAYOR_BRIDGE_TOKEN not set'); process.exit(1); }

// ── Helpers ────────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', d => { chunks.push(d); size += d.length; if (size > 60 * 1024 * 1024) { req.destroy(); reject(new Error('body too large')); } });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function send(res, status, data) {
  if (typeof data === 'string') {
    res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end(data);
  } else {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
}

function runGog(args, { attachPath = null } = {}) {
  return new Promise(resolve => {
    const full = [];
    for (const a of args) full.push(a === '{{ATTACH}}' ? attachPath : a);
    full.push('--account', GOG_ACCOUNT, '--no-input');
    execFile(GOG_BIN, full, {
      env: { ...process.env, HOME: '/home/kanaba' },
      timeout: GOG_TIMEOUT,
      maxBuffer: GOG_MAX_BUF,
    }, (err, stdout, stderr) => {
      resolve({
        exit_code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: (stdout || '').toString(),
        stderr: (stderr || '').toString(),
      });
    });
  });
}

async function withAttachment(b64, filename, fn) {
  if (!b64) return fn(null);
  const safe = (filename || 'attachment.bin').replace(/[^a-zA-Z0-9._-]/g, '_');
  const tmp = path.join(os.tmpdir(), `nyx-gog-${randomUUID()}-${safe}`);
  try {
    fs.writeFileSync(tmp, Buffer.from(b64, 'base64'));
    return await fn(tmp);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function gogReply(res, result) {
  send(res, result.exit_code === 0 ? 200 : 500, result);
}

// ── /mail (Gas Town mail via `gt mail`) ───────────────────────────────────────

async function handleMail(req, res) {
  let msg;
  try { msg = await readBody(req); } catch (e) { return send(res, 400, 'Bad JSON'); }
  const { from, subject, body: text, to } = msg;
  if (!ALLOWED_FROM.includes(from) || !subject || !text) {
    return send(res, 400, 'Invalid fields');
  }

  let mailDest = 'mayor/';
  let mailSubject = `${from}:${subject}`;
  if (to && DIRECT_ROUTES.has(to)) {
    mailDest = to;
    mailSubject = `${from}:${subject}`;
  } else if (to) {
    mailSubject = `${from}:${subject} [→${to}]`;
  }

  const gtBin = process.env.GT_BIN || '/home/kanaba/.local/bin/gt';
  const child = execFile(gtBin, ['mail', 'send', mailDest, '-s', mailSubject, '--stdin'], {
    cwd: GT_DIR,
    env: { ...process.env, HOME: '/home/kanaba', PATH: `/home/kanaba/.local/bin:${process.env.PATH}` }
  });
  child.stdin.write(text);
  child.stdin.end();

  let errOut = '';
  child.stderr?.on('data', d => { errOut += d; });
  child.on('error', err => {
    if (!res.writableEnded) send(res, 500, `exec error: ${err.message}`);
    console.error(`[mayor-bridge] exec error: ${err.message}`);
  });
  child.on('close', code => {
    if (res.writableEnded) return;
    if (code === 0) {
      send(res, 200, 'ok');
      console.log(`[mayor-bridge] ${from}:${subject} → ${mailDest}`);
    } else {
      send(res, 500, `gt mail failed: ${errOut.slice(0, 200)}`);
      console.error(`[mayor-bridge] gt mail exited ${code}: ${errOut.slice(0, 200)}`);
    }
  });
}

// ── /email/* endpoints (gog gmail) ────────────────────────────────────────────

async function handleEmailSend(req, res) {
  let msg;
  try { msg = await readBody(req); } catch (e) { return send(res, 400, { error: 'bad json' }); }
  const { to, subject, body, body_html, reply_to_message_id, attach_base64, attach_filename } = msg;
  if (!to || !subject || (!body && !body_html)) {
    return send(res, 400, { error: 'to, subject, and body (or body_html) required' });
  }
  const args = ['gmail', 'send', '--to', to, '--subject', subject];
  if (body) args.push('--body', body);
  if (body_html) args.push('--body-html', body_html);
  if (reply_to_message_id) args.push('--reply-to-message-id', reply_to_message_id);
  if (attach_base64) args.push('--attach', '{{ATTACH}}');

  const result = await withAttachment(attach_base64, attach_filename, (tmp) => runGog(args, { attachPath: tmp }));
  console.log(`[mayor-bridge] email send to=${to} subject="${subject.slice(0, 60)}" exit=${result.exit_code}`);
  gogReply(res, result);
}

async function handleEmailList(req, res) {
  let msg;
  try { msg = await readBody(req); } catch (e) { return send(res, 400, { error: 'bad json' }); }
  const query = msg.query || 'newer_than:1d';
  const max = String(parseInt(msg.max || 20, 10) || 20);
  const args = ['gmail', 'messages', 'search', query, '--max', max, '--json'];
  gogReply(res, await runGog(args));
}

async function handleEmailRead(req, res) {
  let msg;
  try { msg = await readBody(req); } catch (e) { return send(res, 400, { error: 'bad json' }); }
  if (!msg.message_id) return send(res, 400, { error: 'message_id required' });
  gogReply(res, await runGog(['gmail', 'get', msg.message_id, '--json']));
}

async function handleEmailReply(req, res) {
  let msg;
  try { msg = await readBody(req); } catch (e) { return send(res, 400, { error: 'bad json' }); }
  const { to, subject, body, reply_to_message_id, attach_base64, attach_filename } = msg;
  if (!reply_to_message_id || !body) {
    return send(res, 400, { error: 'reply_to_message_id and body required' });
  }
  const args = ['gmail', 'send', '--reply-to-message-id', reply_to_message_id, '--body', body];
  if (to) args.push('--to', to);
  if (subject) args.push('--subject', subject);
  else args.push('--reply-all');
  if (attach_base64) args.push('--attach', '{{ATTACH}}');
  const result = await withAttachment(attach_base64, attach_filename, (tmp) => runGog(args, { attachPath: tmp }));
  gogReply(res, result);
}

// ── /drive/* endpoints (gog drive) ────────────────────────────────────────────

async function resolveFolderId(folderName) {
  if (!folderName) return null;
  // Drive search query syntax: escape single-quote in the folder name
  const escaped = folderName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const q = `name = '${escaped}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const r = await runGog(['drive', 'search', q, '--max', '1', '--json']);
  if (r.exit_code !== 0) return null;
  try {
    const j = JSON.parse(r.stdout);
    const arr = Array.isArray(j) ? j : (j.files || []);
    if (arr.length && arr[0].id) return arr[0].id;
  } catch {}
  return null;
}

async function handleDriveUpload(req, res) {
  let msg;
  try { msg = await readBody(req); } catch (e) { return send(res, 400, { error: 'bad json' }); }
  const { filename, content_base64, parent_folder_id, parent_folder_name } = msg;
  if (!filename || !content_base64) {
    return send(res, 400, { error: 'filename and content_base64 required' });
  }
  let parentId = parent_folder_id || null;
  if (!parentId && parent_folder_name) {
    parentId = await resolveFolderId(parent_folder_name);
    if (!parentId) {
      return send(res, 404, { error: `folder not found: ${parent_folder_name}` });
    }
  }
  const result = await withAttachment(content_base64, filename, (tmp) => {
    const args = ['drive', 'upload', tmp, '--name', filename, '--json'];
    if (parentId) args.push('--parent', parentId);
    return runGog(args);
  });
  gogReply(res, result);
}

async function handleDriveList(req, res) {
  let msg;
  try { msg = await readBody(req); } catch (e) { return send(res, 400, { error: 'bad json' }); }
  const query = msg.query || '';
  const max = String(parseInt(msg.max || 20, 10) || 20);
  // gog drive search does not include "Shared with me" / shared-drive items;
  // gog drive ls --parent does. Route folder-scoped queries to ls.
  const parentMatch = query.match(/^['"]([^'"]+)['"]\s+in\s+parents$/);
  let args;
  if (msg.parent) {
    args = ['drive', 'ls', '--parent', msg.parent, '--max', max, '--json'];
  } else if (parentMatch) {
    args = ['drive', 'ls', '--parent', parentMatch[1], '--max', max, '--json'];
  } else if (query) {
    args = ['drive', 'search', query, '--max', max, '--json'];
  } else {
    args = ['drive', 'ls', '--max', max, '--json'];
  }
  gogReply(res, await runGog(args));
}

async function handleDriveDownload(req, res) {
  let msg;
  try { msg = await readBody(req); } catch (e) { return send(res, 400, { error: 'bad json' }); }
  if (!msg.file_id) return send(res, 400, { error: 'file_id required' });
  const dir = path.join(os.tmpdir(), `nyx-gog-dl-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const result = await runGog(['drive', 'download', msg.file_id, '--out', dir]);
    if (result.exit_code !== 0) return send(res, 500, result);
    const files = fs.readdirSync(dir);
    if (files.length === 0) return send(res, 500, { error: 'download produced no file', ...result });
    const real = path.join(dir, files[0]);
    const buf = fs.readFileSync(real);
    send(res, 200, {
      name: files[0],
      size: buf.length,
      content_base64: buf.toString('base64'),
      stdout: result.stdout,
    });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

async function handleDriveShare(req, res) {
  let msg;
  try { msg = await readBody(req); } catch (e) { return send(res, 400, { error: 'bad json' }); }
  const { file_id, email, role = 'reader' } = msg;
  if (!file_id || !email) return send(res, 400, { error: 'file_id and email required' });
  // gog accepts reader|writer; accept plan's "editor"/"viewer" too
  const mapped = role === 'editor' || role === 'writer' ? 'writer' : 'reader';
  const args = ['drive', 'share', file_id, '--email', email, '--role', mapped];
  gogReply(res, await runGog(args));
}

// ── /gog (escape hatch) ───────────────────────────────────────────────────────

async function handleGog(req, res) {
  let msg;
  try { msg = await readBody(req); } catch (e) { return send(res, 400, { error: 'bad json' }); }
  const { args, attach_base64, attach_filename } = msg;
  if (!Array.isArray(args) || args.length === 0) {
    return send(res, 400, { error: 'args (non-empty array) required' });
  }
  const result = await withAttachment(attach_base64, attach_filename, (tmp) => runGog(args, { attachPath: tmp }));
  // Escape hatch always returns 200 with the structured result so callers can inspect failures.
  send(res, 200, result);
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

const ROUTES = {
  '/mail':           handleMail,
  '/email/send':     handleEmailSend,
  '/email/list':     handleEmailList,
  '/email/read':     handleEmailRead,
  '/email/reply':    handleEmailReply,
  '/drive/upload':   handleDriveUpload,
  '/drive/list':     handleDriveList,
  '/drive/search':   handleDriveList,
  '/drive/download': handleDriveDownload,
  '/drive/share':    handleDriveShare,
  '/gog':            handleGog,
};

http.createServer((req, res) => {
  if (req.method !== 'POST') {
    return send(res, 404, 'Not found');
  }
  const handler = ROUTES[req.url];
  if (!handler) return send(res, 404, 'Not found');

  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${TOKEN}`) return send(res, 401, 'Unauthorized');

  Promise.resolve(handler(req, res)).catch(err => {
    console.error(`[mayor-bridge] ${req.url} handler error:`, err);
    if (!res.writableEnded) send(res, 500, { error: err.message });
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`mayor-bridge listening on 0.0.0.0:${PORT} (gog=${GOG_BIN}, account=${GOG_ACCOUNT})`);
});
