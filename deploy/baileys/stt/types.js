'use strict';
/**
 * STT (Speech-to-Text) type definitions
 *
 * @typedef {object} AudioTranscriptionRequest
 * @property {Buffer|ArrayBuffer} buffer  - Raw audio bytes
 * @property {string} apiKey              - Bearer token for the STT API
 * @property {string} [mime]              - MIME type, e.g. 'audio/ogg'
 * @property {string} [baseUrl]           - API base URL (default: Groq)
 * @property {string} [model]             - Model name
 * @property {string} [language]          - Language hint (ISO 639-1)
 * @property {string} [prompt]            - Transcription prompt hint
 * @property {number} [timeoutMs]         - Request timeout in ms (default: 60000)
 */

/**
 * @typedef {object} AudioTranscriptionResult
 * @property {string} text   - Transcribed text
 * @property {string} model  - Model used for transcription
 */
