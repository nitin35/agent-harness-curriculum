// src/tools/tool-registry.js — the one place tools are registered and looked up (Day 9).
import { validateToolDefinition } from '../shared/tool-schemas.js';

/** @typedef {import('../shared/tool-schemas.js').ToolDefinition} ToolDefinition */

export class ToolRegistry {
  /** @type {Map<string, ToolDefinition>} a Map: no prototype keys, real size, insertion order */
  #tools = new Map();

  /**
   * @param {ToolDefinition} def
   * @returns {() => void} an unregister function (Day 22's extensions use it)
   */
  registerTool(def) {
    const check = validateToolDefinition(def);
    if (!check.ok) throw new TypeError(`invalid tool definition: ${check.error}`);
    // Two tools with one name is a bug in OUR code, not model input: throw loudly.
    if (this.#tools.has(def.name)) throw new Error(`a tool named '${def.name}' is already registered`);
    this.#tools.set(def.name, def);
    return () => this.unregisterTool(def.name);
  }

  /** @param {string} name */
  getTool(name) { return this.#tools.get(name); }

  /** @returns {ToolDefinition[]} in registration order */
  getTools() { return [...this.#tools.values()]; }

  /** @param {string} name @returns {boolean} whether something was removed */
  unregisterTool(name) { return this.#tools.delete(name); }

  /**
   * What the provider sends to the model: plain JSON, no functions, no policy.
   * @param {string[]} [enabled] optional allow-list of tool names (settings `tools.enabled`)
   * @returns {import('../shared/message-schemas.js').ToolSpec[]}
   */
  toProviderTools(enabled) {
    return this.getTools()
      .filter((t) => !enabled || enabled.includes(t.name))
      .map(({ name, description, parameters }) => ({ name, description, parameters }));
  }
}
