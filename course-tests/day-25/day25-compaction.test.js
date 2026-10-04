// Course test — Day 25 (Checkpoint 3): compaction keeps the protocol valid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { planCompaction, compactionText, shortenOldToolResults } from '../../src/context/compaction.js';
import { SessionManager } from '../../src/session/session-manager.js';
import { calibratedContextTokens } from '../../src/context/token-estimator.js';
import { AgentLoop } from '../../src/agent/agent-loop.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { ScriptedProvider } from '../../src/provider/scripted.js';
import { createApp } from '../../src/app.js';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-cmp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const user = (content) => ({ role: 'user', content });
const assistant = (content) => ({ role: 'assistant', content });
const call = (id, command = 'ls') => ({ role: 'assistant', content: '', toolCalls: [{ id, name: 'bash', arguments: { command } }] });
const result = (id, content = 'out') => ({ role: 'tool_result', content, toolCallId: id, toolName: 'bash', isError: false });

/** Fake path entries (planCompaction only needs type + message). */
const entries = (msgs) => msgs.map((message, i) => ({ type: 'message', id: `e${i}`, parentId: i ? `e${i - 1}` : null, message }));

test('plan: keeps the last N; nothing to do when the path is short', () => {
  const p = entries([user('a'), assistant('b'), user('c'), assistant('d'), user('e'), assistant('f')]);
  assert.equal(planCompaction(p, { keepMessages: 6 }), null);
  const plan = planCompaction(p, { keepMessages: 2 });
  assert.deepEqual(plan.kept.map((e) => e.id), ['e4', 'e5']);
  assert.deepEqual(plan.summarized.map((e) => e.id), ['e0', 'e1', 'e2', 'e3']);
});

test('pair integrity when the boundary lands INSIDE a tool pair: it moves forward past the pair', () => {
  const p = entries([user('q1'), call('c1'), result('c1'), result('c1b'), assistant('done'), user('q2'), assistant('ok')]);
  p[1].message.toolCalls.push({ id: 'c1b', name: 'bash', arguments: { command: 'pwd' } });
  // keep 4 → naive boundary at index 3, which is a tool_result inside the pair (1,2,3)
  const plan = planCompaction(p, { keepMessages: 4 });
  assert.equal(plan.boundary, 4, 'moved past the whole pair');
  assert.ok(!plan.kept.some((e) => e.message.role === 'tool_result'), 'no orphaned result kept');
  assert.equal(plan.summarized.at(-1).message.role, 'tool_result', 'the pair went into the summary whole');
});

test('the latest user message is never summarized — even with keepMessages: 1', () => {
  const p = entries([user('old'), assistant('x'), user('LATEST'), call('c1'), result('c1'), assistant('answer')]);
  const plan = planCompaction(p, { keepMessages: 1 });
  assert.equal(plan.kept[0].message.content, 'LATEST');
});

test('a pair right before the latest user message is folded WHOLE; the user message starts the kept part', () => {
  const p = entries([user('old'), call('c1'), result('c1'), user('LATEST'), assistant('a')]);
  // keep 3 → naive boundary 2 = the tool_result inside the pair → moves forward to 3 (LATEST)
  const plan = planCompaction(p, { keepMessages: 3 });
  assert.equal(plan.boundary, 3);
  assert.equal(plan.kept[0].message.content, 'LATEST');
  assert.deepEqual(plan.summarized.map((e) => e.message.role), ['user', 'assistant', 'tool_result']);
});

test('compactionText: a large tool result becomes a short, re-readable note — not dumped whole', () => {
  const p = entries([user('fix the bug in parser.js'), call('c1', 'cat big.log'), result('c1', 'x'.repeat(5000))]);
  const text = compactionText(p, 10_000); // room to spare → no truncation marker, only the per-result shortening
  assert.match(text, /^user: fix the bug in parser\.js\nassistant: \[called bash \{"command":"cat big\.log"\}\]/);
  assert.ok(!text.includes('x'.repeat(300)), 'the 5000-char tool output is not in the summary');
  assert.match(text, /tool bash: x+… \[5000 bytes; re-read if needed\]/);
});

