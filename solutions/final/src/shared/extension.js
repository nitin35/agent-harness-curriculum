// src/shared/extension.js — the API an extension receives (Day 22).
import { isCanonicalEvent } from './events.js';

/**
 * An extension is an ES module whose default export is a (possibly async) factory:
 *   export default function (api) { api.registerTool({...}); api.on('session_start', …); }
 * Optional: export const meta = { name: 'git-status', description: '…' }
 *
 * @typedef {object} ExtensionAPI
 * @property {string} name                                       this extension's name
 * @property {string} cwd                                        the workspace root
 * @property {(event: string, handler: (payload: any) => unknown) => void} on   canonical names ONLY (unknown → throws)
 * @property {(def: import('./tool-schemas.js').ToolDefinition) => void} registerTool
 * @property {(def: import('./commands.js').CommandDefinition) => void} registerCommand
 * @property {(content: string, opts?: { as?: 'queue'|'note' }) => void} sendMessage
 *           'queue' → becomes a user turn (queued if a run is in flight — never a re-entrant run());
 *           'note'  → appended to the session WITHOUT running the model
 * @property {{ notify: (text: string) => void, confirm: (question: string) => Promise<boolean> }} ui
 *           confirm() is for extension UX only — tool approval ALWAYS goes through the approval gate
 */

/**
 * Build one extension's API, recording everything it registers so unload can undo it exactly.
 * @param {{
 *   name: string, cwd: string,
 *   registry: import('../tools/tool-registry.js').ToolRegistry,
 *   commands: import('../commands/registry.js').CommandRegistry,
 *   bus: import('../events/event-bus.js').EventBus,
 *   submit: (content: string) => void,
 *   appendNote: (content: string) => unknown,
 *   ui: { printSystem: (t: string) => void, ask: (q: string) => Promise<string> },
 * }} deps
 * @returns {{ api: ExtensionAPI, undo: () => void }}
 */
export function createExtensionApi({ name, cwd, registry, commands, bus, submit, appendNote, ui }) {
  /** @type {Array<() => void>} */
  const undos = [];
  const api = {
    name,
    cwd,
    on(event, handler) {
      if (!isCanonicalEvent(event)) throw new TypeError(`extension ${name}: unknown event '${event}' (see src/shared/events.js)`);
      undos.push(bus.on(event, handler));
    },
    registerTool(def) { undos.push(registry.registerTool(def)); },
    registerCommand(def) { undos.push(commands.register(def)); },
    sendMessage(content, { as = 'queue' } = {}) {
      if (as === 'note') void appendNote(`[note from ${name}] ${content}`);
      else submit(content); // the bridge queues it if a run is in flight: no re-entrant run()
    },
    ui: {
      notify: (text) => ui.printSystem(`[${name}] ${text}`),
      confirm: async (question) => (await ui.ask(`  [${name}] ${question} [y/N] `)).trim().toLowerCase() === 'y',
    },
  };
  return {
    api: Object.freeze(api),
    undo: () => { for (const u of undos.splice(0).reverse()) { try { u(); } catch { /* already gone */ } } },
  };
}
