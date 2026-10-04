// src/provider/tool-call-assembler.js — collect streamed tool-call pieces (Day 16, extended Day 21).
// Shared by every streaming provider so they all produce identical ToolCalls.
import { randomUUID } from 'node:crypto';
import { parseArguments } from './parse-arguments.js';

export class ToolCallAssembler {
  /** @type {Map<string, { id: string, name: string, parts: string[] }>} key → call, insertion-ordered */
  #calls = new Map();

  /**
   * Register the start of a call. `key` is how later fragments refer to it
   * (Ollama: the call itself; OpenAI-style: the `index`). Returns the call's id.
   * @param {string|number} key
   * @param {{ id?: string, name: string }} start
   */
  start(key, { id, name }) {
    const call = { id: id || `call_${randomUUID().slice(0, 8)}`, name, parts: [] };
    this.#calls.set(String(key), call);
    return call.id;
  }

  /** @param {string|number} key */
  has(key) { return this.#calls.has(String(key)); }

  /** @param {string|number} key */
  idFor(key) { return this.#calls.get(String(key))?.id; }

  /** Append an arguments fragment. Empty fragments are ignored. */
  append(key, fragment) {
    const call = this.#calls.get(String(key));
    if (!call) throw new Error(`tool-call fragment for unknown call ${key}`);
    if (fragment) call.parts.push(fragment);
  }

  /**
   * Parse every call's arguments exactly once.
   * @returns {import('../shared/message-schemas.js').ToolCall[]}
   */
  finish() {
    return [...this.#calls.values()].map(({ id, name, parts }) => ({ id, name, ...parseArguments(parts.join('')) }));
  }
}
