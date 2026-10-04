// Course test — Day 17: JSONL utils, SessionManager, listing, the config dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendJsonl, readJsonl, writeJsonlAtomic } from '../../src/session/jsonl-utils.js';
import { SessionManager, listSessions } from '../../src/session/session-manager.js';
import { configDir, globalPaths } from '../../src/config/paths.js';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-sess-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('jsonl: append then read round-trips, one record per line', async (t) => {
  const file = path.join(tmp(t), 'a.jsonl');
  await appendJsonl(file, { n: 1 });
  await appendJsonl(file, { n: 2, s: 'é\nnewline inside' });
  const { records, skipped } = await readJsonl(file);
  assert.deepEqual(records, [{ n: 1 }, { n: 2, s: 'é\nnewline inside' }]);
  assert.equal(skipped, 0);
  assert.equal(fs.readFileSync(file, 'utf8').split('\n').length, 3, 'two lines + trailing newline');
});

test('jsonl: a torn last line is skipped with a warning; the rest survives', async (t) => {
  const file = path.join(tmp(t), 'b.jsonl');
  fs.writeFileSync(file, '{"n":1}\n{"n":2}\n{"n":3, "tor');
  const warnings = [];
  const { records, skipped } = await readJsonl(file, { onWarn: (m) => warnings.push(m) });
  assert.deepEqual(records, [{ n: 1 }, { n: 2 }]);
  assert.equal(skipped, 1);
  assert.match(warnings[0], /line 3/);
});

test('jsonl: atomic write replaces the file and leaves no temp file behind', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'c.jsonl');
  fs.writeFileSync(file, '{"old":true}\n');
  await writeJsonlAtomic(file, [{ a: 1 }, { b: 2 }]);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}\n{"b":2}\n');
  assert.deepEqual(fs.readdirSync(dir), ['c.jsonl']);
});

test('config dir: ~/.config/agent-harness by default, AGENT_HARNESS_HOME overrides, never a literal ~', () => {
  assert.equal(configDir({}), path.join(os.homedir(), '.config', 'agent-harness'));
  assert.equal(configDir({ AGENT_HARNESS_HOME: '/tmp/x' }), path.resolve('/tmp/x'));
  const p = globalPaths('/base');
  assert.equal(p.sessions, path.join('/base', 'sessions'));
  assert.ok(!Object.values(p).some((v) => v.includes('~')));
});

test('session: nothing is written until the first append; then header + entries on disk', async (t) => {
  const dir = tmp(t);
  const s = SessionManager.create({ cwd: '/work', model: 'qwen3.5:4b', dir });
  assert.equal(fs.existsSync(s.path), false);
  await s.appendMessage({ role: 'user', content: 'hi' });
  const lines = fs.readFileSync(s.path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].type, 'header');
  assert.equal(lines[0].model, 'qwen3.5:4b');
  assert.equal(lines[1].type, 'message');
  assert.deepEqual(lines[1].message, { role: 'user', content: 'hi' });
});

const CONVERSATION = [
  { role: 'user', content: 'What files are in /tmp?' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'bash', arguments: { command: 'ls /tmp' } }] },
  { role: 'tool_result', content: 'a.txt\nb.txt', toolCallId: 'call_1', toolName: 'bash', isError: false },
  { role: 'assistant', content: 'Two files: a.txt and b.txt.' },
];

test('session: append → open round-trip keeps ids, parent chain, and the tool pair', async (t) => {
  const s = SessionManager.create({ cwd: '/work', model: 'm', dir: tmp(t) });
  await s.appendMessages(CONVERSATION);
  const ids = s.getEntries().map((e) => e.id);
  const reopened = await SessionManager.open(s.path);
  assert.equal(reopened.id, s.id);
  assert.deepEqual(reopened.getEntries().map((e) => e.id), ids);
  assert.equal(reopened.getLeafId(), ids.at(-1));
  assert.deepEqual(reopened.getPath().map((e) => e.parentId), [null, ids[0], ids[1], ids[2]]);
  assert.deepEqual(reopened.getMessages(), CONVERSATION);
});

test('session: a crash after appends (no save) loses nothing', async (t) => {
  const s = SessionManager.create({ cwd: '/w', model: 'm', dir: tmp(t) });
  await s.appendMessages(CONVERSATION.slice(0, 2));
  // simulate the process dying here — no save() call
  const reopened = await SessionManager.open(s.path);
  assert.equal(reopened.getMessages().length, 2);
});

