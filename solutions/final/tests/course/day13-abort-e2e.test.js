// Course test — Day 13 (Checkpoint 1): abort, ScriptedProvider, and a mocked end-to-end run
// with the REAL built-in tools. Passes with Ollama stopped — that is the point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../../src/agent/agent-loop.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { ScriptedProvider } from '../../src/provider/scripted.js';
import { createBuiltinTools } from '../../src/tools/builtin/index.js';

const posix = process.platform !== 'win32';

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-ws-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function builtins(root) {
  const registry = new ToolRegistry();
  for (const tool of createBuiltinTools({ root })) registry.registerTool(tool);
  return registry;
}

test('ScriptedProvider replays its script and records every call', async () => {
  const p = new ScriptedProvider([ScriptedProvider.text('one'), ScriptedProvider.text('two')]);
  assert.equal((await p.chat([{ role: 'user', content: 'a' }], [])).content, 'one');
  assert.equal((await p.chat([{ role: 'user', content: 'b' }], [])).content, 'two');
  assert.equal(p.calls.length, 2);
  assert.equal(p.calls[1].messages[0].content, 'b');
  await assert.rejects(p.chat([], []), /exhausted/);
});

test('e2e: read a real file through the real read tool, then answer', async (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, 'notes.txt'), 'the answer is 42');
  const provider = new ScriptedProvider([
    ScriptedProvider.toolCalls(['read', { path: 'notes.txt' }, 'call_1']),
    (messages) => ScriptedProvider.text(`I read: ${messages.at(-1).content}`),
  ]);
  const r = await new AgentLoop({ provider, registry: builtins(root) }).run('what does notes.txt say?');
  assert.equal(r.response, 'I read: the answer is 42');
  assert.equal(r.toolCalls.length, 1);
  assert.equal(provider.calls.length, 2);
});

test('abort during the provider call: structured result, no throw', async () => {
  const provider = new ScriptedProvider([{ delayMs: 5_000, response: ScriptedProvider.text('too late') }]);
  const loop = new AgentLoop({ provider, registry: new ToolRegistry() });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const started = Date.now();
  const r = await loop.run('slow question', [], { signal: controller.signal });
  assert.ok(Date.now() - started < 2_000);
  assert.equal(r.aborted, true);
  assert.equal(loop.isRunning, false);
});

test('abort between turns: the next provider call never happens', async () => {
  const controller = new AbortController();
  const provider = new ScriptedProvider([
    ScriptedProvider.toolCalls(['noop', {}, 'c1']),
    ScriptedProvider.text('should not be reached'),
  ]);
  const registry = new ToolRegistry();
  registry.registerTool({
    name: 'noop', description: 'does nothing', parameters: { type: 'object' },
    async execute() { controller.abort(); return { content: 'ok', isError: false }; },
  });
  const r = await new AgentLoop({ provider, registry }).run('go', [], { signal: controller.signal });
  assert.equal(r.aborted, true);
  assert.equal(provider.calls.length, 1);
});

test('abort kills the in-flight bash child and skips the remaining calls — the tool pair stays whole', { skip: !posix }, async (t) => {
  const root = workspace(t);
  const provider = new ScriptedProvider([
    ScriptedProvider.toolCalls(['bash', { command: 'sleep 30' }, 'c1'], ['bash', { command: 'echo second' }, 'c2'], ['read', { path: 'x' }, 'c3']),
  ]);
  const loop = new AgentLoop({ provider, registry: builtins(root), autoApprove: true });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 250);
  const started = Date.now();
  const r = await loop.run('run things', [], { signal: controller.signal });
  assert.ok(Date.now() - started < 5_000, `sleep 30 died quickly (took ${Date.now() - started} ms)`);
  assert.equal(r.aborted, true);

  const roles = r.newMessages.map((m) => m.role);
  assert.deepEqual(roles, ['user', 'assistant', 'tool_result', 'tool_result', 'tool_result']);
  const results = r.newMessages.filter((m) => m.role === 'tool_result');
  assert.deepEqual(results.map((m) => m.toolCallId), ['c1', 'c2', 'c3']);
  assert.match(results[0].content, /aborted/);
  assert.equal(results[1].content, 'Skipped: run aborted');
  assert.equal(results[2].content, 'Skipped: run aborted');
});

test('maxTurns on the scripted provider: exactly N calls, partial result, aborted false', async () => {
  const script = Array.from({ length: 5 }, (_, i) => ScriptedProvider.toolCalls(['noop', {}, `c${i}`]));
  const provider = new ScriptedProvider(script);
  const registry = new ToolRegistry();
  registry.registerTool({ name: 'noop', description: 'does nothing', parameters: { type: 'object' }, async execute() { return 'ok'; } });
  const r = await new AgentLoop({ provider, registry, maxTurns: 3 }).run('go');
  assert.equal(provider.calls.length, 3);
  assert.equal(r.aborted, false);
  assert.ok(r.warning);
});

test('a provider failure (not an abort) propagates as an error and the loop is reusable', async () => {
  const provider = new ScriptedProvider([{ error: new Error('server exploded') }, ScriptedProvider.text('fine now')]);
  const loop = new AgentLoop({ provider, registry: new ToolRegistry() });
  await assert.rejects(loop.run('one'), /server exploded/);
  assert.equal(loop.isRunning, false);
  assert.equal((await loop.run('two')).response, 'fine now');
});
