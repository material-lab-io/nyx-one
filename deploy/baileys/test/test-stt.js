#!/usr/bin/env node
'use strict';
/**
 * test-stt.js — Verifies Groq Whisper transcription in baileys-bridge
 *
 * Run: node deploy/baileys/test/test-stt.js
 */

process.env.BRIDGE_DATA_DIR = '/tmp/bridge-test-stt-' + process.pid;
process.env.LOG_LEVEL       = 'warn';

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

// ── Test 1: transcribeGroq returns null when GROQ_API_KEY is unset ─────────────
async function testNoApiKeyReturnsNull() {
  console.log('\nTest 1: transcribeGroq returns null when GROQ_API_KEY is not set');
  delete process.env.GROQ_API_KEY;

  const { transcribeGroq } = require('../baileys-bridge');
  const result = await transcribeGroq(Buffer.from('fake audio'), 'audio/ogg');
  assert(result === null, 'returns null without API key');
}

// ── Test 2: transcribeGroq calls Groq with correct URL and auth header ─────────
async function testTranscribeGroqCallsCorrectEndpoint() {
  console.log('\nTest 2: transcribeGroq calls Groq API with correct URL and auth');

  process.env.GROQ_API_KEY = 'test-groq-key-123';
  // Clear module cache so it picks up the new env var
  Object.keys(require.cache).forEach(k => { if (k.includes('baileys-bridge')) delete require.cache[k]; });

  const { transcribeGroq, GROQ_STT_URL, STT_MODEL } = require('../baileys-bridge');

  let capturedUrl = null;
  let capturedHeaders = null;
  let capturedFormData = null;

  // Patch global fetch
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    capturedUrl = url;
    capturedHeaders = opts?.headers || {};
    capturedFormData = opts?.body;
    // Return a successful mock response
    return {
      ok: true,
      json: async () => ({ text: '  Hello world  ' }),
    };
  };

  try {
    const result = await transcribeGroq(Buffer.from('fake audio bytes'), 'audio/ogg');

    assert(capturedUrl === GROQ_STT_URL, `called correct URL: ${capturedUrl}`);
    assert(capturedHeaders.Authorization === 'Bearer test-groq-key-123', 'sent correct auth header');
    assert(capturedFormData instanceof FormData, 'sent FormData body');
    assert(result === 'Hello world', `returned trimmed transcript: "${result}"`);
  } finally {
    globalThis.fetch = origFetch;
  }
}

// ── Test 3: transcribeGroq uses correct model and extension ───────────────────
async function testTranscribeGroqModelAndExtension() {
  console.log('\nTest 3: transcribeGroq sends correct model and file extension');

  process.env.GROQ_API_KEY = 'test-key';
  Object.keys(require.cache).forEach(k => { if (k.includes('baileys-bridge')) delete require.cache[k]; });
  const { transcribeGroq, STT_MODEL } = require('../baileys-bridge');

  const appendedFields = {};
  let fileName = null;

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    // Inspect the FormData entries
    if (opts?.body instanceof FormData) {
      for (const [key, value] of opts.body.entries()) {
        appendedFields[key] = value;
        if (key === 'file') fileName = value.name;
      }
    }
    return { ok: true, json: async () => ({ text: 'test' }) };
  };

  try {
    await transcribeGroq(Buffer.from('audio'), 'audio/mp4');
    assert(appendedFields.model === STT_MODEL, `model field = "${appendedFields.model}"`);
    assert(fileName === 'audio.mp4', `file name = "${fileName}"`);
  } finally {
    globalThis.fetch = origFetch;
  }
}

// ── Test 4: transcribeGroq throws on HTTP error ───────────────────────────────
async function testTranscribeGroqThrowsOnHttpError() {
  console.log('\nTest 4: transcribeGroq throws on non-OK HTTP response');

  process.env.GROQ_API_KEY = 'test-key';
  Object.keys(require.cache).forEach(k => { if (k.includes('baileys-bridge')) delete require.cache[k]; });
  const { transcribeGroq } = require('../baileys-bridge');

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 429,
    text: async () => 'rate limit exceeded',
  });

  try {
    let threw = false;
    try {
      await transcribeGroq(Buffer.from('audio'), 'audio/ogg');
    } catch (err) {
      threw = true;
      assert(err.message.includes('429'), `error includes status code: "${err.message}"`);
    }
    assert(threw, 'throws on non-OK response');
  } finally {
    globalThis.fetch = origFetch;
  }
}

// ── Test 5: transcribeGroq returns null on empty transcript ───────────────────
async function testTranscribeGroqReturnsNullOnEmpty() {
  console.log('\nTest 5: transcribeGroq returns null when response has no text');

  process.env.GROQ_API_KEY = 'test-key';
  Object.keys(require.cache).forEach(k => { if (k.includes('baileys-bridge')) delete require.cache[k]; });
  const { transcribeGroq } = require('../baileys-bridge');

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ text: '   ' }), // whitespace only
  });

  try {
    const result = await transcribeGroq(Buffer.from('audio'), 'audio/ogg');
    assert(result === null, `returns null on whitespace-only transcript: ${JSON.stringify(result)}`);
  } finally {
    globalThis.fetch = origFetch;
  }
}

// ── Test 6: ogg MIME maps to .ogg extension ───────────────────────────────────
async function testMimeExtensionMapping() {
  console.log('\nTest 6: MIME → extension mapping is correct');

  process.env.GROQ_API_KEY = 'test-key';
  Object.keys(require.cache).forEach(k => { if (k.includes('baileys-bridge')) delete require.cache[k]; });
  const { transcribeGroq } = require('../baileys-bridge');

  const cases = [
    ['audio/ogg', 'ogg'],
    ['audio/ogg; codecs=opus', 'ogg'],
    ['audio/mp4', 'mp4'],
    ['audio/mpeg', 'mp3'],
    ['audio/webm', 'webm'],
    ['audio/x-m4a', 'm4a'],
    ['audio/unknown', 'ogg'], // fallback
  ];

  const origFetch = globalThis.fetch;
  for (const [mime, expectedExt] of cases) {
    let actualFileName = null;
    globalThis.fetch = async (url, opts) => {
      if (opts?.body instanceof FormData) {
        for (const [key, value] of opts.body.entries()) {
          if (key === 'file') actualFileName = value.name;
        }
      }
      return { ok: true, json: async () => ({ text: 'hi' }) };
    };
    await transcribeGroq(Buffer.from('x'), mime);
    assert(actualFileName === `audio.${expectedExt}`, `${mime} → audio.${expectedExt} (got ${actualFileName})`);
  }
  globalThis.fetch = origFetch;
}

(async () => {
  try {
    await testNoApiKeyReturnsNull();
    await testTranscribeGroqCallsCorrectEndpoint();
    await testTranscribeGroqModelAndExtension();
    await testTranscribeGroqThrowsOnHttpError();
    await testTranscribeGroqReturnsNullOnEmpty();
    await testMimeExtensionMapping();
  } catch (err) {
    console.error('Unexpected error:', err);
    failed++;
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
