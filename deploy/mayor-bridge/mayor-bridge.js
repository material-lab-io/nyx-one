#!/usr/bin/env node
// mayor-bridge — HTTP adapter: container → gt mail → Mayor
// POST /mail  { from, subject, body }
// Auth: Bearer token (MAYOR_BRIDGE_TOKEN env)

const http = require('http');
const { execFile, spawn } = require('child_process');

const PORT = parseInt(process.env.MAYOR_BRIDGE_PORT || '19000', 10);
const TOKEN = process.env.MAYOR_BRIDGE_TOKEN;
const ALLOWED_FROM = ['nyx', 'princess', 'sailor', 'gymbo', 'perhit'];
const GT_DIR = process.env.GT_DIR || '/home/kanaba/gt';
// Direct routing destinations (bypass mayor). Others go to mayor/ with [→to] hint.
const DIRECT_ROUTES = new Set(['cargo_spear/luna', 'sailor/sailor', 'gymbo/coach']);

if (!TOKEN) { console.error('MAYOR_BRIDGE_TOKEN not set'); process.exit(1); }

http.createServer((req, res) => {
  if (req.method !== 'POST' || (req.url !== '/mail' && req.url !== '/email')) {
    res.writeHead(404).end('Not found');
    return;
  }

  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${TOKEN}`) {
    res.writeHead(401).end('Unauthorized');
    return;
  }

  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    let msg;
    try { msg = JSON.parse(body); } catch {
      res.writeHead(400).end('Bad JSON');
      return;
    }

    // ── /email endpoint ──────────────────────────────────────────────────────
    if (req.url === '/email') {
      const { to, subject, body: emailBody, attach } = msg;
      if (!to || !subject || !emailBody) {
        res.writeHead(400).end('Missing required fields: to, subject, body');
        return;
      }
      const sailorPath = '/home/kanaba/gt/sailor/crew/sailor/founding-sales-skills/material-lab';
      const pyCode = `
import sys
sys.path.insert(0, '${sailorPath}')
from gmail.client import GmailClient
from gmail.auth import get_credentials
import json

to = ${JSON.stringify(to)}
subject = ${JSON.stringify(subject)}
body_text = ${JSON.stringify(emailBody)}
attach = ${JSON.stringify(attach || '')}

creds = get_credentials('nyx')
client = GmailClient(credentials=creds)
kwargs = {'to': to, 'subject': subject, 'body_text': body_text}
if attach:
    kwargs['attachments'] = [attach]
client.send_email(**kwargs)
print('ok')
`;
      const child = spawn('python3', ['-c', pyCode], {
        env: { ...process.env, HOME: '/home/kanaba', PATH: `/home/kanaba/.local/bin:${process.env.PATH}` }
      });
      let out = '', errOut = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { errOut += d; });
      child.on('error', err => {
        if (!res.writableEnded) res.writeHead(500).end(`exec error: ${err.message}`);
        console.error(`[mayor-bridge] email exec error: ${err.message}`);
      });
      child.on('close', code => {
        if (res.writableEnded) return;
        if (code === 0) {
          res.writeHead(200).end('ok');
          console.log(`[mayor-bridge] email sent to ${to}: ${subject}`);
        } else {
          res.writeHead(500).end(`email send failed: ${errOut.slice(0, 200)}`);
          console.error(`[mayor-bridge] email failed (${code}): ${errOut.slice(0, 200)}`);
        }
      });
      return;
    }

    // ── /mail endpoint ───────────────────────────────────────────────────────
    const { from, subject, body: text, to } = msg;
    if (!ALLOWED_FROM.includes(from) || !subject || !text) {
      res.writeHead(400).end('Invalid fields');
      return;
    }

    // Route directly if destination is in allowlist, otherwise send to mayor with hint
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

    child.on('error', err => {
      res.writeHead(500).end(`exec error: ${err.message}`);
      console.error(`[mayor-bridge] exec error: ${err.message}`);
    });

    child.on('close', code => {
      if (res.writableEnded) return;
      if (code === 0) {
        res.writeHead(200).end('ok');
        console.log(`[mayor-bridge] ${from}:${subject} → ${mailDest}`);
      } else {
        res.writeHead(500).end('gt mail failed');
        console.error(`[mayor-bridge] gt mail exited ${code}`);
      }
    });
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`mayor-bridge listening on 0.0.0.0:${PORT}`);
});
