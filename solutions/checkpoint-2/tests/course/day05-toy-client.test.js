// Course test — Day 5: the toy client, tested offline through the fetch you injected today.
// Copy into your project as tests/course/day05-toy-client.test.js, then: node --test tests/course/day05-*
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOllamaClient } from '../../toy/ollama.mjs';

/** A streaming body made of NDJSON lines. */
const ndjson = (...lines) => new Response(new ReadableStream({
  start(c) { for (const line of lines) c.enqueue(new TextEncoder().encode(`${line}\n`)); c.close(); },
}));

test('a model that cannot think: the toy drops `think` once, retries, and leaves it off', async () => {
  const sent = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body.think);
    if (body.think) return new Response(JSON.stringify({ error: '"llama3.2:1b" does not support thinking' }), { status: 400 });
    return ndjson('{"message":{"content":"hi"},"done":true}');
  };
  const client = createOllamaClient({ model: 'llama3.2:1b', fetch });
  assert.equal((await client.chat([{ role: 'user', content: 'hi' }], [])).content, 'hi');
  assert.deepEqual(sent, [true, false], 'one refused request, then a retry with think: false');
  await client.chat([{ role: 'user', content: 'again' }], []);
  assert.deepEqual(sent, [true, false, false], 'the next request asks without thinking from the start');
});

test('any other HTTP error still throws, naming the status, after one request', async () => {
  let requests = 0;
  const fetch = async () => { requests++; return new Response('{"error":"model \'nope\' not found"}', { status: 404 }); };
  await assert.rejects(createOllamaClient({ model: 'nope', fetch }).chat([{ role: 'user', content: 'hi' }], []), /404/);
  assert.equal(requests, 1);
});
