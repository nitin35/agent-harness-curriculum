// tests/helpers/event-protocol.js — Day 6: the agent loop's event protocol as an executable state machine.
// It answers one question: "could a correct loop have emitted these events in this order?"
// Day 14 runs real traces from your AgentLoop through it.

/** state → { event → next state }. `agent_end` is handled separately: it may end a run from any state. */
export const TRANSITIONS = Object.freeze({
  Idle: { agent_start: 'BetweenTurns' },
  BetweenTurns: { turn_start: 'CallingModel' },
  CallingModel: {
    thinking_delta: 'CallingModel',
    text_delta: 'CallingModel',
    tool_call_start: 'RunningTool',
    tool_result: 'BetweenTools', // a call skipped by an abort has a result but no start/end
    turn_end: 'BetweenTurns',    // a text-only answer
  },
  RunningTool: { tool_approval_request: 'AwaitingApproval', tool_call_end: 'ToolEnded' },
  AwaitingApproval: { tool_approval_result: 'RunningTool' }, // approve, deny, timeout and abort all answer here
  ToolEnded: { tool_result: 'BetweenTools' },
  BetweenTools: { tool_call_start: 'RunningTool', tool_result: 'BetweenTools', turn_end: 'BetweenTurns' },
});

/** The events this machine is about. Anything else (session_*, error, compaction, UI events) is ignored. */
export const LOOP_EVENTS = new Set(['agent_end', ...Object.values(TRANSITIONS).flatMap((t) => Object.keys(t))]);

/**
 * One step. Throws on an illegal transition.
 * @param {string} state
 * @param {string} event
 * @returns {string} the next state
 */
export function advance(state, event) {
  // agent_end fires in the loop's `finally`, so a run may end from any state: answer, maxTurns, abort or error.
  if (event === 'agent_end' && state !== 'Idle') return 'Idle';
  const next = TRANSITIONS[state]?.[event];
  if (!next) throw new Error(`illegal transition: ${state} --${event}-->`);
  return next;
}

/**
 * Walk a whole trace from Idle. A trace is a list of event names, or of `{ event }` objects.
 * @param {Array<string | { event: string }>} trace
 * @returns {{ ok: boolean, steps: string[], error?: string }}
 */
export function checkTrace(trace) {
  let state = 'Idle';
  const steps = [];
  for (const item of trace) {
    const event = typeof item === 'string' ? item : item.event;
    if (!LOOP_EVENTS.has(event)) continue;
    let next;
    try {
      next = advance(state, event);
    } catch (err) {
      return { ok: false, steps, error: err.message };
    }
    steps.push(`${state} --${event}--> ${next}`);
    state = next;
  }
  if (state !== 'Idle') return { ok: false, steps, error: `trace ended in ${state}: agent_end never came` };
  return { ok: true, steps };
}
