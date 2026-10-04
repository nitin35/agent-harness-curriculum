// src/provider/openai-compatible.js — the OpenAI Chat Completions dialect (Day 21).
// Works with Ollama's /v1 endpoint, LM Studio, vLLM, llama.cpp's server, and hosted APIs that speak it.
import { randomUUID } from 'node:crypto';
import { DEFAULT_MODEL } from '../shared/constants.js';

// Over /v1 you cannot send a context window: the server uses its own. Assume a small default (Ollama's
// is 4096) unless you set contextWindow to match a server YOU configured. The budget then can't over-trust.
export const OPENAI_COMPAT_DEFAULT_WINDOW = 4096;
import { ProviderError, isAbortError } from '../shared/errors.js';
import { readSse } from '../shared/sse.js';
import { parseArguments } from './parse-arguments.js';
import { ToolCallAssembler } from './tool-call-assembler.js';

/** @typedef {import('../shared/message-schemas.js').AgentMessage} AgentMessage */
/** @typedef {import('../shared/message-schemas.js').ToolSpec} ToolSpec */
/** @typedef {import('../shared/message-schemas.js').ChatResponse} ChatResponse */

export class OpenAICompatibleProvider {
  /**
   * @param {{
   *   baseUrl?: string,            // e.g. http://localhost:11434/v1 (Ollama), http://localhost:1234/v1 (LM Studio)
   *   apiKey?: string,             // read from an env var by the caller — never from a repo file
   *   model?: string,
   *   contextWindow?: number,      // this API has no standard way to ASK for a window; configure the server (default 4096)
   *   maxOutputTokens?: number,     // sent as max_tokens; default: the context window. Without it a runaway never stops
   *   fetch?: typeof globalThis.fetch,
   *   onWarn?: (m: string) => void,
   * }} [opts]
   */
  constructor({ baseUrl = 'http://localhost:11434/v1', apiKey, model = DEFAULT_MODEL, contextWindow = OPENAI_COMPAT_DEFAULT_WINDOW, maxOutputTokens, fetch = globalThis.fetch, onWarn = (m) => console.warn(m) } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.model = model;
    this.contextWindow = contextWindow;
    this.maxOutputTokens = maxOutputTokens ?? contextWindow;
    this.fetch = fetch;
    this.onWarn = onWarn;
  }

