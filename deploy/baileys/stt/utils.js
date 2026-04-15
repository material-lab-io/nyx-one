'use strict';
/**
 * STT utility functions
 */

/** @type {Record<string, string>} */
const MIME_TO_EXT = {
  'audio/ogg':   'ogg',
  'audio/mp4':   'mp4',
  'audio/mpeg':  'mp3',
  'audio/webm':  'webm',
  'audio/wav':   'wav',
  'audio/x-m4a': 'm4a',
  'audio/m4a':   'm4a',
};
const DEFAULT_EXT = 'ogg';
const MAX_ERROR_CHARS = 300;

/**
 * Strip trailing slashes; fall back to `fallback` if `baseUrl` is empty.
 * @param {string|undefined} baseUrl
 * @param {string} fallback
 * @returns {string}
 */
function normalizeBaseUrl(baseUrl, fallback) {
  const raw = (baseUrl && baseUrl.trim()) || fallback;
  return raw.replace(/\/+$/, '');
}

/**
 * fetch() with an AbortController-based timeout.
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read an error response body, truncated to MAX_ERROR_CHARS.
 * Returns undefined if the body is empty or unreadable.
 * @param {Response} res
 * @returns {Promise<string|undefined>}
 */
async function readErrorResponse(res) {
  try {
    const text = await res.text();
    const collapsed = text.replace(/\s+/g, ' ').trim();
    if (!collapsed) return undefined;
    if (collapsed.length <= MAX_ERROR_CHARS) return collapsed;
    return `${collapsed.slice(0, MAX_ERROR_CHARS)}\u2026`;
  } catch {
    return undefined;
  }
}

/**
 * Map a MIME type to a file extension for the multipart filename.
 * @param {string} mime
 * @returns {string}
 */
function mimeToExtension(mime) {
  const base = mime.split(';')[0].trim();
  return MIME_TO_EXT[base] || DEFAULT_EXT;
}

module.exports = { normalizeBaseUrl, fetchWithTimeout, readErrorResponse, mimeToExtension };
