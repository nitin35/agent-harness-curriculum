// Course test — Day 12: the AgentLoop core.
// Uses a tiny hand-rolled fake provider (Day 13 replaces it with src/provider/scripted.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../../src/agent/agent-loop.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';

/** A provider that replays `replies` in order and records what it was sent. */
function fakeProvider(replies) {
  const calls = [];
  return {
    calls,
    async chat(messages, tools) {
      calls.push({ messages: structuredClone(messages), tools: structuredClone(tools) });
      const next = replies.shift();
      if (!next) throw new Error('fake provider: no more replies');
      return next;
    },
  };
}
const text = (content) => ({ content, toolCalls: [], model: 'fake', finishReason: 'stop' });
const calls = (...cs) => ({ content: '', toolCalls: cs.map(([name, args, id]) => ({ id, name, arguments: args })), model: 'fake' });

function registryWith(tools) {
  const r = new ToolRegistry();
  for (const t of tools) r.registerTool(t);
  return r;
}
function echoTool(log, extra = {}) {
  return {
    name: 'echo',
    description: 'Echo text back',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    async execute({ text: t }) { log.push(t); return { content: `echo: ${t}`, isError: false }; },
    ...extra,
  };
}

test('a plain answer: one provider call, one turn', async () => {
  const provider = fakeProvider([text('hello!')]);
  const loop = new AgentLoop({ provider, registry: new ToolRegistry() });
  const r = await loop.run('hi');
  assert.equal(r.response, 'hello!');
  assert.equal(r.turns, 1);
  assert.equal(r.aborted, false);
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].messages[0].role, 'system');
  assert.deepEqual(provider.calls[0].messages.at(-1), { role: 'user', content: 'hi' });
});

test('tool turn then text turn: the tool runs once and the second call sees the whole tool pair', async () => {
  const log = [];
  const provider = fakeProvider([calls(['echo', { text: 'x' }, 'call_1']), text('done')]);
  const loop = new AgentLoop({ provider, registry: registryWith([echoTool(log)]) });
  const r = await loop.run('use echo');
  assert.deepEqual(log, ['x']);
  assert.equal(r.response, 'done');
  assert.equal(r.turns, 2);
  const second = provider.calls[1].messages.slice(1); // drop system
  assert.deepEqual(second.map((m) => m.role), ['user', 'assistant', 'tool_result']);
  assert.equal(second[1].toolCalls[0].id, 'call_1');
  assert.equal(second[2].toolCallId, 'call_1');
  assert.equal(second[2].toolName, 'echo');
  assert.equal(second[2].content, 'echo: x');
});

test('history is sent before the new user message, and newMessages holds only this run', async () => {
  const provider = fakeProvider([text('ok')]);
  const loop = new AgentLoop({ provider, registry: new ToolRegistry() });
  const history = [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'noted' }];
  const r = await loop.run('now', history);
  assert.deepEqual(provider.calls[0].messages.slice(1).map((m) => m.content), ['earlier', 'noted', 'now']);
  assert.deepEqual(r.newMessages.map((m) => m.role), ['user', 'assistant']);
});

test('several tool calls in one reply run sequentially, in order, each with its own result', async () => {
  const log = [];
  const provider = fakeProvider([calls(['echo', { text: 'a' }, 'c1'], ['echo', { text: 'b' }, 'c2']), text('ok')]);
  const r = await new AgentLoop({ provider, registry: registryWith([echoTool(log)]) }).run('go');
  assert.deepEqual(log, ['a', 'b']);
  const ids = r.newMessages.filter((m) => m.role === 'tool_result').map((m) => m.toolCallId);
  assert.deepEqual(ids, ['c1', 'c2']);
});

test('tools are fetched fresh before EVERY provider call', async () => {
  const registry = new ToolRegistry();
  const provider = fakeProvider([
    async () => text('x'), // placeholder, replaced below
  ]);
  provider.chat = async function (messages, tools) {
    this.calls.push({ tools: tools.map((t) => t.name) });
    if (this.calls.length === 1) {
      registry.registerTool(echoTool([], { name: 'late' })); // registered mid-run
      return calls(['late', { text: 'hi' }, 'c1']);
    }
    return text('done');
  };
  await new AgentLoop({ provider, registry }).run('go');
  assert.deepEqual(provider.calls[0].tools, []);
  assert.deepEqual(provider.calls[1].tools, ['late']);
});

test('unknown tool → error result, the run continues', async () => {
  const provider = fakeProvider([calls(['fs_read', { path: 'x' }, 'c1']), text('sorry')]);
  const r = await new AgentLoop({ provider, registry: registryWith([echoTool([])]) }).run('go');
  const tr = r.newMessages.find((m) => m.role === 'tool_result');
  assert.equal(tr.isError, true);
  assert.match(tr.content, /Unknown tool 'fs_read'.*echo/);
  assert.equal(r.response, 'sorry');
});

