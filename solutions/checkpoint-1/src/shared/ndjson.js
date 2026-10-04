// src/shared/ndjson.js — NDJSON framing over arbitrary byte chunks (Day 4).
// Chunks know nothing about lines or characters. We own the framing:
// decode incrementally, buffer the partial line, parse complete lines only.

export class NdjsonParser {
  #decoder = new TextDecoder('utf-8');
  #buffer = '';

  /**
   * Feed one chunk; get back every record whose line is now complete.
   * @param {Uint8Array} chunk
   * @returns {unknown[]}
   */
  push(chunk) {
    // { stream: true } keeps a half-received multi-byte character for the next call.
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    const lines = this.#buffer.split('\n');
    this.#buffer = lines.pop() ?? ''; // the last piece may be an incomplete line
    return lines.filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
  }

  /**
   * Call once when the body ends. Returns the trailing record if the body
   * had no final newline, else nothing.
   * @returns {unknown[]}
   */
  flush() {
    this.#buffer += this.#decoder.decode(); // flush any bytes the decoder held back
    const rest = this.#buffer.trim();
    this.#buffer = '';
    return rest === '' ? [] : [JSON.parse(rest)];
  }
}

/**
 * Turn a byte stream (e.g. `response.body`) into parsed NDJSON records.
 * Breaking out of the `for await` cancels the reader (the `finally` runs).
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {AsyncGenerator<unknown>}
 */
export async function* readNdjson(stream) {
  const reader = stream.getReader();
  const parser = new NdjsonParser();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield* parser.push(value);
    }
    yield* parser.flush();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
