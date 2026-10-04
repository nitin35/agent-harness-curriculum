// src/agent/agent-schemas.js — what the loop takes and returns (Day 12; abort fields Day 13).

/**
 * Approval hook. Day 12: a tiny y/N prompt in a script. Day 20: the real approval gate.
 * Resolve `true` to run the tool, `false` (or { approved:false, reason }) to deny.
 * `by: 'policy'` marks a refusal no human made (a rule, a mode, nobody to ask): the loop then says
 * "Denied <tool> (<reason>)" instead of "User denied <tool>".
 * @typedef {(call: import('../shared/message-schemas.js').ToolCall,
 *            tool: import('../shared/tool-schemas.js').ToolDefinition,
 *            opts: { signal?: AbortSignal }) => Promise<boolean | { approved: boolean, reason?: string, by?: 'user' | 'policy', unanswered?: boolean }>} ApproveFn
 */

/**
 * @typedef {object} AgentOptions
 * @property {import('../shared/message-schemas.js').Provider} provider
 * @property {import('../tools/tool-registry.js').ToolRegistry} registry
 * @property {string | (() => string | Promise<string>)} [systemPrompt]
 * @property {number} [maxTurns]            default 20
 * @property {ApproveFn} [approve]          missing → needsApproval tools are DENIED (fail closed)
 * @property {boolean} [autoApprove]        skip approval entirely (explicit opt-in only)
 * @property {string[]} [enabledTools]      allow-list of tool names (settings tools.enabled)
 * @property {(event: string, payload: object) => void} [emit]  Day 14 passes the event bus here
 * @property {boolean} [streaming]          Day 16: use chatStream and emit text/thinking deltas
 * @property {boolean} [gateAllTools]       Day 20: send EVERY call through approve (permission policy)
 * @property {(ctx: { history: any[], newMessages: any[], systemPrompt: string, tools: any[] }) => Promise<any[]|undefined>} [beforeModelCall]
 *           Day 25: may return a replacement (compacted) history before each provider call
 */

/**
 * Returned on EVERY exit path: final answer, maxTurns, abort.
 * @typedef {object} AgentResult
 * @property {string} response              final text (may be partial or empty)
 * @property {number} turns
 * @property {{ id: string, name: string, isError: boolean, denied?: boolean, unanswered?: boolean }[]} toolCalls  log of executed calls (denied: refused at approval; unanswered: because nobody could answer, Day 26)
 * @property {{ promptTokens: number, completionTokens: number, lastPromptTokens?: number }} usage
 * @property {boolean} aborted
 * @property {import('../shared/message-schemas.js').AgentMessage[]} newMessages  everything appended this run
 * @property {string} [warning]
 */

/**
 * @param {Partial<AgentOptions>} options
 * @returns {{ ok: boolean, error?: string }}  ok: true, or ok: false plus the first problem found
 */
export function validateAgentOptions(options) {
  if (!options || typeof options !== 'object') return { ok: false, error: 'options must be an object' };
  const p = options.provider;
  if (!p || typeof p.chat !== 'function') return { ok: false, error: "'provider' must implement chat()" };
  if (!options.registry || typeof options.registry.getTool !== 'function') return { ok: false, error: "'registry' must be a ToolRegistry" };
  if (options.maxTurns !== undefined && !(Number.isInteger(options.maxTurns) && options.maxTurns > 0)) {
    return { ok: false, error: "'maxTurns' must be a positive integer" };
  }
  if (options.approve !== undefined && typeof options.approve !== 'function') return { ok: false, error: "'approve' must be a function" };
  if (options.emit !== undefined && typeof options.emit !== 'function') return { ok: false, error: "'emit' must be a function" };
  return { ok: true };
}
