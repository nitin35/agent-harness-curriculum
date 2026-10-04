// toy/ollama.mjs — the toy's provider (Day 2 module, Day 3 abort, Day 4 streaming).
import { readNdjson } from '../src/shared/ndjson.js';

/** The fields of one streamed Ollama chunk that the toy reads. Day 7 pins the full shape from real captures. */
/** @typedef {{ message?: { content?: string, thinking?: string, tool_calls?: object[] }, done?: boolean }} OllamaChunk */

/**
 * @param {{ model: string, url?: string, numCtx?: number, fetch?: typeof globalThis.fetch }} opts
 */
export function createOllamaClient({ model, url = 'http://localhost:11434', numCtx = 8192, fetch = globalThis.fetch }) {
  let think = true; // switched off for good if the model says it can't think (Day 8 does this properly)

  /**
   * Stream one assistant reply. Calls onThinking/onText as text arrives,
   * resolves to the full assistant message (content + tool_calls).
   * @param {object[]} messages
   * @param {object[]} tools
   * @param {{ signal?: AbortSignal, onText?: (s: string) => void, onThinking?: (s: string) => void }} [opts]
   */
  async function chat(messages, tools, { signal, onText = () => {}, onThinking = () => {} } = {}) {
    const post = () => fetch(`${url}/api/chat`, {
      method: 'POST',
      signal,
      body: JSON.stringify({ model, messages, tools, stream: true, think, options: { num_ctx: numCtx } }),
    });
    let res = await post();
    if (!res.ok && think) {
      const text = await res.text();
      // A model without the thinking capability answers 400 "… does not support thinking". Stop asking, and retry.
      if (!/does not support thinking/.test(text)) throw new Error(`Ollama answered ${res.status}: ${text}`);
      think = false;
      res = await post();
    }
    if (!res.ok) throw new Error(`Ollama answered ${res.status}: ${await res.text()}`);

    const reply = { role: 'assistant', content: '', thinking: '', tool_calls: [] };
    for await (const chunk of readNdjson(res.body)) {
      const m = /** @type {OllamaChunk} */ (chunk).message ?? {};
      if (m.thinking) { reply.thinking += m.thinking; onThinking(m.thinking); }
      if (m.content) { reply.content += m.content; onText(m.content); }
      // Tool calls arrive whole, one chunk each — and the final `done` chunk does NOT repeat them.
      if (m.tool_calls) reply.tool_calls.push(...m.tool_calls);
    }
    return reply;
  }

  return { chat, model };
}
