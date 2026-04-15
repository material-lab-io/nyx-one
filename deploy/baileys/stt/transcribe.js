'use strict';
/**
 * STT transcription using Groq Whisper (OpenAI-compatible API).
 *
 * Pure functions — no env-var reads. Callers inject apiKey, baseUrl, model.
 */
const { normalizeBaseUrl, fetchWithTimeout, readErrorResponse, mimeToExtension } = require('./utils');

const DEFAULT_GROQ_STT_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_STT_MODEL = 'whisper-large-v3-turbo';
const DEFAULT_TIMEOUT_MS = 60000;

/**
 * Transcribe audio using an OpenAI-compatible STT API.
 *
 * @param {import('./types').AudioTranscriptionRequest} params
 * @returns {Promise<import('./types').AudioTranscriptionResult>}
 * @throws {Error} on HTTP error or empty transcript
 */
async function transcribeAudio(params) {
  const baseUrl = normalizeBaseUrl(params.baseUrl, DEFAULT_GROQ_STT_BASE_URL);
  const url = `${baseUrl}/audio/transcriptions`;
  const model = (params.model && params.model.trim()) || DEFAULT_STT_MODEL;
  const timeoutMs = params.timeoutMs != null ? params.timeoutMs : DEFAULT_TIMEOUT_MS;
  const mime = params.mime || 'audio/ogg';
  const fileName = `audio.${mimeToExtension(mime)}`;

  const form = new FormData();
  // Uint8Array coercion avoids undici multipart breakage with Node.js Buffer
  form.append('file', new Blob([new Uint8Array(params.buffer)], { type: mime }), fileName);
  form.append('model', model);
  if (params.language && params.language.trim()) form.append('language', params.language.trim());
  if (params.prompt && params.prompt.trim()) form.append('prompt', params.prompt.trim());

  const res = await fetchWithTimeout(
    url,
    { method: 'POST', headers: { Authorization: `Bearer ${params.apiKey}` }, body: form },
    timeoutMs,
  );

  if (!res.ok) {
    const detail = await readErrorResponse(res);
    const suffix = detail ? `: ${detail}` : '';
    throw new Error(`Audio transcription failed (HTTP ${res.status})${suffix}`);
  }

  const payload = await res.json();
  const text = payload.text && payload.text.trim();
  if (!text) {
    throw new Error('Audio transcription response missing text');
  }
  return { text, model };
}

module.exports = { transcribeAudio, DEFAULT_GROQ_STT_BASE_URL, DEFAULT_STT_MODEL };