  buildRequest(messages, tools, { stream }) {
    const body = { model: this.model, messages: toWireMessages(messages), stream, max_tokens: this.maxOutputTokens };
    if (stream) body.stream_options = { include_usage: true };
    if (tools?.length) body.tools = tools.map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters } }));
    return body;
  }

  /** @param {AgentMessage[]} messages @param {ToolSpec[]} tools @param {{ signal?: AbortSignal }} [opts] @returns {Promise<ChatResponse>} */
  async chat(messages, tools, { signal } = {}) {
    const res = await this.#request('POST', '/chat/completions', this.buildRequest(messages, tools, { stream: false }), signal);
    const body = await readJson(res);
    const choice = body?.choices?.[0];
    if (!choice?.message) throw new ProviderError(`Unexpected response: no choices[0].message (keys: ${Object.keys(body ?? {}).join(', ')})`, { kind: 'bad_response' });
    const m = choice.message;
    const toolCalls = (m.tool_calls ?? []).map((tc) => ({ id: tc.id || `call_${randomUUID().slice(0, 8)}`, name: tc.function?.name ?? '', ...parseArguments(tc.function?.arguments) }));
    /** @type {ChatResponse} */
    const response = { content: m.content ?? '', toolCalls, model: body.model ?? this.model, finishReason: toolCalls.length ? 'tool_calls' : (choice.finish_reason ?? 'stop') };
    const thinking = m.reasoning ?? m.reasoning_content;
    if (thinking) response.thinking = thinking;
    if (body.usage) response.usage = { promptTokens: body.usage.prompt_tokens, completionTokens: body.usage.completion_tokens };
    return response;
  }

  /**
   * SSE stream. Tool calls arrive as FRAGMENTS keyed by `index`: the first fragment of a call carries
   * its id and name, later ones carry pieces of the arguments STRING. Parse once, at the end.
   * @param {AgentMessage[]} messages @param {ToolSpec[]} tools @param {{ signal?: AbortSignal }} [opts]
   * @returns {AsyncGenerator<import('../shared/message-schemas.js').StreamEvent>}
   */
  async *chatStream(messages, tools, { signal } = {}) {
    let res;
    try {
      res = await this.#request('POST', '/chat/completions', this.buildRequest(messages, tools, { stream: true }), signal);
    } catch (err) {
      if (isAbortError(err)) return;
      throw err;
    }
    const assembler = new ToolCallAssembler();
    let content = '';
    let thinking = '';
    let finishReason;
    let usage;
    let model = this.model;
    let sawDone = false;
    try {
      for await (const ev of readSse(res.body)) {
        if (ev.data === '[DONE]') { sawDone = true; break; }
        let chunk;
        try { chunk = JSON.parse(ev.data); } catch { throw new ProviderError(`bad SSE data: ${ev.data.slice(0, 120)}`, { kind: 'bad_response' }); }
        if (chunk.error) throw new ProviderError(`stream error: ${chunk.error.message ?? JSON.stringify(chunk.error)}`, { kind: 'http' });
        if (chunk.model) model = chunk.model;
        if (chunk.usage) usage = { promptTokens: chunk.usage.prompt_tokens, completionTokens: chunk.usage.completion_tokens };
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const d = choice.delta ?? {};
        const r = d.reasoning ?? d.reasoning_content;
        if (r) { thinking += r; yield { type: 'thinking_delta', content: r }; }
        if (d.content) { content += d.content; yield { type: 'text_delta', content: d.content }; }
        for (const tc of d.tool_calls ?? []) {
          const key = tc.index ?? 0;
          if (!assembler.has(key)) {
            const id = assembler.start(key, { id: tc.id, name: tc.function?.name ?? '' });
            yield { type: 'tool_call_start', id, name: tc.function?.name ?? '' };
          }
          const frag = tc.function?.arguments;
          if (frag) {
            assembler.append(key, frag);
            yield { type: 'tool_call_delta', id: assembler.idFor(key), argsDelta: frag };
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) return;
      throw err;
    }
    if (!sawDone && !finishReason) {
      throw new ProviderError('stream disconnected before [DONE]', { kind: 'bad_response' });
    }
    const toolCalls = assembler.finish();
    /** @type {ChatResponse} */
    const response = { content, toolCalls, model, finishReason: toolCalls.length ? 'tool_calls' : (finishReason ?? 'stop') };
    if (thinking) response.thinking = thinking;
    if (usage) response.usage = usage;
    yield { type: 'done', response };
  }

  async listModels() {
    const res = await this.#request('GET', '/models');
    const body = await readJson(res);
    return (body?.data ?? []).map((m) => ({ name: String(m.id) }));
  }

  /** This API has no standard context-length field: report the configured window and say so. */
  async getModelInfo(name = this.model) {
    return { name, contextLimit: this.contextWindow, maxContext: null, capabilities: [] };
  }

  setModel(name) { this.model = name; }

  async #request(method, path, body, signal) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    let res;
    try {
      res = await this.fetch(`${this.baseUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal });
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new ProviderError(`Cannot reach ${this.baseUrl} — is the server running?`, { kind: 'unreachable', cause: err });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) throw new ProviderError(`${this.baseUrl} rejected the API key (HTTP ${res.status})`, { kind: 'http', status: res.status });
      if (res.status === 404) throw new ProviderError(`Model '${this.model}' not found at ${this.baseUrl} (${text.slice(0, 120)})`, { kind: 'model_not_found', status: 404 });
      throw new ProviderError(`${this.baseUrl} answered HTTP ${res.status}: ${text.slice(0, 300)}`, { kind: 'http', status: res.status });
    }
    return res;
  }
}

/** Harness messages → OpenAI messages. Arguments go out as a JSON STRING; results key by tool_call_id. */
export function toWireMessages(messages) {
  return messages.map((m) => {
    switch (m.role) {
      case 'system':
      case 'user':
        return { role: m.role, content: m.content };
      case 'assistant': {
        const out = { role: 'assistant', content: m.content ?? '' };
        if (m.toolCalls?.length) {
          out.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } }));
        }
        return out;
      }
      case 'tool_result':
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      default:
        throw new TypeError(`unknown role: ${m.role}`);
    }
  });
}

async function readJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new ProviderError(`Unexpected response: not JSON (${text.slice(0, 120)})`, { kind: 'bad_response' }); }
}
