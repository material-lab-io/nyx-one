#!/usr/bin/env node
// mayor-bridge — HTTP adapter: container → gt mail → Mayor
// POST /mail  { from, subject, body }
// Auth: Bearer token (MAYOR_BRIDGE_TOKEN env)

const http = require('http');
const { execFile } = require('child_process');

const PORT = parseInt(process.env.MAYOR_BRIDGE_PORT || '19000', 10);
const TOKEN = process.env.MAYOR_BRIDGE_TOKEN;
const ALLOWED_FROM = ['nyx', 'princess'];
const GT_DIR = process.env.GT_DIR || '/home/kanaba/gt';

if (!TOKEN) { console.error('MAYOR_BRIDGE_TOKEN not set'); process.exit(1); }

http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/mail') {
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

    const { from, subject, body: text } = msg;
    if (!ALLOWED_FROM.includes(from) || !subject || !text) {
      res.writeHead(400).end('Invalid fields');
      return;
    }

    const child = execFile('gt', ['mail', 'send', 'mayor/', '-s', `${from}:${subject}`, '--stdin'], {
      cwd: GT_DIR,
      env: { ...process.env, HOME: '/home/kanaba' }
    });

    child.stdin.write(text);
    child.stdin.end();

    child.on('close', code => {
      if (code === 0) {
        res.writeHead(200).end('ok');
        console.log(`[mayor-bridge] ${from}:${subject} → sent`);
      } else {
        res.writeHead(500).end('gt mail failed');
        console.error(`[mayor-bridge] gt mail exited ${code}`);
      }
    });
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`mayor-bridge listening on 0.0.0.0:${PORT}`);
});
