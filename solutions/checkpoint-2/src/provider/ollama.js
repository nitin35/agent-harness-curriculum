// src/provider/ollama.js — the only module that knows Ollama's field names (Day 8; chatStream Day 16; listModels Day 18).
import { randomUUID } from 'node:crypto';
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MODEL, DEFAULT_OLLAMA_URL } from '../shared/constants.js';
import { ProviderError, isAbortError } from '../shared/errors.js';
import { parseArguments } from './parse-arguments.js';
import { ToolCallAssembler } from './tool-call-assembler.js';
import { readNdjson } from '../shared/ndjson.js';

/** @typedef {import('../shared/message-schemas.js').AgentMessage} AgentMessage */
/** @typedef {import('../shared/message-schemas.js').ToolSpec} ToolSpec */
/** @typedef {import('../shared/message-schemas.js').ChatResponse} ChatResponse */

/** Ollama's errors for a bad sample from the model (HTTP 500), as opposed to a server fault. */
const MODEL_GLITCH = /error parsing tool call|token repeat limit reached/i;

export class OllamaProvider {
  /** Models that rejected `think` ("… does not support thinking"); requests to them leave it out. */
  #noThink = new Set();

  /**
   * @param {{
   *   baseUrl?: string,
   *   model?: string,
   *   contextWindow?: number,           // sent as options.num_ctx on EVERY request
   *   maxOutputTokens?: number,         // sent as options.num_predict; default: the context window
   *   think?: boolean | 'low' | 'medium' | 'high',   // dropped automatically for models that can't think
   *   fetch?: typeof globalThis.fetch,
   *   onWarn?: (message: string) => void,
   * }} [opts]
   */
  constructor({
    baseUrl = DEFAULT_OLLAMA_URL,
    model = DEFAULT_MODEL,
    contextWindow = DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens = contextWindow,
    think = true,
    fetch = globalThis.fetch,
    onWarn = (m) => console.warn(m),
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.contextWindow = contextWindow;
    this.maxOutputTokens = maxOutputTokens;
    this.think = think;
    this.fetch = fetch;
    this.onWarn = onWarn;
  }

  /**
   * One non-streaming call.
   * @param {AgentMessage[]} messages
   * @param {ToolSpec[]} tools
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<ChatResponse>}
   */
  async chat(messages, tools, { signal } = {}) {
    const res = await this.#postChat(messages, tools, { stream: false }, signal);
    const body = await this.#readJson(res);
    if (!body || typeof body !== 'object' || !body.message || typeof body.message !== 'object') {
      throw new ProviderError(`Unexpected response from Ollama: ${describeShape(body)}`, { kind: 'bad_response' });
    }
    return fromWireResponse(body, this.model);
  }

  /**
   * Streaming call (Day 16). Yields StreamEvents; the last one is { type: 'done', response }.
   * - Ollama sends each tool call WHOLE in its own chunk, and the final `done` chunk does not repeat
   *   them — so we collect them as they pass (ToolCallAssembler) and assemble the response ourselves.
   * - Abort is not an error: the generator simply returns (no `done`). Cleanup runs in readNdjson's finally.
   * - A body that ends without a `done: true` line is a disconnect: that IS an error.
   * @param {AgentMessage[]} messages
   * @param {ToolSpec[]} tools
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {AsyncGenerator<import('../shared/message-schemas.js').StreamEvent>}
   */
  async *chatStream(messages, tools, { signal } = {}) {
    let res;
    try {
      res = await this.#postChat(messages, tools, { stream: true }, signal);
    } catch (err) {
      if (isAbortError(err)) return;
      throw err;
    }
    const assembler = new ToolCallAssembler();
    let content = '';
    let thinking = '';
    let doneChunk = null;
    let lines = 0;
    try {
      // Parsed JSON is `unknown` until checked; Ollama's chunks are read defensively below (chunk?.…).
      for await (const chunk of /** @type {AsyncGenerator<any>} */ (readNdjson(res.body))) {
        lines++;
        // Once streaming, the status is already 200: a failure arrives as an {"error"} line, glitches included.
        if (chunk?.error) throw this.#glitchError(chunk.error) ?? new ProviderError(`Ollama stream error: ${chunk.error}`, { kind: 'http' });
        const m = chunk?.message ?? {};
        if (m.thinking) { thinking += m.thinking; yield { type: 'thinking_delta', content: m.thinking }; }
        if (m.content) { content += m.content; yield { type: 'text_delta', content: m.content }; }
        for (const tc of m.tool_calls ?? []) {
          const key = `ollama-${lines}-${tc.function?.index ?? 0}`;
          const id = assembler.start(key, { id: tc.id, name: String(tc.function?.name ?? '') });
          yield { type: 'tool_call_start', id, name: String(tc.function?.name ?? '') };
          const args = tc.function?.arguments;
          const argsText = typeof args === 'string' ? args : JSON.stringify(args ?? {});
          assembler.append(key, argsText);
          yield { type: 'tool_call_delta', id, argsDelta: argsText };
        }
        if (chunk?.done) { doneChunk = chunk; break; }
      }
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) return;
      throw err;
    }
    if (!doneChunk) {
      throw new ProviderError(`Ollama stream disconnected before done (received ${lines} lines, ${content.length} characters of text)`, {
        kind: 'bad_response',
      });
    }
    const toolCalls = assembler.finish();
    /** @type {ChatResponse} */
    const response = {
      content,
      toolCalls,
      model: doneChunk.model ?? this.model,
      finishReason: toolCalls.length ? 'tool_calls' : (doneChunk.done_reason ?? 'stop'),
    };
    if (thinking) response.thinking = thinking;
    const usage = fromWireUsage(doneChunk);
    if (usage) response.usage = usage;
    yield { type: 'done', response };
  }

