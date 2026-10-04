// src/shared/events.js — the canonical event vocabulary (Day 14). Defined ONCE; everything imports it.
// No aliases: there is no `tool_call` and no `done`. Extensions subscribe by these exact strings.

export const EVENTS = Object.freeze({
  // agent / core → bus
  SESSION_START: 'session_start',
  SESSION_SHUTDOWN: 'session_shutdown',
  AGENT_START: 'agent_start',
  TURN_START: 'turn_start',
  TURN_END: 'turn_end',
  THINKING_DELTA: 'thinking_delta',
  TEXT_DELTA: 'text_delta',
  TOOL_CALL_START: 'tool_call_start',
  TOOL_APPROVAL_REQUEST: 'tool_approval_request',
  TOOL_APPROVAL_RESULT: 'tool_approval_result',
  TOOL_CALL_END: 'tool_call_end',
  TOOL_RESULT: 'tool_result',
  AGENT_END: 'agent_end',
  COMPACTION: 'compaction',
  ERROR: 'error',
  COMMAND_RUN: 'command_run',
  // UI → bus
  USER_MESSAGE: 'user_message',
  ABORT: 'abort',
  COMMAND: 'command',
});

export const CORE_EVENTS = Object.freeze([
  EVENTS.SESSION_START, EVENTS.SESSION_SHUTDOWN, EVENTS.AGENT_START, EVENTS.TURN_START, EVENTS.TURN_END,
  EVENTS.THINKING_DELTA, EVENTS.TEXT_DELTA, EVENTS.TOOL_CALL_START, EVENTS.TOOL_APPROVAL_REQUEST,
  EVENTS.TOOL_APPROVAL_RESULT, EVENTS.TOOL_CALL_END, EVENTS.TOOL_RESULT, EVENTS.AGENT_END,
  EVENTS.COMPACTION, EVENTS.ERROR, EVENTS.COMMAND_RUN,
]);
export const UI_EVENTS = Object.freeze([EVENTS.USER_MESSAGE, EVENTS.ABORT, EVENTS.COMMAND]);
export const ALL_EVENTS = Object.freeze([...CORE_EVENTS, ...UI_EVENTS]);

/** @type {Set<string>} */
const known = new Set(ALL_EVENTS);
/** @param {string} name */
export function isCanonicalEvent(name) { return known.has(name); }

// Payload typedefs (one per event). Keep them in sync with the README table.
/** @typedef {{ sessionId: string }} SessionStartPayload */
/** @typedef {{ sessionId: string }} SessionShutdownPayload */
/** @typedef {{ userMessage: string }} AgentStartPayload */
/** @typedef {{ turn: number }} TurnStartPayload */
/** @typedef {{ turn: number, usage?: import('./message-schemas.js').Usage }} TurnEndPayload */
/** @typedef {{ content: string }} ThinkingDeltaPayload */
/** @typedef {{ content: string }} TextDeltaPayload */
/** @typedef {{ id: string, name: string, arguments: Record<string, unknown> }} ToolCallStartPayload */
/** @typedef {{ id: string, name: string, arguments: Record<string, unknown> }} ToolApprovalRequestPayload */
/** @typedef {{ id: string, approved: boolean, remember?: 'session' }} ToolApprovalResultPayload */
/** @typedef {{ id: string, name: string }} ToolCallEndPayload */
/** @typedef {{ id: string, name: string, content: string, isError: boolean }} ToolResultPayload */
/** @typedef {{ response: string, turns: number, aborted: boolean }} AgentEndPayload */
/** @typedef {{ dropped: number, kept: number }} CompactionPayload */
/** @typedef {{ message: string, cause?: unknown }} ErrorPayload */
/** @typedef {{ name: string, args: string[] }} CommandRunPayload */
/** @typedef {{ content: string }} UserMessagePayload */
/** @typedef {{}} AbortPayload */
/** @typedef {{ line: string }} CommandPayload */