test('compactionText: head AND tail are kept, so the task AND the newest line both survive a cap', () => {
  const msgs = [user('OLDEST: the task is to refactor billing')];
  for (let i = 0; i < 30; i++) msgs.push(user(`filler ${i} ${'y'.repeat(50)}`));
  msgs.push(user('NEWEST: the codename is BLUEBIRD'));
  const text = compactionText(entries(msgs), 300);
  assert.match(text, /\[truncated: showing the first \d+ and the last \d+ of \d+ bytes/);
  assert.ok(text.includes('OLDEST'), 'the task at the head survives');
  assert.ok(text.includes('BLUEBIRD'), 'the newest summarized line at the tail survives');
});

test('shortenOldToolResults: clears older tool output in place, keeps the most recent whole and every pair intact', () => {
  const msgs = [user('go'), call('c1'), result('c1', 'A'.repeat(1000)), call('c2'), result('c2', 'B'.repeat(1000)), call('c3'), result('c3', 'C'.repeat(1000))];
  const n = shortenOldToolResults(msgs, { keepLast: 1 });
  assert.equal(n, 2);
  assert.match(msgs[2].content, /^\[cleared: 1000 bytes/);
  assert.match(msgs[4].content, /^\[cleared: 1000 bytes/);
  assert.equal(msgs[6].content, 'C'.repeat(1000), 'the most recent result is untouched');
  assert.equal(msgs.filter((m) => m.role === 'tool_result').length, 3, 'no pair dropped');
  assert.equal(shortenOldToolResults(msgs, { keepLast: 1 }), 0, 'already-cleared results are left alone (idempotent)');
});

async function sessionWith(t, msgs) {
  const s = SessionManager.create({ cwd: '/w', model: 'm', dir: tmp(t) });
  await s.appendMessages(msgs);
  return s;
}

test('session.compact: getPath() = C → kept…; one pointer rewritten; the summarized entries stay in the file', async (t) => {
  const s = await sessionWith(t, [user('q1'), assistant('a1'), user('q2'), assistant('a2'), user('q3'), assistant('a3')]);
  const before = s.getEntries().map((e) => e.id);
  const r = await s.compact({ keepMessages: 2 });
  assert.equal(r.dropped, 4);
  const pathNow = s.getPath();
  assert.equal(pathNow[0].type, 'compaction');
  assert.deepEqual(pathNow[0].summarizedIds, before.slice(0, 4));
  assert.equal(pathNow[1].parentId, pathNow[0].id);
  assert.deepEqual(pathNow.slice(1).map((e) => e.message.content), ['q3', 'a3']);
  assert.equal(s.getEntries().length, 7, 'everything is still in the file');
  const reopened = await SessionManager.open(s.path);
  assert.deepEqual(reopened.getPath().map((e) => e.id), pathNow.map((e) => e.id));
  assert.match(reopened.getMessages()[0].content, /^\[Earlier conversation, compacted/);
});

test('abandoned branch unchanged after compaction; branch()/getChildren() and the leaf survive a reopen', async (t) => {
  const s = await sessionWith(t, [user('q1'), assistant('a1'), user('q2'), assistant('a2')]);
  const [e1, e2, e3] = s.getEntries();
  await s.branch(e2.id);
  await s.appendMessage(user('q2-alt'));
  await s.appendMessage(assistant('a2-alt'));
  await s.appendMessage(user('q3'));
  assert.deepEqual(s.getChildren(e2.id).map((e) => e.message.content), ['q2', 'q2-alt']);
  const abandoned = JSON.stringify(s.getEntries().filter((e) => e.message?.content === 'q2' || e.message?.content === 'a2'));
  await s.compact({ keepMessages: 2 });
  assert.equal(JSON.stringify(s.getEntries().filter((e) => e.message?.content === 'q2' || e.message?.content === 'a2')), abandoned);
  const reopened = await SessionManager.open(s.path);
  assert.deepEqual(reopened.getMessages().slice(1).map((m) => m.content), ['a2-alt', 'q3']);
  assert.equal(e1.parentId, null);
  assert.ok(e3);
  await assert.rejects(s.branch('nope'), /no such entry/);
});

test('multi-level: a second compaction folds the first compaction entry in', async (t) => {
  const s = await sessionWith(t, Array.from({ length: 10 }, (_, i) => (i % 2 ? assistant(`a${i}`) : user(`q${i}`))));
  await s.compact({ keepMessages: 4 });
  await s.appendMessages([user('q10'), assistant('a10'), user('q11'), assistant('a11')]);
  const r = await s.compact({ keepMessages: 2 });
  const first = s.getPath()[0];
  assert.equal(first.type, 'compaction');
  assert.match(first.content, /\[earlier summary\]/);
  assert.ok(r.dropped >= 2);
  assert.equal(await s.compact({ keepMessages: 2 }), null, 'nothing left to fold: no churn');
});

test('after compaction, usage measured on the OLD (longer) prompt is not trusted', async (t) => {
  const s = await sessionWith(t, [user('q1'), { ...assistant('a1'), usage: { promptTokens: 7000, completionTokens: 10 } }, user('q2'), { ...assistant('a2'), usage: { promptTokens: 7500, completionTokens: 10 } }]);
  assert.equal(calibratedContextTokens({ messages: s.getMessages() }).measured, 7510);
  await s.compact({ keepMessages: 2 });
  assert.ok(s.getMessages().every((m) => m.usage === undefined));
  assert.equal(calibratedContextTokens({ messages: s.getMessages() }).measured, 0);
});

test('the loop hands only OLDER history to beforeModelCall and uses what comes back', async () => {
  const provider = new ScriptedProvider([ScriptedProvider.text('ok')]);
  const seen = [];
  const loop = new AgentLoop({
    provider, registry: new ToolRegistry(),
    beforeModelCall: async ({ history, newMessages }) => { seen.push([history.length, newMessages.length]); return [{ role: 'user', content: '[compacted]' }]; },
  });
  await loop.run('now', [user('a'), assistant('b'), user('c')]);
  assert.deepEqual(seen, [[3, 1]]);
  assert.deepEqual(provider.calls[0].messages.slice(1).map((m) => m.content), ['[compacted]', 'now']);
});

test('CHECKPOINT 3, end to end: a small window fills up, compaction fires mid-session, the next call is protocol-valid', async (t) => {
  const home = tmp(t);
  const big = 'lorem ipsum dolor sit amet '.repeat(120); // ~3 KB ≈ 800 tokens
  const script = Array.from({ length: 6 }, (_, i) => ScriptedProvider.text(`reply ${i} ${big}`));
  const provider = new ScriptedProvider(script, { contextLimit: 4096 });
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const app = createApp({ cwd: home, provider, input, output, terminal: false, color: 'never', home, onExit: () => {}, compaction: { keepMessages: 2 } });
  const compactions = [];
  app.bus.on('compaction', (p) => compactions.push(p));
  await app.start({ resume: 'new' });
  for (let i = 0; i < 6; i++) {
    app.bus.emit('user_message', { content: `question ${i} ${big}` });
    await app.bridge.whenIdle();
  }
  assert.ok(compactions.length >= 1, 'compaction fired');
  const lastCall = provider.calls.at(-1).messages;
  assert.equal(lastCall.at(-1).content.startsWith('question 5'), true, 'the latest user message survived');
  assert.match(lastCall[1].content, /^\[Earlier conversation, compacted/, 'history now starts with the compaction record');
  const ids = new Set();
  for (const m of lastCall) {
    if (m.role === 'assistant') for (const c of m.toolCalls ?? []) ids.add(c.id);
    if (m.role === 'tool_result') assert.ok(ids.has(m.toolCallId), 'every result has its call');
  }
  app.stop(0);
});

test('never leaves an empty kept part (e.g. a path that ends in a tool pair with no user message)', () => {
  const p = entries([assistant('hello'), call('c1'), result('c1')]);
  assert.equal(planCompaction(p, { keepMessages: 1 }), null);
});

test('a single run that outgrows the window: older tool results are cleared in place, the run still finishes', async (t) => {
  const home = tmp(t);
  for (const n of [1, 2, 3, 4]) fs.writeFileSync(path.join(home, `part${n}.txt`), `PART${n}\n` + 'lorem ipsum dolor sit amet '.repeat(260));
  const read = (n) => ScriptedProvider.toolCalls(['read', { path: `part${n}.txt` }, `r${n}`]);
  const provider = new ScriptedProvider([read(1), read(2), read(3), read(4), ScriptedProvider.text('summary done')], { contextLimit: 4096 });
  const output = new PassThrough(); output.resume();
  const app = createApp({ cwd: home, provider, input: new PassThrough(), output, terminal: false, color: 'never', home, onExit: () => {}, contextLimitCap: 4096, permissions: { mode: 'yolo' } });
  await app.start({ resume: 'new' });
  app.bus.emit('user_message', { content: 'Read part1..part4 and summarise them.' });
  await app.bridge.whenIdle();

  const results = app.session.getMessages().filter((m) => m.role === 'tool_result');
  assert.equal(results.length, 4, 'every tool call kept its result — no pair dropped');
  assert.ok(results.slice(0, 2).every((m) => m.content.startsWith('[cleared:')), 'older tool output was shortened');
  assert.ok(!results.at(-1).content.startsWith('[cleared:'), 'the most recent result is kept whole');
  assert.equal(app.session.getMessages().at(-1).content, 'summary done', 'the run produced a final answer');
  const last = provider.calls.at(-1).messages;
  const est = calibratedContextTokens({ systemPrompt: last[0].content, messages: last.slice(1), tools: provider.calls.at(-1).tools ?? [] }).tokens;
  assert.ok(est <= 4096, `the last prompt fit the window (~${est} tokens)`);
  app.stop(0);
});