  /**
   * The model's real limits. contextLimit is what we will actually get:
   * min(the num_ctx we send, the model's trained maximum).
   * @param {string} [name]
   * @returns {Promise<import('../shared/message-schemas.js').ModelInfo>}
   */
  async getModelInfo(name = this.model) {
    const res = await this.#post('/api/show', { model: name });
    const body = await this.#readJson(res);
    const info = body?.model_info ?? {};
    const key = Object.keys(info).find((k) => k.endsWith('.context_length'));
    const maxContext = key ? Number(info[key]) : null;
    if (maxContext === null) {
      this.onWarn(`could not read a context length for ${name} from /api/show; assuming the requested window (${this.contextWindow})`);
    }
    return {
      name,
      maxContext,
      contextLimit: maxContext === null ? this.contextWindow : Math.min(this.contextWindow, maxContext),
      capabilities: Array.isArray(body?.capabilities) ? body.capabilities : [],
    };
  }

  /** Switch models. Touches provider config only — the loop never holds a model name. */
  setModel(name) {
    if (typeof name !== 'string' || !name) throw new TypeError('setModel needs a model name');
    this.model = name;
  }

  /**
   * The exact request body (exposed for tests and for curious learners).
   * @param {AgentMessage[]} messages @param {ToolSpec[]} tools @param {{ stream: boolean }} opts
   */
  buildRequest(messages, tools, { stream }) {
    const body = {
      model: this.model,
      messages: toWireMessages(messages),
      stream,
      // num_predict bounds the reply. Ollama's default is unlimited: when the window fills it shifts the
      // context and keeps going, so a model that runs away never stops (we watched one go past 5 minutes).
      options: { num_ctx: this.contextWindow, num_predict: this.maxOutputTokens },
    };
    if (this.think !== undefined && !this.#noThink.has(this.model)) body.think = this.think;
    if (tools?.length) body.tools = toWireTools(tools);
    return body;
  }

  /**
   * POST /api/chat. Ollama gives neither of these an error code, so this is the one place we match the
   * server's text: at the boundary, where it turns into state or a precise error.
   *  - A model without the thinking capability rejects `think: true` ("… does not support thinking"):
   *    remember the model, warn once, and retry without `think`.
   *  - A generation glitch ("error parsing tool call", "token repeat limit reached", HTTP 500) is the
   *    model's bad output, not a server fault: a `bad_response` that says so. No automatic retry. We
   *    measured one on qwen2.5:0.5b, and both glitches it met came straight back on the retry.
   */
  async #postChat(messages, tools, { stream }, signal) {
    while (true) {
      try {
        return await this.#post('/api/chat', this.buildRequest(messages, tools, { stream }), signal);
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        if (/does not support thinking/i.test(err.message) && !this.#noThink.has(this.model)) {
          this.#noThink.add(this.model);
          this.onWarn(`${this.model} does not support thinking; sending its requests without \`think\` from now on`);
          continue;
        }
        throw this.#glitchError(err.message, { status: err.status, cause: err }) ?? err;
      }
    }
  }

