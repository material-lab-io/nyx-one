#!/usr/bin/env node
'use strict';
/**
 * test-stt.js — Verifies the modular STT implementation in deploy/baileys/stt/
 *
 * Run: node deploy/baileys/test/test-stt.js
 */

process.env.LOG_LEVEL = 'warn';

const { transcribeAudio, DEFAULT_GROQ_STT_BASE_URL, DEFAULT_STT_MODEL } = require('../stt');
const { mimeToExtension, fetchWithTimeout, normalizeBaseUrl } = require('../stt/utils');

const DEFAULT_STT_URL = `${DEFAULT_GROQ_STT_BASE_URL}/audio/transcriptions`;

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

// ── Test 1: transcribeAudio calls correct endpoint and returns trimmed text ────
async function testTranscribeAudioCallsCorrectEndpoint() {
  console.log('\nTest 1: transcribeAudio calls Groq API with correct URL and auth');

  let capturedUrl = null;
  let capturedHeaders = null;
  let capturedFormData = null;

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    capturedUrl = url;
    capturedHeaders = opts?.headers || {};
    capturedFormData = opts?.body;
    return { ok: true, json: async () => ({ text: '  Hello world  ' }) };
  };

  try {
    const result = await transcribeAudio({
      buffer: Buffer.from('fake audio bytes'),
      mime: 'audio/ogg',
      apiKey: 'test-groq-key-123',
    });

    assert(capturedUrl === DEFAULT_STT_URL, `called correct URL: ${capturedUrl}`);
    assert(capturedHeaders.Authorization === 'Bearer test-groq-key-123', 'sent correct auth header');
    assert(capturedFormData instanceof FormData, 'sent FormData body');
    assert(result.text === 'Hello world', `returned trimmed transcript: "${result.text}"`);
    assert(result.model === DEFAULT_STT_MODEL, `returned model: "${result.model}"`);
  } finally {
    globalThis.fetch = origFetch;
  }
}

// ── Test 2: transcribeAudio sends correct model and file extension ─────────────
async function testTranscribeAudioModelAndExtension() {
  console.log('\nTest 2: transcribeAudio sends correct model and file extension');

  const appendedFields = {};
  let fileName = null;

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (opts?.body instanceof FormData) {
      for (const [key, value] of opts.body.entries()) {
        appendedFields[key] = value;
        if (key === 'file') fileName = value.name;
      }
    }
    return { ok: true, json: async () => ({ text: 'test' }) };
  };

  try {
    const result = await transcribeAudio({
      buffer: Buffer.from('audio'),
      mime: 'audio/mp4',
      apiKey: 'test-key',
    });
    assert(appendedFields.model === DEFAULT_STT_MODEL, `model field = "${appendedFields.model}"`);
    assert(fileName === 'audio.mp4', `file name = "${fileName}"`);
    assert(result.model === DEFAULT_STT_MODEL, `result.model = "${result.model}"`);
  } finally {
    globalThis.fetch = origFetch;
  }
}

// ── Test 3: transcribeAudio throws on HTTP error ───────────────────────────────
async function testTranscribeAudioThrowsOnHttpError() {
  console.log('\nTest 3: transcribeAudio throws on non-OK HTTP response');

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 429,
    text: async () => 'rate limit exceeded',
  });

  try {
    let threw = false;
    try {
      await transcribeAudio({ buffer: Buffer.from('audio'), mime: 'audio/ogg', apiKey: 'test-key' });
    } catch (err) {
      threw = true;
      assert(err.message.includes('429'), `error includes status code: "${err.message}"`);
    }
    assert(threw, 'throws on non-OK response');
  } finally {
    globalThis.fetch = origFetch;
  }
}

// ── Test 4: transcribeAudio throws on empty transcript ────────────────────────
async function testTranscribeAudioThrowsOnEmptyTranscript() {
  console.log('\nTest 4: transcribeAudio throws when response has no text');

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ text: '   ' }), // whitespace only
  });

  try {
    let threw = false;
    try {
      await transcribeAudio({ buffer: Buffer.from('audio'), mime: 'audio/ogg', apiKey: 'test-key' });
    } catch (err) {
      threw = true;
      assert(err.message.includes('missing text'), `throws with expected message: "${err.message}"`);
    }
    assert(threw, 'throws on whitespace-only transcript');
  } finally {
    globalThis.fetch = origFetch;
  }
}

// ── Test 5: MIME → extension mapping ─────────────────────────────────────────
async function testMimeExtensionMapping() {
  console.log('\nTest 5: MIME → extension mapping is correct');

  const cases = [
    ['audio/ogg',              'ogg'],
    ['audio/ogg; codecs=opus', 'ogg'],
    ['audio/mp4',              'mp4'],
    ['audio/mpeg',             'mp3'],
    ['audio/webm',             'webm'],
    ['audio/x-m4a',            'm4a'],
    ['audio/unknown',          'ogg'], // fallback
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
    await transcribeAudio({ buffer: Buffer.from('x'), mime, apiKey: 'k' });
    assert(actualFileName === `audio.${expectedExt}`, `${mime} → audio.${expectedExt} (got ${actualFileName})`);
  }
  globalThis.fetch = origFetch;
}

// ── Test 6: custom baseUrl is used ────────────────────────────────────────────
async function testCustomBaseUrl() {
  console.log('\nTest 6: custom baseUrl overrides default Groq endpoint');

  let capturedUrl = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    capturedUrl = url;
    return { ok: true, json: async () => ({ text: 'ok' }) };
  };

  try {
    await transcribeAudio({
      buffer: Buffer.from('audio'),
      mime: 'audio/ogg',
      apiKey: 'k',
      baseUrl: 'https://custom.provider.com/v1/',
    });
    assert(
      capturedUrl === 'https://custom.provider.com/v1/audio/transcriptions',
      `custom baseUrl used: ${capturedUrl}`,
    );
  } finally {
    globalThis.fetch = origFetch;
  }
}

// ── Test 7: fetchWithTimeout aborts after timeout ─────────────────────────────
async function testFetchWithTimeout() {
  console.log('\nTest 7: fetchWithTimeout aborts on timeout');

  let abortSignal = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    abortSignal = opts?.signal;
    // Simulate a slow response that will be aborted
    return new Promise((_, reject) => {
      opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  };

  try {
    let threw = false;
    try {
      await fetchWithTimeout('http://example.com', {}, 10); // 10ms timeout
    } catch {
      threw = true;
    }
    assert(threw, 'fetchWithTimeout throws on timeout');
    assert(abortSignal instanceof AbortSignal, 'uses AbortController signal');
  } finally {
    globalThis.fetch = origFetch;
  }
}

(async () => {
  try {
    await testTranscribeAudioCallsCorrectEndpoint();
    await testTranscribeAudioModelAndExtension();
    await testTranscribeAudioThrowsOnHttpError();
    await testTranscribeAudioThrowsOnEmptyTranscript();
    await testMimeExtensionMapping();
    await testCustomBaseUrl();
    await testFetchWithTimeout();
  } catch (err) {
    console.error('Unexpected error:', err);
    failed++;
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
