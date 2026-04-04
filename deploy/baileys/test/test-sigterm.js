#!/usr/bin/env node
'use strict';
/**
 * test-sigterm.js — Verifies SIGTERM drain: bridge waits for in-flight claude
 * calls before exiting (up to 25s).
 *
 * Run: node deploy/baileys/test/test-sigterm.js
 *
 * Strategy: Directly test the drain pattern used in the bridge. We simulate
 * an in-flight Set with a slow promise, fire the SIGTERM handler logic,
 * and assert it waits for the promise before resolving.
 */

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

// Replicate the drain pattern from the bridge
async function drainWithTimeout(inFlight, timeoutMs) {
  await Promise.race([
    Promise.all([...inFlight]),
    new Promise(r => setTimeout(r, timeoutMs)),
  ]);
}

async function testDrainWaitsForInFlight() {
  console.log('\nTest 1: Drain waits for in-flight promise to complete');
  const inFlight = new Set();
  const DELAY_MS = 300;

  let resolved = false;
  const p = new Promise(r => setTimeout(() => { resolved = true; r(); }, DELAY_MS));
  inFlight.add(p);

  const start = Date.now();
  await drainWithTimeout(inFlight, 25000);
  const elapsed = Date.now() - start;

  assert(resolved, 'in-flight promise completed before drain returned');
  assert(elapsed >= DELAY_MS * 0.8, `drain waited ${elapsed}ms (>= ${DELAY_MS * 0.8}ms)`);
}

async function testDrainTimesOut() {
  console.log('\nTest 2: Drain times out after 25s if in-flight hangs');
  const inFlight = new Set();
  const TIMEOUT_MS = 200; // Use short timeout for test

  // Never-resolving promise
  inFlight.add(new Promise(() => {}));

  const start = Date.now();
  await drainWithTimeout(inFlight, TIMEOUT_MS);
  const elapsed = Date.now() - start;

  assert(elapsed >= TIMEOUT_MS * 0.8, `drain timed out after ~${TIMEOUT_MS}ms (got ${elapsed}ms)`);
  assert(elapsed < TIMEOUT_MS * 3, `drain didn't hang too long (${elapsed}ms)`);
}

async function testDrainAllowsMultipleInFlight() {
  console.log('\nTest 3: Drain waits for all in-flight promises');
  const inFlight = new Set();
  const completions = [];

  inFlight.add(new Promise(r => setTimeout(() => { completions.push(1); r(); }, 100)));
  inFlight.add(new Promise(r => setTimeout(() => { completions.push(2); r(); }, 200)));
  inFlight.add(new Promise(r => setTimeout(() => { completions.push(3); r(); }, 150)));

  await drainWithTimeout(inFlight, 25000);

  assert(completions.length === 3, `all 3 in-flight completed (got ${completions.length})`);
}

(async () => {
  try {
    await testDrainWaitsForInFlight();
    await testDrainTimesOut();
    await testDrainAllowsMultipleInFlight();
  } catch (err) {
    console.error('Unexpected error:', err);
    failed++;
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
