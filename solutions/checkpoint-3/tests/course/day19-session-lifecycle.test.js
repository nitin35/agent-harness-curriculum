// Course test — Day 19: the session lifecycle, end to end through createApp() — offline.
// Each test gets its own temp config dir (the `home` option), so your real sessions are never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createApp } from '../../src/app.js';
import { ScriptedProvider } from '../../src/provider/scripted.js';
import { SessionManager } from '../../src/session/session-manager.js';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-app-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** An app over in-memory streams with a scripted model. */
function makeApp(home, script, { cwd = home } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let screen = '';
  output.on('data', (d) => { screen += d; });
  const provider = new ScriptedProvider(script);
  const app = createApp({ cwd, provider, input, output, terminal: false, color: 'never', home, onExit: () => {} });
  /** Type `answer` once the screen shows `question` — like a person would. */
  const answerWhenAsked = async (question, answer) => {
    for (let i = 0; i < 200 && !question.test(screen); i++) await new Promise((r) => setTimeout(r, 10));
    screen = '';
    input.write(`${answer}\n`);
  };
  return { app, provider, input, answerWhenAsked };
}

async function say(app, content) {
  app.bus.emit('user_message', { content });
  await app.bridge.whenIdle();
}

test('auto-save: each run is appended to the session file', async (t) => {
  const home = tmp(t);
  const { app } = makeApp(home, [ScriptedProvider.text('noted')]);
  await app.start({ resume: 'new' });
  await say(app, 'my favourite colour is blue');
  await app.session.flush();
  const reopened = await SessionManager.open(app.session.path);
  assert.deepEqual(reopened.getMessages().map((m) => [m.role, m.content]), [['user', 'my favourite colour is blue'], ['assistant', 'noted']]);
  app.stop(0);
});

test('auto-save keeps a run that failed partway: what the tool did is in history', async (t) => {
  const home = tmp(t);
  const { app, answerWhenAsked } = makeApp(home, [
    ScriptedProvider.toolCalls(['write', { path: 'notes.txt', content: 'hello' }, 'w1']),
    { error: new Error('Cannot reach Ollama') },
  ]);
  await app.start({ resume: 'new' });
  app.bus.emit('user_message', { content: 'create notes.txt saying hello' });
  await answerWhenAsked(/allow write/, 'y');
  await app.bridge.whenIdle();
  await app.session.flush();
  assert.equal(fs.readFileSync(path.join(home, 'notes.txt'), 'utf8'), 'hello');
  const saved = (await SessionManager.open(app.session.path)).getMessages();
  assert.deepEqual(saved.map((m) => m.role), ['user', 'assistant', 'tool_result']);
  app.stop(0);
});

test('CONTINUITY: quit, restart, resume — the model is GIVEN the old conversation as history', async (t) => {
  const home = tmp(t);
  const first = makeApp(home, [ScriptedProvider.text('Got it — blue.')]);
  await first.app.start({ resume: 'new' });
  await say(first.app, 'My favorite color is blue');
  await first.app.session.flush();
  first.app.stop(0);

  const second = makeApp(home, [(messages) => ScriptedProvider.text(messages.some((m) => /blue/.test(m.content)) ? 'blue' : 'I do not know')]);
  await second.app.start({ resume: 'last' });
  await say(second.app, 'what color did I say?');
  const sent = second.provider.calls[0].messages.map((m) => m.content);
  assert.ok(sent.includes('My favorite color is blue'), 'the old user message is in the history sent to the model');
  const answer = second.app.session.getMessages().at(-1).content;
  assert.equal(answer, 'blue');
  second.app.stop(0);
});

test('startup: answering N to "resume last session?" starts fresh', async (t) => {
  const home = tmp(t);
  const first = makeApp(home, [ScriptedProvider.text('ok')]);
  await first.app.start({ resume: 'new' });
  await say(first.app, 'remember me');
  await first.app.session.flush();
  first.app.stop(0);

  const second = makeApp(home, []);
  const starting = second.app.start({ resume: 'ask' });
  await second.answerWhenAsked(/resume last session\?/, 'n');
  await starting;
  assert.notEqual(second.app.session.id, first.app.session.id);
  assert.equal(second.app.session.getMessages().length, 0);
  second.app.stop(0);
});

