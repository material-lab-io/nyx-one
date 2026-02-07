/**
 * TTS service using OpenAI-compatible API
 */

import type { TTSSynthesizeRequest, TTSSynthesizeResult } from './types';
import { OPENAI_TTS_VOICES, OPENAI_TTS_MODELS } from './types';

export const DEFAULT_OPENAI_TTS_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_TTS_MODEL = 'gpt-4o-mini-tts';
export const DEFAULT_TTS_VOICE = 'alloy';
const DEFAULT_TIMEOUT_MS = 30000;

function isValidVoice(voice: string): boolean {
  return OPENAI_TTS_VOICES.includes(voice as any);
}

function isValidModel(model: string): boolean {
  return OPENAI_TTS_MODELS.includes(model as any);
}

export async function synthesizeSpeech(
  params: TTSSynthesizeRequest,
): Promise<TTSSynthesizeResult> {
  const baseUrl = (params.baseUrl?.trim() || DEFAULT_OPENAI_TTS_BASE_URL).replace(/\/+$/, '');
  const model = params.model?.trim() || DEFAULT_TTS_MODEL;
  const voice = params.voice?.trim() || DEFAULT_TTS_VOICE;
  const responseFormat = params.responseFormat || 'mp3';
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!isValidModel(model)) {
    throw new Error(`Invalid TTS model: ${model}. Valid: ${OPENAI_TTS_MODELS.join(', ')}`);
  }
  if (!isValidVoice(voice)) {
    throw new Error(`Invalid TTS voice: ${voice}. Valid: ${OPENAI_TTS_VOICES.join(', ')}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: params.text,
        voice,
        response_format: responseFormat,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`TTS API error (${response.status}): ${errorText.slice(0, 200)}`);
    }

    const audio = await response.arrayBuffer();
    return {
      audio,
      model,
      voice,
      format: responseFormat,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function getAvailableVoices(): string[] {
  return [...OPENAI_TTS_VOICES];
}

export function getAvailableModels(): string[] {
  return [...OPENAI_TTS_MODELS];
}
