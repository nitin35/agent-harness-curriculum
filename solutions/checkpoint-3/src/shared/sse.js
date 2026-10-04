// src/shared/sse.js — Server-Sent Events framing (Day 21). Same lesson as NDJSON, different format.
//
// An SSE stream is lines. `data: …` lines accumulate; a BLANK line dispatches one event.
// `event:` names it, `id:` tags it, lines starting with ':' are comments. Lines may end in \n, \r\n or \r.
// (https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation)

export class SseParser {
  #decoder = new TextDecoder('utf-8');
  #buffer = '';
  #data = [];
  #event = '';
  #id = undefined;

  /**
   * @param {Uint8Array} chunk
   * @returns {{ event: string, data: string, id?: string }[]} events completed by this chunk
   */
  push(chunk) {
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    const out = [];
    let nl;
    while ((nl = this.#buffer.search(/\r\n|\r|\n/)) !== -1) {
      // a lone '\r' at the very end might be the first half of '\r\n' — wait for more
      if (this.#buffer[nl] === '\r' && nl === this.#buffer.length - 1) break;
      const width = this.#buffer.startsWith('\r\n', nl) ? 2 : 1;
      const line = this.#buffer.slice(0, nl);
      this.#buffer = this.#buffer.slice(nl + width);
      const ev = this.#line(line);
      if (ev) out.push(ev);
    }
    return out;
  }

  /** End of body: dispatch a final event that had no trailing blank line. */
  flush() {
    this.#buffer += this.#decoder.decode();
    const out = [];
    if (this.#buffer) { const ev = this.#line(this.#buffer); if (ev) out.push(ev); this.#buffer = ''; }
    const last = this.#line('');
    if (last) out.push(last);
    return out;
  }

  #line(line) {
    if (line === '') {
      if (!this.#data.length) { this.#event = ''; return null; }
      const ev = { event: this.#event || 'message', data: this.#data.join('\n') };
      if (this.#id !== undefined) ev.id = this.#id;
      this.#data = [];
      this.#event = '';
      return ev;
    }
    if (line.startsWith(':')) return null; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.#data.push(value);
    else if (field === 'event') this.#event = value;
    else if (field === 'id') this.#id = value;
    return null;
  }
}

/**
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {AsyncGenerator<{ event: string, data: string, id?: string }>}
 */
export async function* readSse(stream) {
  const reader = stream.getReader();
  const parser = new SseParser();
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
