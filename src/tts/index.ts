export {
  synthesizeSpeech,
  getAvailableVoices,
  getAvailableModels,
  DEFAULT_OPENAI_TTS_BASE_URL,
  DEFAULT_TTS_MODEL,
  DEFAULT_TTS_VOICE,
} from './service';
export type { TTSSynthesizeRequest, TTSSynthesizeResult, OpenAIVoice, OpenAITTSModel } from './types';
export { OPENAI_TTS_VOICES, OPENAI_TTS_MODELS } from './types';
