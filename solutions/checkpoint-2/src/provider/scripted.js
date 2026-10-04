// src/provider/scripted.js — a deterministic provider for tests, evals and the offline demo (Day 13; streaming Day 16).
// It implements the same interface as OllamaProvider, so the loop cannot tell the difference.

/** @typedef {import('../shared/message-schemas.js').ChatResponse} ChatResponse */

/**
 * A script step is one of:
 *   - a ChatResponse
 *   - { delayMs, response }   wait first (abortable) — for abort tests
 *   - { error }               throw this error
 *   - (messages, tools) => ChatResponse   compute the reply from what the loop sent
 */
export class ScriptedProvider {
  /**
   * @param {any[]} script
   * @param {{ model?: string, contextLimit?: number, models?: string[] }} [opts]
   */
  constructor(script = [], { model = 'scripted', contextLimit = 8192, models } = {}) {
    this.script = [...script];
    this.model = model;
    this.contextLimit = contextLimit;
    this.models = models ?? [model];
    /** @type {{ messages: any[], tools: any[] }[]} every call, for assertions */
    this.calls = [];
  }

  /** Build a plain-text reply. */
  static text(content, extra = {}) {
    return { content, toolCalls: [], model: 'scripted', finishReason: 'stop', ...extra };
  }

  /** Build a reply that requests one or more tool calls: toolCalls([name, args, id?], …). */
  static toolCalls(...calls) {
    return {
      content: '',
      toolCalls: calls.map(([name, args, id], i) => ({ id: id ?? `call_${i + 1}`, name, arguments: args })),
      model: 'scripted',
      finishReason: 'tool_calls',
    };
  }

  /** @param {any[]} messages @param {any[]} tools @param {{ signal?: AbortSignal }} [opts] */
  async chat(messages, tools, { signal } = {}) {
    this.calls.push({ messages: structuredClone(messages), tools: structuredClone(tools) });
    const step = this.script.shift();
    if (step === undefined) throw new Error(`ScriptedProvider: script exhausted after ${this.calls.length - 1} replies`);
    if (typeof step === 'function') return step(messages, tools);
    if (step.error) throw step.error;
    if (step.delayMs !== undefined) {
      await sleep(step.delayMs, signal);
      return step.response;
    }
    signal?.throwIfAborted();
    return step;
  }

  /**
   * Streaming twin of chat() (Day 16). The same script steps work; a ChatResponse is replayed as
   * thinking/text deltas (in small pieces) + tool_call_start/delta + done. Extra step forms:
   *   { events: StreamEvent[] }               replay exactly these (e.g. no `done` → a disconnect)
   *   { chunkDelayMs, response }              wait between events (for abort-mid-stream tests)
   * @param {any[]} messages @param {any[]} tools @param {{ signal?: AbortSignal }} [opts]
   */
  async *chatStream(messages, tools, { signal } = {}) {
    this.calls.push({ messages: structuredClone(messages), tools: structuredClone(tools) });
    const step = this.script.shift();
    if (step === undefined) throw new Error(`ScriptedProvider: script exhausted after ${this.calls.length - 1} replies`);
    if (step.error) throw step.error;
    try {
      if (step.delayMs !== undefined) await sleep(step.delayMs, signal);
      const events = step.events ?? toStreamEvents(typeof step === 'function' ? step(messages, tools) : (step.response ?? step));
      for (const ev of events) {
        if (step.chunkDelayMs) await sleep(step.chunkDelayMs, signal);
        signal?.throwIfAborted();
        yield ev;
      }
    } catch (err) {
      if (signal?.aborted) return; // abort ends the stream quietly, like a real provider
      throw err;
    }
  }

  async listModels() {
    return this.models.map((name) => ({ name, capabilities: ['completion', 'tools'] }));
  }

  async getModelInfo(name = this.model) {
    return { name, contextLimit: this.contextLimit, maxContext: this.contextLimit, capabilities: ['completion', 'tools'] };
  }

  setModel(name) { this.model = name; }
}

/**
 * Turn a ChatResponse into the stream a real provider would produce.
 * @param {ChatResponse} response
 * @returns {import('../shared/message-schemas.js').StreamEvent[]}
 */
export function toStreamEvents(response) {
  /** @type {import('../shared/message-schemas.js').StreamEvent[]} */
  const events = [];
  for (const piece of splitPieces(response.thinking ?? '')) events.push({ type: 'thinking_delta', content: piece });
  for (const piece of splitPieces(response.content ?? '')) events.push({ type: 'text_delta', content: piece });
  for (const call of response.toolCalls ?? []) {
    events.push({ type: 'tool_call_start', id: call.id, name: call.name });
    events.push({ type: 'tool_call_delta', id: call.id, argsDelta: JSON.stringify(call.arguments) });
  }
  events.push({ type: 'done', response });
  return events;
}

/** Split text into ~3 pieces so streaming code paths really run. */
function splitPieces(text) {
  if (!text) return [];
  const size = Math.max(1, Math.ceil(text.length / 3));
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/**
 * setTimeout as a promise that rejects with the signal's reason on abort.
 * @param {number} ms @param {AbortSignal} [signal] @returns {Promise<void>}
 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