test('/resume: numbered picker; empty answer cancels; a number switches session and feeds its history', async (t) => {
  const home = tmp(t);
  const old = makeApp(home, [ScriptedProvider.text('ok')]);
  await old.app.start({ resume: 'new' });
  await say(old.app, 'the password is swordfish');
  await old.app.session.flush();
  old.app.stop(0);

  const { app, provider, answerWhenAsked } = makeApp(home, [ScriptedProvider.text('swordfish')]);
  await app.start({ resume: 'new' });
  const freshId = app.session.id;

  const cancelled = app.commands.handle('/resume', app.ctx);
  await answerWhenAsked(/resume which\?/, '');
  assert.equal((await cancelled).output, 'cancelled');
  assert.equal(app.session.id, freshId);

  const picked = app.commands.handle('/resume', app.ctx);
  await answerWhenAsked(/resume which\?/, '1');
  assert.match((await picked).output, /resumed/);
  assert.equal(app.session.id, old.app.session.id);

  await say(app, 'what is the password?');
  assert.ok(provider.calls[0].messages.some((m) => m.content === 'the password is swordfish'));
  app.stop(0);
});

test('/new: a fresh session with empty history; the old file keeps its messages', async (t) => {
  const home = tmp(t);
  const { app, provider } = makeApp(home, [ScriptedProvider.text('one'), ScriptedProvider.text('two')]);
  await app.start({ resume: 'new' });
  await say(app, 'first conversation');
  await app.session.flush();
  const oldPath = app.session.path;
  await app.commands.handle('/new', app.ctx);
  await say(app, 'second conversation');
  assert.deepEqual(provider.calls[1].messages.slice(1).map((m) => m.content), ['second conversation']);
  assert.equal((await SessionManager.open(oldPath)).getMessages().length, 2);
  app.stop(0);
});

test('resume is per folder: a conversation from another project is never offered', async (t) => {
  const home = tmp(t);
  const projA = path.join(home, 'project-a');
  const projB = path.join(home, 'project-b');
  fs.mkdirSync(projA);
  fs.mkdirSync(projB);
  const a = makeApp(home, [ScriptedProvider.text('ok')], { cwd: projA });
  await a.app.start({ resume: 'new' });
  await say(a.app, 'refactor src/billing.js');
  await a.app.session.flush();
  a.app.stop(0);

  const b = makeApp(home, [], { cwd: projB });
  await b.app.start({ resume: 'last' });
  assert.equal(b.app.session.getMessages().length, 0, "project A's conversation was not loaded in project B");
  assert.match((await b.app.commands.handle('/resume', b.app.ctx)).output, /No other saved sessions/);
  b.app.stop(0);

  const back = makeApp(home, [], { cwd: projA });
  await back.app.start({ resume: 'last' });
  assert.equal(back.app.session.id, a.app.session.id, 'back in project A, it is the last session again');
  back.app.stop(0);
});

test('/new and /resume refuse while a run is in flight: the run stays in its own session', async (t) => {
  const home = tmp(t);
  const { app } = makeApp(home, [ScriptedProvider.text('first'), { delayMs: 200, response: ScriptedProvider.text('second') }]);
  await app.start({ resume: 'new' });
  await say(app, 'one');
  const before = app.session.id;
  app.bus.emit('user_message', { content: 'two' });
  await new Promise((r) => setTimeout(r, 30));
  for (const line of ['/new', '/resume']) {
    const refused = await app.commands.handle(line, app.ctx);
    assert.equal(refused.ok, false, line);
    assert.match(refused.output, /between runs/);
  }
  await app.bridge.whenIdle();
  assert.equal(app.session.id, before);
  assert.deepEqual(app.session.getMessages().map((m) => m.content), ['one', 'first', 'two', 'second']);
  app.stop(0);
});
