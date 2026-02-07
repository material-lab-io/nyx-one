/**
 * STT transcription using Groq Whisper (OpenAI-compatible API)
 */

import type { AudioTranscriptionRequest, AudioTranscriptionResult } from './types';
import { normalizeBaseUrl, fetchWithTimeout, readErrorResponse, basename } from './utils';

export const DEFAULT_GROQ_STT_BASE_URL = 'https://api.groq.com/openai/v1';
export const DEFAULT_STT_MODEL = 'whisper-large-v3-turbo';
const DEFAULT_TIMEOUT_MS = 60000;

export async function transcribeAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const baseUrl = normalizeBaseUrl(params.baseUrl, DEFAULT_GROQ_STT_BASE_URL);
  const url = `${baseUrl}/audio/transcriptions`;
  const model = params.model?.trim() || DEFAULT_STT_MODEL;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const form = new FormData();
  const fileName = params.fileName?.trim() || basename(params.fileName) || 'audio';
  const bytes = new Uint8Array(params.buffer);
  const blob = new Blob([bytes], {
    type: params.mime ?? 'application/octet-stream',
  });
  form.append('file', blob, fileName);
  form.append('model', model);
  if (params.language?.trim()) form.append('language', params.language.trim());
  if (params.prompt?.trim()) form.append('prompt', params.prompt.trim());

  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: form,
    },
    timeoutMs,
  );

  if (!res.ok) {
    const detail = await readErrorResponse(res);
    const suffix = detail ? `: ${detail}` : '';
    throw new Error(`Audio transcription failed (HTTP ${res.status})${suffix}`);
  }

  const payload = (await res.json()) as { text?: string };
  const text = payload.text?.trim();
  if (!text) {
    throw new Error('Audio transcription response missing text');
  }
  return { text, model };
}
