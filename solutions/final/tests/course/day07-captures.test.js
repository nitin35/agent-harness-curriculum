// Course test — Day 7: YOUR wire captures in fixtures/ have the shapes the provider will rely on.
// If a check fails because your server/model behaves differently, that is a finding, not a failure:
// write it down in docs/architecture.md and adjust (or skip) that assertion — your capture is the ground truth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NdjsonParser } from '../../src/shared/ndjson.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures');
const read = (name) => fs.readFileSync(path.join(FIXTURES, name));
const ndjson = (name) => { const p = new NdjsonParser(); return [...p.push(read(name)), ...p.flush()]; };

test('fixtures/chat.json: one JSON object, text at message.content, done + done_reason, token counts', () => {
  const body = JSON.parse(read('chat.json'));
  assert.equal(typeof body.message.content, 'string');
  assert.equal(body.done, true);
  assert.equal(typeof body.done_reason, 'string');
  assert.equal(typeof body.prompt_eval_count, 'number');
  assert.equal(typeof body.eval_count, 'number');
});

test('fixtures/stream.ndjson: every line parses alone; only the last has done: true', () => {
  const records = ndjson('stream.ndjson');
  assert.ok(records.length > 1);
  assert.equal(records.at(-1).done, true);
  assert.ok(records.slice(0, -1).every((r) => r.done === false));
  assert.ok(!read('stream.ndjson').toString().includes('data:'), 'NDJSON, not SSE');
});

test('fixtures/chat-tools.json: tool calls with function.name and OBJECT arguments', () => {
  const body = JSON.parse(read('chat-tools.json'));
  const calls = body.message.tool_calls;
  assert.ok(Array.isArray(calls) && calls.length > 0, 'the model called a tool');
  assert.equal(typeof calls[0].function.name, 'string');
  assert.equal(typeof calls[0].function.arguments, 'object', 'Ollama sends arguments as an object, not a string');
  // content is often '' alongside tool calls, but some models write a sentence first; the provider handles both
  assert.equal(typeof body.message.content, 'string');
});

test('fixtures/stream-tools.ndjson: tool calls arrive in an EARLIER chunk, not in the done chunk', () => {
  const records = ndjson('stream-tools.ndjson');
  const withCalls = records.filter((r) => r.message?.tool_calls?.length);
  assert.ok(withCalls.length > 0, 'at least one chunk carries tool calls');
  assert.ok(withCalls.every((r) => r.done === false));
  assert.equal(records.at(-1).message?.tool_calls, undefined, 'the final chunk does not repeat them');
});