test('malformed or schema-violating arguments → error result asking to retry; the tool never runs', async () => {
  const log = [];
  const provider = fakeProvider([
    { content: '', toolCalls: [{ id: 'c1', name: 'echo', arguments: {}, parseError: 'arguments are not valid JSON' }], model: 'f' },
    calls(['echo', { text: 42 }, 'c2']),
    text('ok'),
  ]);
  const r = await new AgentLoop({ provider, registry: registryWith([echoTool(log)]) }).run('go');
  const results = r.newMessages.filter((m) => m.role === 'tool_result');
  assert.match(results[0].content, /Invalid arguments for echo.*Retry/);
  assert.match(results[1].content, /text must be string.*Retry/);
  assert.deepEqual(log, []);
});

test('a throwing tool becomes an error result, not a crash', async () => {
  const boom = { ...echoTool([]), name: 'boom', async execute() { throw new Error('kaput'); } };
  const provider = fakeProvider([calls(['boom', { text: 'x' }, 'c1']), text('recovered')]);
  const r = await new AgentLoop({ provider, registry: registryWith([boom]) }).run('go');
  assert.match(r.newMessages.find((m) => m.role === 'tool_result').content, /Tool boom failed: kaput/);
  assert.equal(r.response, 'recovered');
});

test('maxTurns turns an endless tool loop into a partial result with a warning', async () => {
  const provider = { calls: 0, async chat() { this.calls++; return calls(['echo', { text: 'again' }, `c${this.calls}`]); } };
  const r = await new AgentLoop({ provider, registry: registryWith([echoTool([])]), maxTurns: 3 }).run('loop forever');
  assert.equal(provider.calls, 3);
  assert.equal(r.turns, 3);
  assert.equal(r.aborted, false);
  assert.match(r.warning, /maxTurns/);
});

test('needsApproval with NO approver attached is denied (fail closed)', async () => {
  const log = [];
  const provider = fakeProvider([calls(['echo', { text: 'x' }, 'c1']), text('ok')]);
  const loop = new AgentLoop({ provider, registry: registryWith([echoTool(log, { needsApproval: true })]) });
  const r = await loop.run('go');
  assert.deepEqual(log, []);
  assert.match(r.newMessages.find((m) => m.role === 'tool_result').content, /^Denied echo \(approval required but no approver/);
});

test('the approve callback decides; denial is a normal tool result', async () => {
  for (const answer of [true, false]) {
    const log = [];
    const seen = [];
    const provider = fakeProvider([calls(['echo', { text: 'x' }, 'c1']), text('ok')]);
    const loop = new AgentLoop({
      provider,
      registry: registryWith([echoTool(log, { needsApproval: true })]),
      approve: async (call) => { seen.push(call.name); return answer; },
    });
    const r = await loop.run('go');
    assert.deepEqual(seen, ['echo']);
    assert.deepEqual(log, answer ? ['x'] : []);
    const tr = r.newMessages.find((m) => m.role === 'tool_result');
    assert.equal(tr.isError, !answer);
  }
});

test('who refused decides the wording: by "policy" → "Denied", anything else → "User denied"', async () => {
  const cases = [
    // routed on the field, so a reason that happens to say "aborted" doesn't make it the user's refusal
    [{ approved: false, by: 'policy', reason: 'aborted by the nightly policy' }, /^Denied echo \(aborted by the nightly policy\)$/],
    [{ approved: false, reason: 'not now' }, /^User denied echo \(not now\)$/],
    [false, /^User denied echo$/],
  ];
  for (const [answer, wording] of cases) {
    const provider = fakeProvider([calls(['echo', { text: 'x' }, 'c1']), text('ok')]);
    const loop = new AgentLoop({
      provider,
      registry: registryWith([echoTool([], { needsApproval: true })]),
      approve: async () => answer,
    });
    const r = await loop.run('go');
    assert.match(r.newMessages.find((m) => m.role === 'tool_result').content, wording);
  }
});

test('autoApprove skips the approver entirely', async () => {
  const log = [];
  const provider = fakeProvider([calls(['echo', { text: 'x' }, 'c1']), text('ok')]);
  const loop = new AgentLoop({
    provider, autoApprove: true,
    registry: registryWith([echoTool(log, { needsApproval: true })]),
    approve: async () => { throw new Error('should not be asked'); },
  });
  await loop.run('go');
  assert.deepEqual(log, ['x']);
});

test('run() while running is a programmer error', async () => {
  let release;
  const provider = { chat: () => new Promise((r) => { release = () => r(text('ok')); }) };
  const loop = new AgentLoop({ provider, registry: new ToolRegistry() });
  const first = loop.run('one');
  assert.equal(loop.isRunning, true);
  await assert.rejects(loop.run('two'), /already running/);
  release();
  await first;
  assert.equal(loop.isRunning, false);
});

test('events: agent_start, turn_start/turn_end, tool_call_start/end, tool_result, agent_end', async () => {
  const events = [];
  const provider = fakeProvider([calls(['echo', { text: 'x' }, 'c1']), text('ok')]);
  const loop = new AgentLoop({ provider, registry: registryWith([echoTool([])]), emit: (name) => events.push(name) });
  await loop.run('go');
  assert.deepEqual(events, [
    'agent_start', 'turn_start', 'tool_call_start', 'tool_call_end', 'tool_result', 'turn_end',
    'turn_start', 'turn_end', 'agent_end',
  ]);
});
