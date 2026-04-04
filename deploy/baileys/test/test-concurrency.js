#!/usr/bin/env node
'use strict';
/**
 * test-concurrency.js — Verifies per-chat serialization and cross-chat concurrency
 *
 * Run: BRIDGE_CLAUDE_BIN=./test/mock-claude.sh MOCK_CLAUDE_DELAY=0.5 \
 *      node deploy/baileys/test/test-concurrency.js
 */

const path = require('path');

// Set env before requiring bridge (module exports logic without starting WA)
// Resolve BRIDGE_CLAUDE_BIN to absolute so spawn works regardless of cwd
process.env.BRIDGE_CLAUDE_BIN  = path.resolve(
  process.env.BRIDGE_CLAUDE_BIN || path.join(__dirname, 'mock-claude.sh')
);
process.env.BRIDGE_CLAUDE_WORKDIR = process.env.BRIDGE_CLAUDE_WORKDIR || __dirname;
process.env.MOCK_CLAUDE_MODE   = 'slow';
process.env.MOCK_CLAUDE_DELAY  = process.env.MOCK_CLAUDE_DELAY || '0.5';
process.env.BRIDGE_DATA_DIR    = '/tmp/bridge-test-' + process.pid;
process.env.LOG_LEVEL          = 'warn';

const { enqueueForChat, invokeClaude, chatQueues } = require('../baileys-bridge');

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

async function testSameChatSerialized() {
  console.log('\nTest 1: Same chatId — messages must be processed in order (serialized)');
  const chatId = 'test-chat-serial';
  const results = [];
  const DELAY_MS = parseFloat(process.env.MOCK_CLAUDE_DELAY) * 1000;
  const N = 5;

  const start = Date.now();
  const promises = [];
  for (let i = 0; i < N; i++) {
    const idx = i;
    // Small gap between enqueues to establish ordering
    await new Promise(r => setTimeout(r, 10));
    promises.push(enqueueForChat(chatId, async () => {
      const reply = await invokeClaude(`message ${idx}`);
      results.push(idx);
      return reply;
    }));
  }

  await Promise.all(promises);
  const elapsed = Date.now() - start;

  // Serialized: total time should be >= N * DELAY_MS
  assert(elapsed >= N * DELAY_MS * 0.9, `total time ${elapsed}ms >= ${N * DELAY_MS * 0.9}ms (serialized)`);
  // Results should be in order
  const inOrder = results.every((v, i) => v === i);
  assert(inOrder, `replies in order: [${results.join(',')}]`);
}

async function testDifferentChatsConcurrent() {
  console.log('\nTest 2: Different chatIds — must run concurrently');
  const DELAY_MS = parseFloat(process.env.MOCK_CLAUDE_DELAY) * 1000;
  const N = 3;
  const chatIds = Array.from({ length: N }, (_, i) => `test-chat-concurrent-${i}`);

  const start = Date.now();
  await Promise.all(chatIds.map(chatId =>
    enqueueForChat(chatId, () => invokeClaude('hello'))
  ));
  const elapsed = Date.now() - start;

  // Concurrent: total time should be ~1x DELAY_MS, not N * DELAY_MS
  const maxExpected = DELAY_MS * 2.0; // generous upper bound for CI
  assert(elapsed < maxExpected, `concurrent: ${elapsed}ms < ${maxExpected}ms (not serialized)`);
  assert(elapsed >= DELAY_MS * 0.7, `concurrent: ${elapsed}ms >= ${DELAY_MS * 0.7}ms (actually ran)`);
}

(async () => {
  try {
    await testSameChatSerialized();
    await testDifferentChatsConcurrent();
  } catch (err) {
    console.error('Unexpected error:', err);
    failed++;
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
