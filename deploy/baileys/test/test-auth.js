#!/usr/bin/env node
'use strict';
/**
 * test-auth.js — Verifies auth error detection and mayor alert
 *
 * Run: node deploy/baileys/test/test-auth.js
 */

const http = require('http');
const path = require('path');

process.env.BRIDGE_DATA_DIR = '/tmp/bridge-test-auth-' + process.pid;
process.env.LOG_LEVEL       = 'warn';
// Point nyx-to-mayor at a mock (handled via PATH injection below)

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ ${msg}`);
    failed++;
  }
}

const { handleClaudeError, AUTH_PATTERNS } = require('../baileys-bridge');

async function testAuthPatternDetection() {
  console.log('\nTest 1: AUTH_PATTERNS detects known auth error strings');

  const authErrors = [
    'Error: 401 Unauthorized',
    'Error: unauthorized access',
    'invalid oauth token',
    'Error: invalid_token: token expired',
    'CLAUDE_CODE_OAUTH_TOKEN is required',
  ];

  for (const msg of authErrors) {
    const matched = AUTH_PATTERNS.some(p => p.test(msg));
    assert(matched, `detects auth error: "${msg.slice(0, 50)}"`);
  }

  const nonAuthErrors = [
    'Internal server error',
    'timeout after 120000ms',
    'ENOENT: no such file or directory',
  ];

  for (const msg of nonAuthErrors) {
    const matched = AUTH_PATTERNS.some(p => p.test(msg));
    assert(!matched, `ignores non-auth error: "${msg}"`);
  }
}

async function testHandleClaudeErrorReturnsAuthMessage() {
  console.log('\nTest 2: handleClaudeError returns correct message for auth failures');

  const authErr = Object.assign(new Error('claude exited 1: Error: 401 Unauthorized'), {
    stderr: 'Error: 401 Unauthorized: invalid oauth token',
  });

  const reply = await handleClaudeError(authErr);
  assert(reply.includes('AI connection is down'), `auth error reply: "${reply}"`);
  assert(reply.includes('Kanaba'), `reply mentions Kanaba: "${reply}"`);
}

async function testHandleClaudeErrorReturnsGenericForNonAuth() {
  console.log('\nTest 3: handleClaudeError returns generic message for non-auth failures');

  const genericErr = Object.assign(new Error('claude exited 2: Internal error'), {
    stderr: 'Internal error',
  });

  const reply = await handleClaudeError(genericErr);
  assert(reply.includes('error'), `generic error reply: "${reply}"`);
  assert(!reply.includes('connection is down'), `non-auth reply is generic: "${reply}"`);
}

async function testMayorAlertFired() {
  console.log('\nTest 4: Mayor alert (nyx-to-mayor) is called on auth error');

  // Track whether nyx-to-mayor was invoked by checking if execFile is called
  // We mock it by patching PATH to use a script that records the call
  const tmpScript = `/tmp/nyx-to-mayor-mock-${process.pid}`;
  const flagFile  = `/tmp/nyx-to-mayor-called-${process.pid}`;
  const { writeFileSync, existsSync, unlinkSync } = require('fs');

  writeFileSync(tmpScript, `#!/bin/bash\ntouch ${flagFile}\n`, { mode: 0o755 });

  // Inject our mock script into PATH
  process.env.PATH = `/tmp:${process.env.PATH}`;
  // Rename it to nyx-to-mayor for the PATH lookup
  const { execSync } = require('child_process');
  execSync(`cp ${tmpScript} /tmp/nyx-to-mayor && chmod +x /tmp/nyx-to-mayor`);

  const authErr = Object.assign(new Error('claude exited 1: 401 Unauthorized'), {
    stderr: '401 Unauthorized',
  });

  await handleClaudeError(authErr);

  // Wait briefly for the async execFile to run
  await new Promise(r => setTimeout(r, 200));

  assert(existsSync(flagFile), 'nyx-to-mayor was called on auth error');

  // Cleanup
  try { unlinkSync(flagFile); } catch {}
  try { unlinkSync('/tmp/nyx-to-mayor'); } catch {}
  try { unlinkSync(tmpScript); } catch {}
}

(async () => {
  try {
    await testAuthPatternDetection();
    await testHandleClaudeErrorReturnsAuthMessage();
    await testHandleClaudeErrorReturnsGenericForNonAuth();
    await testMayorAlertFired();
  } catch (err) {
    console.error('Unexpected error:', err);
    failed++;
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
