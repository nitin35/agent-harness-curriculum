// src/tools/truncate.js — the truncation contract (Day 4; head + tail for command output Day 11; reused Days 10, 25, 28).
import { TRUNCATE_MAX_BYTES } from '../shared/constants.js';

/** The advice at the end of the marker, for a model that has the `read` tool. */
export const DEFAULT_TRUNCATE_HINT = 'Use read with offset/limit or a narrower command to see more.';

/**
 * Keep at most `maxBytes` UTF-8 bytes of `text`, never splitting a character,
 * and tell the model exactly what it is not seeing.
 *
 * @param {string} text
 * @param {number} [maxBytes=32768]
 * @param {{ hint?: string, keep?: 'head' | 'head+tail', totalBytes?: number }} [opts]
 *   hint        replaces the advice; only suggest tools the model actually has
 *   keep        'head' (default) keeps the start. 'head+tail' keeps the start and the end and drops the
 *               middle: command output puts its errors and summaries last (Day 11)
 *   totalBytes  the real size, when the caller already dropped part of the text (bash keeps 2 MiB at most)
 * @returns {{ content: string, truncated: boolean, byteLength: number, shownBytes: number }}
 */
export function truncateText(text, maxBytes = TRUNCATE_MAX_BYTES, { hint = DEFAULT_TRUNCATE_HINT, keep = 'head', totalBytes } = {}) {
  const bytes = Buffer.from(text, 'utf8');
  const byteLength = totalBytes ?? bytes.length;
  if (bytes.length <= maxBytes && byteLength === bytes.length) {
    return { content: text, truncated: false, byteLength, shownBytes: byteLength };
  }

  if (keep === 'head+tail') {
    const headEnd = backToBoundary(bytes, Math.floor(maxBytes / 2));
    const tailStart = forwardToBoundary(bytes, Math.max(headEnd, bytes.length - (maxBytes - headEnd)));
    const head = bytes.subarray(0, headEnd).toString('utf8');
    const tail = bytes.subarray(tailStart).toString('utf8');
    const tailBytes = bytes.length - tailStart;
    const marker = `...[truncated: showing the first ${headEnd} and the last ${tailBytes} of ${byteLength} bytes. ${hint}]`;
    return { content: `${head}\n${marker}\n${tail}`, truncated: true, byteLength, shownBytes: headEnd + tailBytes };
  }

  const cut = backToBoundary(bytes, maxBytes);
  const prefix = bytes.subarray(0, cut).toString('utf8');
  const marker = `...[truncated: showing ${cut} of ${byteLength} bytes. ${hint}]`;
  return { content: `${prefix}\n${marker}`, truncated: true, byteLength, shownBytes: cut };
}

/**
 * Move a cut left until it sits on a character boundary. The byte AT the cut is the first one
 * dropped; if it is a UTF-8 continuation byte (10xxxxxx), its character started before the cut.
 */
function backToBoundary(bytes, cut) {
  let i = Math.min(cut, bytes.length);
  while (i > 0 && i < bytes.length && (bytes[i] & 0b1100_0000) === 0b1000_0000) i--;
  return i;
}

/** Move a cut right until it sits on a character boundary (for the start of a kept tail). */
function forwardToBoundary(bytes, start) {
  let i = start;
  while (i < bytes.length && (bytes[i] & 0b1100_0000) === 0b1000_0000) i++;
  return i;
}