  /**
   * The model's bad output (see #postChat) as a `bad_response` that says so, or null if `text` isn't a glitch.
   * Used for HTTP errors and for errors that arrive inside a stream (Day 16).
   * @param {string} text
   * @param {{ status?: number, cause?: unknown }} [extra]
   */
  #glitchError(text, extra = {}) {
    const glitch = String(text).match(MODEL_GLITCH)?.[0];
    if (!glitch) return null;
    return new ProviderError(`${this.model} produced output Ollama could not use (${glitch})`, {
      kind: 'bad_response', ...extra,
      hint: 'ask again, rephrase, or use a stronger model (the course model is qwen3.5:4b)',
    });
  }

  async #post(path, body, signal) {
    const url = `${this.baseUrl}${path}`;
    let res;
    try {
      res = await this.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (isAbortError(err)) throw err; // cancellation is not a provider failure
      const code = err?.cause?.code ?? err?.code;
      if (code === 'UND_ERR_HEADERS_TIMEOUT') {
        // Node's fetch waits at most 300 s for response headers. A non-streaming reply arrives all at once,
        // so a very long generation looks like this: the server is up, the model just hasn't finished.
        throw new ProviderError(`No answer from Ollama within 5 minutes (${this.model} may still be generating)`, {
          kind: 'bad_response', cause: err,
          hint: 'lower maxOutputTokens, use streaming (Day 16), or use a faster model',
        });
      }
      if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        throw new ProviderError(`Cannot reach Ollama at ${this.baseUrl} — is Ollama running? (\`ollama serve\`)`, {
          kind: 'unreachable', cause: err,
        });
      }
      throw new ProviderError(`Request to Ollama failed: ${err?.message ?? err}`, { kind: 'http', cause: err });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const model = typeof body?.model === 'string' ? body.model : this.model;
      if (res.status === 404 || /not found/i.test(text)) {
        throw new ProviderError(`Model '${model}' not found — try \`ollama pull ${model}\``, {
          kind: 'model_not_found', status: res.status,
        });
      }
      throw new ProviderError(`Ollama answered HTTP ${res.status}: ${text.slice(0, 300)}`, { kind: 'http', status: res.status });
    }
    return res;
  }

  async #readJson(res) {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new ProviderError(`Unexpected response from Ollama: not JSON (${text.slice(0, 120)})`, { kind: 'bad_response' });
    }
  }
}

// ---------------------------------------------------------------------------
// Pure mapping functions — the role-mapping table from Day 7, in code.

/**
 * Harness messages → Ollama messages.
 * @param {AgentMessage[]} messages
 */
export function toWireMessages(messages) {
  return messages.map((m) => {
    switch (m.role) {
      case 'system':
      case 'user':
        return { role: m.role, content: m.content };
      case 'assistant': {
        const out = { role: 'assistant', content: m.content ?? '' };
        if (m.thinking) out.thinking = m.thinking; // send reasoning back with tool turns
        if (m.toolCalls?.length) {
          out.tool_calls = m.toolCalls.map((c, index) => ({
            id: c.id,
            function: { index, name: c.name, arguments: c.arguments },
          }));
        }
        return out;
      }
      case 'tool_result':
        // Send both keys: tool_name (Ollama's own) and tool_call_id (accepted by 0.32+).
        return { role: 'tool', content: m.content, tool_name: m.toolName, tool_call_id: m.toolCallId };
      default:
        throw new TypeError(`unknown role: ${m.role}`);
    }
  });
}

/** @param {ToolSpec[]} tools */
export function toWireTools(tools) {
  return tools.map(({ name, description, parameters }) => ({
    type: 'function',
    function: { name, description, parameters },
  }));
}

/**
 * Ollama's (non-stream) body → ChatResponse.
 * @param {any} body
 * @param {string} fallbackModel
 * @returns {ChatResponse}
 */
export function fromWireResponse(body, fallbackModel) {
  const msg = body.message ?? {};
  const toolCalls = (msg.tool_calls ?? []).map(fromWireToolCall);
  /** @type {ChatResponse} */
  const response = {
    content: typeof msg.content === 'string' ? msg.content : '',
    toolCalls,
    model: body.model ?? fallbackModel,
    finishReason: toolCalls.length ? 'tool_calls' : (body.done_reason ?? 'stop'),
  };
  if (msg.thinking) response.thinking = msg.thinking;
  const usage = fromWireUsage(body);
  if (usage) response.usage = usage;
  return response;
}

/** One wire tool call → ToolCall. Keeps the server's id; generates one if missing. */
export function fromWireToolCall(tc) {
  const fn = tc?.function ?? {};
  return {
    id: typeof tc?.id === 'string' && tc.id ? tc.id : `call_${randomUUID().slice(0, 8)}`,
    name: String(fn.name ?? ''),
    ...parseArguments(fn.arguments),
  };
}

export function fromWireUsage(body) {
  if (body.prompt_eval_count === undefined && body.eval_count === undefined) return undefined;
  return { promptTokens: body.prompt_eval_count, completionTokens: body.eval_count };
}

function describeShape(value) {
  if (value === null || typeof value !== 'object') return `received ${JSON.stringify(value)?.slice(0, 80)}`;
  return `received an object with keys [${Object.keys(value).join(', ')}] (expected "message")`;
}
