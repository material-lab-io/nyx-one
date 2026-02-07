/**
 * STT (Speech-to-Text) types for audio transcription
 */

export type AudioTranscriptionRequest = {
  buffer: ArrayBuffer;
  fileName: string;
  mime?: string;
  apiKey: string;
  baseUrl?: string;
  model?: string;
  language?: string;
  prompt?: string;
  timeoutMs?: number;
};

export type AudioTranscriptionResult = {
  text: string;
  model: string;
};
