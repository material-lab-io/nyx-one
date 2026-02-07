/**
 * TTS (Text-to-Speech) types
 */

export type TTSSynthesizeRequest = {
  text: string;
  apiKey: string;
  baseUrl?: string;
  model?: string;
  voice?: string;
  responseFormat?: 'mp3' | 'opus' | 'pcm';
  timeoutMs?: number;
};

export type TTSSynthesizeResult = {
  audio: ArrayBuffer;
  model: string;
  voice: string;
  format: string;
};

export const OPENAI_TTS_VOICES = ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'] as const;
export type OpenAIVoice = (typeof OPENAI_TTS_VOICES)[number];

export const OPENAI_TTS_MODELS = ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'] as const;
export type OpenAITTSModel = (typeof OPENAI_TTS_MODELS)[number];
