// Course test — Day 3: the abortable toy. Every tool call gets an answer, even when the run is aborted.
// Copy into your project as tests/course/day03-toy.test.js, then: node --test tests/course/day03-*
//
// The loop tests use a fake client and a fake tool, so they need neither Ollama nor a keyboard.
// That is the payoff of injecting `client`, `confirm` and `runTool` into runTurns (Day 2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTurns } from '../../toy/loop.mjs';
import { runBash } from '../../toy/bash-tool.mjs';

/** A reply with no tool calls, shaped like Ollama's non-streaming `message` (no `tool_calls` key at all). */
const text = (content) => ({ role: 'assistant', content });

/** A reply that asks for one bash call per command, shaped like Ollama's `message.tool_calls`. */
const bash = (...commands) => ({
  role: 'assistant',
  content: '',
  tool_calls: commands.map((command, i) => ({
    id: `call_${i + 1}`,
    function: { index: i, name: 'bash', arguments: { command } },
  })),
});

/** A fake client that replays `replies` in order and records every request. */
function scripted(...replies) {
  const requests = [];
  return {
    requests,
    async chat(messages, tools, opts) {
      requests.push({ messages: structuredClone(messages), tools });
      opts?.signal?.throwIfAborted();
      const next = replies.shift();
      if (!next) throw new Error('fake client: the loop asked for more replies than the test scripted');
      return next;
    },
  };
}

const yes = async () => true;
const no = async () => false;
const echo = async (command) => `ran: ${command}`;
const user = (content) => [{ role: 'user', content }];
const toolMessages = (messages) => messages.filter((m) => m.role === 'tool');

test('a reply without tool calls is the answer', async () => {
  const messages = user('What is the capital of France?');
  const r = await runTurns({ client: scripted(text('Paris')), messages, confirm: yes, runTool: echo });
  assert.equal(r.text, 'Paris');
  assert.equal(r.turns, 1);
  assert.equal(r.aborted, false);
  assert.equal(messages.length, 2, 'the assistant reply is appended to the history');
});

test('an approved call runs, and its result goes back with the same call id', async () => {
  const client = scripted(bash('ls demo/'), text('There are 2 files.'));
  const messages = user('How many files are in demo/?');
  const asked = [];
  const confirm = async (command) => { asked.push(command); return true; };
  const r = await runTurns({ client, messages, confirm, runTool: echo });

  assert.deepEqual(asked, ['ls demo/'], 'confirm(command) is asked before the tool runs');
  assert.equal(r.text, 'There are 2 files.');
  assert.equal(r.turns, 2);
  const [result] = toolMessages(messages);
  assert.equal(result.tool_call_id, 'call_1');
  assert.equal(result.tool_name, 'bash');
  assert.equal(result.content, 'ran: ls demo/');
  assert.equal(client.requests[1].messages.at(-1).role, 'tool', 'the second request carries the tool result');
});

test('a denied call never runs, and the model is told so', async () => {
  let ran = false;
  const messages = user('Delete the demo folder.');
  await runTurns({
    client: scripted(bash('rm -rf demo'), text('OK, I will leave it.')),
    messages,
    confirm: no,
    runTool: async () => { ran = true; return ''; },
  });
  assert.equal(ran, false);
  assert.match(toolMessages(messages)[0].content, /denied/i);
});

test('abort during the first of two calls: the second is skipped, and both are answered', async () => {
  const controller = new AbortController();
  const client = scripted(bash('sleep 20', 'ls'));
  const messages = user('Wait, then list the files.');
  const runTool = async (command, opts) => {
    controller.abort(); // Ctrl+C while the first command runs
    assert.equal(opts?.signal?.aborted, true, "runTool(command, { signal }) receives the run's signal");
    return '(command stopped: run aborted)';
  };
  const r = await runTurns({ client, messages, confirm: yes, runTool, signal: controller.signal });

  assert.equal(r.aborted, true);
  const results = toolMessages(messages);
  assert.deepEqual(results.map((m) => m.tool_call_id), ['call_1', 'call_2'], 'one tool message per call, in order');
  assert.equal(results[1].content, 'Skipped: run aborted');
  assert.equal(client.requests.length, 1, 'the model is not called again after an abort');
});

test('Ctrl+C at the [y/N] question: the question is cancelled and the call is skipped', async () => {
  const controller = new AbortController();
  const messages = user('List the files.');
  // This is what rl.question(prompt, { signal }) does when the signal aborts: it rejects with an AbortError.
  const confirm = (command, opts) => new Promise((resolve, reject) => {
    const signal = opts?.signal;
    assert.ok(signal, "confirm(command, { signal }) receives the run's signal");
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    setTimeout(() => controller.abort(), 10);
  });
  const r = await runTurns({ client: scripted(bash('ls')), messages, confirm, runTool: echo, signal: controller.signal });

  assert.equal(r.aborted, true);
  assert.equal(messages.at(-1).role, 'tool');
  assert.equal(messages.at(-1).content, 'Skipped: run aborted');
});

test('abort while waiting for the model returns { aborted: true } instead of throwing', async () => {
  const controller = new AbortController();
  const client = {
    chat: (messages, tools, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
    }),
  };
  setTimeout(() => controller.abort(), 10);
  const r = await runTurns({ client, messages: user('Write an essay.'), confirm: yes, runTool: echo, signal: controller.signal });
  assert.equal(r.aborted, true);
});

test('maxTurns stops a model that never stops calling tools', async () => {
  let requests = 0;
  const client = { chat: async () => { requests++; return bash('ls'); } };
  const messages = user('Loop forever.');
  const r = await runTurns({ client, messages, confirm: yes, runTool: echo, maxTurns: 3 });
  assert.equal(requests, 3);
  assert.equal(r.turns, 3);
  assert.equal(r.aborted, false);
  assert.equal(toolMessages(messages).length, 3, 'every call was answered');
});

// runBash spawns a real shell, so these two need a POSIX `sh` (macOS, Linux, or WSL on Windows).
const posix = { skip: process.platform === 'win32' ? 'needs a POSIX shell (use WSL)' : false };

test('runBash: an abort stops a running command at once', posix, async () => {
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 50);
  const out = await runBash('sleep 3', { signal: controller.signal });
  assert.ok(Date.now() - started < 1500, `runBash took ${Date.now() - started} ms to give up`);
  assert.doesNotMatch(out, /timed out/i, 'a user abort is not reported as a timeout');
});

test('runBash: a timeout is reported as a timeout', posix, async () => {
  const out = await runBash('sleep 3', { timeoutMs: 100 });
  assert.match(out, /timed out/i);
});
