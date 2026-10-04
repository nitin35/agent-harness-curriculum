// Day 6: your design, as tests. Each trace is a story the loop must be able to tell (or must never tell).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advance, checkTrace } from './helpers/event-protocol.js';

const ok = (trace) => {
  const r = checkTrace(trace);
  assert.equal(r.ok, true, r.error);
  return r;
};
const rejected = (trace, pattern) => {
  const r = checkTrace(trace);
  assert.equal(r.ok, false, 'this trace should be rejected');
  assert.match(r.error, pattern);
};

test('a text-only answer', () => {
  ok(['agent_start', 'turn_start', 'thinking_delta', 'text_delta', 'text_delta', 'turn_end', 'agent_end']);
});

test('a tool turn with approval, then the answer', () => {
  const r = ok([
    'agent_start',
    'turn_start', 'tool_call_start', 'tool_approval_request', 'tool_approval_result', 'tool_call_end', 'tool_result', 'turn_end',
    'turn_start', 'text_delta', 'turn_end',
    'agent_end',
  ]);
  assert.ok(r.steps.includes('RunningTool --tool_approval_request--> AwaitingApproval'));
});

test('abort mid-tool: the second call is skipped, but still gets its tool_result', () => {
  ok([
    'agent_start', 'turn_start',
    'tool_call_start', 'tool_call_end', 'tool_result', // the call that was running when Ctrl+C came
    'tool_result',                                     // the skipped call: no start, no end
    'turn_end', 'agent_end',
  ]);
});

test('maxTurns and errors: agent_end may end the run from any state', () => {
  ok(['agent_start', 'turn_start', 'tool_call_start', 'tool_call_end', 'tool_result', 'turn_end', 'agent_end']);
  ok(['agent_start', 'turn_start', 'agent_end']); // the provider threw, or Ctrl+C before the reply
});

test('events outside the loop are ignored', () => {
  ok(['session_start', 'user_message', 'agent_start', 'turn_start', 'turn_end', 'agent_end', 'session_shutdown']);
});

test('rejects a tool_result that arrives before its tool_call_end', () => {
  rejected(['agent_start', 'turn_start', 'tool_call_start', 'tool_result'], /RunningTool --tool_result-->/);
});

test('rejects a second turn that starts while a tool is still running', () => {
  rejected(['agent_start', 'turn_start', 'tool_call_start', 'turn_start'], /illegal transition/);
});

test('rejects a trace that never reaches agent_end', () => {
  rejected(['agent_start', 'turn_start', 'turn_end'], /agent_end never came/);
});

test('advance() throws on an unknown event', () => {
  assert.throws(() => advance('Idle', 'tool_call'), /illegal transition: Idle --tool_call-->/);
});