test('session: a torn last line, then more appends — reopening still gives the WHOLE conversation', async (t) => {
  const s = SessionManager.create({ cwd: '/w', model: 'm', dir: tmp(t) });
  await s.appendMessages(CONVERSATION);
  fs.appendFileSync(s.path, '{"type":"mess'); // kill -9 in the middle of an append
  const resumed = await SessionManager.open(s.path, { onWarn: () => {} });
  await resumed.appendMessage({ role: 'user', content: 'still there?' });
  await resumed.appendMessage({ role: 'assistant', content: 'yes' });
  const again = await SessionManager.open(s.path, { onWarn: () => {} });
  assert.deepEqual(again.getMessages(), [...CONVERSATION, { role: 'user', content: 'still there?' }, { role: 'assistant', content: 'yes' }]);
});

test('session: a corrupt line in the MIDDLE cuts the parent chain, and open() says so', async (t) => {
  const s = SessionManager.create({ cwd: '/w', model: 'm', dir: tmp(t) });
  await s.appendMessages(CONVERSATION);
  const lines = fs.readFileSync(s.path, 'utf8').split('\n');
  lines[2] = '{"type":"mess'; // damage the second message (line 1 is the header)
  fs.writeFileSync(s.path, lines.join('\n'));
  const warnings = [];
  const reopened = await SessionManager.open(s.path, { onWarn: (m) => warnings.push(m) });
  assert.ok(warnings.some((w) => /parent is missing/.test(w)), warnings.join('\n'));
  assert.equal(reopened.getMessages().length, 2, 'only the entries after the break are on the path');
});

test('session: save() rewrites atomically (e.g. after setModel) and keeps every entry', async (t) => {
  const s = SessionManager.create({ cwd: '/w', model: 'a', dir: tmp(t) });
  await s.appendMessages(CONVERSATION);
  s.setModel('b');
  await s.save();
  const reopened = await SessionManager.open(s.path);
  assert.equal(reopened.header.model, 'b');
  assert.equal(reopened.getEntries().length, 4);
});

test('session: open() rejects files without a header', async (t) => {
  const file = path.join(tmp(t), 'bad.jsonl');
  fs.writeFileSync(file, '{"type":"message"}\n');
  await assert.rejects(SessionManager.open(file), /header/);
});

test('listSessions: header-only reads, newest first, corrupt files skipped', async (t) => {
  const dir = tmp(t);
  const a = SessionManager.create({ cwd: '/w', model: 'm', dir, name: 'older' });
  await a.appendMessage({ role: 'user', content: 'a' });
  const b = SessionManager.create({ cwd: '/w', model: 'm', dir, name: 'newer' });
  await b.appendMessage({ role: 'user', content: 'b' });
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(a.path, past, past);
  fs.writeFileSync(path.join(dir, 'junk.jsonl'), 'not json\n');
  const list = await listSessions(dir, { onWarn: () => {} });
  assert.deepEqual(list.map((s) => s.name), ['newer', 'older']);
  assert.equal(list[0].path, b.path);
});

test('listSessions({ cwd }): only the sessions started in that folder', async (t) => {
  const dir = tmp(t);
  const here = SessionManager.create({ cwd: '/work/app', model: 'm', dir });
  await here.appendMessage({ role: 'user', content: 'a' });
  const elsewhere = SessionManager.create({ cwd: '/work/other', model: 'm', dir });
  await elsewhere.appendMessage({ role: 'user', content: 'b' });
  assert.deepEqual((await listSessions(dir, { cwd: '/work/app', onWarn: () => {} })).map((s) => s.id), [here.id]);
  assert.equal((await listSessions(dir, { onWarn: () => {} })).length, 2, 'without cwd: every session');
});

test('session files are private: the folder is 0o700, the file 0o600, even after a rewrite', { skip: process.platform === 'win32' }, async (t) => {
  const dir = path.join(tmp(t), 'sessions');
  const s = SessionManager.create({ cwd: '/w', model: 'm', dir });
  await s.appendMessage({ role: 'user', content: 'cat .env' });
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(s.path).mode & 0o777, 0o600);
  s.setModel('b');
  await s.save();
  assert.equal(fs.statSync(s.path).mode & 0o777, 0o600, 'the atomic rewrite keeps it private');
});
