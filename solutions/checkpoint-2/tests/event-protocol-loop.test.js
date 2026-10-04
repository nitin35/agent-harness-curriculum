// Day 14: the real AgentLoop's event traces, run through your Day 6 protocol checker.
// If the loop and the design ever disagree, one of them is wrong; find out which.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../src/agent/agent-loop.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { ScriptedProvider } from '../src/provider/scripted.js';
import { checkTrace } from './helpers/event-protocol.js';

/** A loop on a scripted provider whose every emitted event name is recorded. */
function setup(script, tools = {}) {
  const events = [];
  const registry = new ToolRegistry();
  for (const [name, execute] of Object.entries(tools)) {
    registry.registerTool({ name, description: `test tool ${name}`, parameters: { type: 'object' }, execute });
  }
  const loop = new AgentLoop({
    provider: new ScriptedProvider(script),
    registry,
    maxTurns: 3,
    emit: (event) => events.push(event),
  });
  return { loop, events };
}

function assertValid(events) {
  const r = checkTrace(events);
  assert.equal(r.ok, true, `${r.error}\n  trace: ${events.join(' → ')}`);
}

const noop = async () => ({ content: 'ok', isError: false });

test('a text-only answer follows the protocol', async () => {
  const { loop, events } = setup([ScriptedProvider.text('Paris')]);
  await loop.run('capital of France?');
  assertValid(events);
});

test('a tool turn, then the answer, follows the protocol', async () => {
  const { loop, events } = setup([ScriptedProvider.toolCalls(['noop', {}, 'c1']), ScriptedProvider.text('done')], { noop });
  await loop.run('go');
  assertValid(events);
  assert.ok(events.includes('tool_call_start') && events.includes('tool_result'));
});

test('an abort mid-tool follows the protocol: the skipped call has a tool_result only', async () => {
  const controller = new AbortController();
  const stop = async () => { controller.abort(); return { content: 'stopped', isError: true }; };
  const { loop, events } = setup([ScriptedProvider.toolCalls(['stop', {}, 'c1'], ['noop', {}, 'c2'])], { stop, noop });
  const r = await loop.run('go', [], { signal: controller.signal });
  assert.equal(r.aborted, true);
  assertValid(events);
  assert.equal(events.filter((e) => e === 'tool_call_start').length, 1);
  assert.equal(events.filter((e) => e === 'tool_result').length, 2);
});

test('maxTurns follows the protocol', async () => {
  const call = () => ScriptedProvider.toolCalls(['noop', {}]);
  const { loop, events } = setup([call(), call(), call()], { noop });
  await loop.run('loop forever');
  assertValid(events);
});

test('a provider failure still ends with agent_end', async () => {
  const { loop, events } = setup([{ error: new Error('boom') }]);
  await assert.rejects(loop.run('go'), /boom/);
  assertValid(events);
});
