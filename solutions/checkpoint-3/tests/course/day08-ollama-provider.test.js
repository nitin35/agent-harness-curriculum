// Course test — Day 8: OllamaProvider.chat(), wire mapping, error taxonomy, getModelInfo().
// No network: every test injects a fake fetch. The response bodies are excerpts of real
// Ollama 0.32 captures (course-assets/captures/ollama-0.32/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OllamaProvider, toWireMessages, fromWireResponse } from '../../src/provider/ollama.js';
import { ProviderError } from '../../src/shared/errors.js';

const CAPTURE_TOOLS = {
  model: 'qwen3.5:4b',
  message: {
    role: 'assistant', content: '', thinking: 'The user wants me to list /tmp…',
    tool_calls: [{ id: 'call_tgzmiyhh', function: { index: 0, name: 'bash', arguments: { command: 'ls -la /tmp' } } }],
  },
  done: true, done_reason: 'stop', prompt_eval_count: 302, eval_count: 178,
};

/** A fake fetch that records requests and answers with `reply(url, body)`. */
function fakeFetch(reply) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, signal: init.signal });
    const r = await reply(url, body, init);
    if (r instanceof Response) return r;
    return new Response(typeof r === 'string' ? r : JSON.stringify(r), { status: 200 });
  };
  fn.calls = calls;
  return fn;
}

const BASH = { name: 'bash', description: 'Run a shell command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } };

test('every request sends num_ctx (never trust the server default) and think', async () => {
  const fetch = fakeFetch(() => ({ model: 'm', message: { role: 'assistant', content: 'hi' }, done: true, done_reason: 'stop' }));
  const p = new OllamaProvider({ fetch, model: 'm', contextWindow: 8192, think: true });
  await p.chat([{ role: 'user', content: 'hi' }], []);
  const { url, body } = fetch.calls[0];
  assert.equal(url, 'http://localhost:11434/api/chat');
  assert.equal(body.options.num_ctx, 8192);
  assert.equal(body.think, true);
  assert.equal(body.stream, false);
  assert.equal(body.tools, undefined, 'no tools key when there are no tools');
});

test('every request also caps the reply (num_predict), by default at the context window', async () => {
  const fetch = fakeFetch(() => ({ model: 'm', message: { role: 'assistant', content: 'hi' }, done: true, done_reason: 'stop' }));
  await new OllamaProvider({ fetch, contextWindow: 8192 }).chat([{ role: 'user', content: 'hi' }], []);
  await new OllamaProvider({ fetch, contextWindow: 8192, maxOutputTokens: 1024 }).chat([{ role: 'user', content: 'hi' }], []);
  assert.deepEqual(fetch.calls.map((c) => c.body.options.num_predict), [8192, 1024]);
});

test('no response headers within 5 minutes → a bad_response that says the model may still be generating', async () => {
  const fetch = async () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) });
  };
  await assert.rejects(new OllamaProvider({ fetch, model: 'tiny' }).chat([{ role: 'user', content: 'hi' }], []), (err) => {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.kind, 'bad_response');
    assert.match(err.message, /No answer from Ollama within 5 minutes \(tiny may still be generating\)/);
    assert.match(err.hint, /maxOutputTokens/);
    return true;
  });
});

test('tools are wrapped in the {type:"function", function:{…}} wire shape', async () => {
  const fetch = fakeFetch(() => CAPTURE_TOOLS);
  const p = new OllamaProvider({ fetch });
  await p.chat([{ role: 'user', content: 'ls /tmp' }], [BASH]);
  assert.deepEqual(fetch.calls[0].body.tools, [{ type: 'function', function: BASH }]);
});

test('toWireMessages: the role-mapping table', () => {
  const wire = toWireMessages([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'u' },
    { role: 'assistant', content: '', thinking: 'hmm', toolCalls: [{ id: 'call_1', name: 'bash', arguments: { command: 'ls' } }] },
    { role: 'tool_result', content: 'a.txt', toolCallId: 'call_1', toolName: 'bash', isError: false },
  ]);
  assert.deepEqual(wire[0], { role: 'system', content: 'sys' });
  assert.deepEqual(wire[1], { role: 'user', content: 'u' });
  assert.equal(wire[2].role, 'assistant');
  assert.equal(wire[2].thinking, 'hmm', 'thinking goes back to the server with tool turns');
  assert.equal(wire[2].tool_calls[0].id, 'call_1');
  assert.equal(wire[2].tool_calls[0].function.name, 'bash');
  assert.deepEqual(wire[2].tool_calls[0].function.arguments, { command: 'ls' });
  assert.equal(wire[3].role, 'tool');
  assert.equal(wire[3].tool_name, 'bash');
  assert.equal(wire[3].tool_call_id, 'call_1');
  assert.equal(wire[3].content, 'a.txt');
});

test('fromWireResponse: keeps the server id, plain-object arguments, thinking, usage', () => {
  const r = fromWireResponse(CAPTURE_TOOLS, 'fallback');
  assert.equal(r.model, 'qwen3.5:4b');
  assert.equal(r.content, '');
  assert.equal(r.thinking, 'The user wants me to list /tmp…');
  assert.deepEqual(r.toolCalls, [{ id: 'call_tgzmiyhh', name: 'bash', arguments: { command: 'ls -la /tmp' } }]);
  assert.equal(r.finishReason, 'tool_calls');
  assert.deepEqual(r.usage, { promptTokens: 302, completionTokens: 178 });
});

test('a tool call without an id gets a generated, unique, non-empty id', () => {
  const body = structuredClone(CAPTURE_TOOLS);
  body.message.tool_calls = [
    { function: { name: 'bash', arguments: { command: 'a' } } },
    { function: { name: 'bash', arguments: { command: 'b' } } },
  ];
  const [a, b] = fromWireResponse(body, 'm').toolCalls;
  assert.ok(typeof a.id === 'string' && a.id.length > 0);
  assert.notEqual(a.id, b.id);
});

test('string arguments are parsed at the boundary; broken JSON becomes parseError (never a throw)', () => {
  const body = structuredClone(CAPTURE_TOOLS);
  body.message.tool_calls = [
    { id: 'c1', function: { name: 'bash', arguments: '{"command":"ls"}' } },
    { id: 'c2', function: { name: 'bash', arguments: '{"command": "ls' } },
  ];
  const [good, bad] = fromWireResponse(body, 'm').toolCalls;
  assert.deepEqual(good.arguments, { command: 'ls' });
  assert.equal(good.parseError, undefined);
  assert.deepEqual(bad.arguments, {});
  assert.match(bad.parseError, /JSON/);
});

test('plain text answer: finishReason comes from done_reason', () => {
  const r = fromWireResponse({ model: 'm', message: { role: 'assistant', content: 'Four' }, done: true, done_reason: 'length' }, 'm');
  assert.equal(r.content, 'Four');
  assert.deepEqual(r.toolCalls, []);
  assert.equal(r.finishReason, 'length');
});

test('connection refused → ProviderError "unreachable" that mentions ollama serve', async () => {
  const fetch = async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) }); };
  const p = new OllamaProvider({ fetch });
  await assert.rejects(p.chat([{ role: 'user', content: 'hi' }], []), (err) => {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.kind, 'unreachable');
    assert.equal(err.category, 'provider');
    assert.match(err.message, /ollama serve/);
    return true;
  });
});

test('model not found → ProviderError "model_not_found" that suggests ollama pull', async () => {
  const fetch = fakeFetch(() => new Response(JSON.stringify({ error: "model 'nope' not found" }), { status: 404 }));
  const p = new OllamaProvider({ fetch, model: 'nope' });
  await assert.rejects(p.chat([{ role: 'user', content: 'hi' }], []), (err) => {
    assert.equal(err.kind, 'model_not_found');
    assert.match(err.message, /ollama pull nope/);
    return true;
  });
});

test('malformed body → ProviderError "bad_response" that describes what arrived', async () => {
  const p1 = new OllamaProvider({ fetch: fakeFetch(() => 'this is not json') });
  await assert.rejects(p1.chat([{ role: 'user', content: 'hi' }], []), (err) => err.kind === 'bad_response');
  const p2 = new OllamaProvider({ fetch: fakeFetch(() => ({ answer: 42 })) });
  await assert.rejects(p2.chat([{ role: 'user', content: 'hi' }], []), (err) => {
    assert.equal(err.kind, 'bad_response');
    assert.match(err.message, /answer/, 'names the keys it received');
    return true;
  });
});

test('abort is not a provider error: the AbortError passes through untouched', async () => {
  const fetch = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });
  const p = new OllamaProvider({ fetch });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(p.chat([{ role: 'user', content: 'hi' }], [], { signal: controller.signal }), (err) => {
    assert.equal(err.name, 'AbortError');
    assert.ok(!(err instanceof ProviderError));
    return true;
  });
});

test('getModelInfo: contextLimit is min(num_ctx we send, model maximum)', async () => {
  const fetch = fakeFetch((url) => {
    assert.match(url, /\/api\/show$/);
    return { capabilities: ['completion', 'tools', 'thinking'], model_info: { 'general.architecture': 'qwen35', 'qwen35.context_length': 262144 } };
  });
  const p = new OllamaProvider({ fetch, contextWindow: 8192 });
  const info = await p.getModelInfo('qwen3.5:4b');
  assert.deepEqual(info, { name: 'qwen3.5:4b', maxContext: 262144, contextLimit: 8192, capabilities: ['completion', 'tools', 'thinking'] });
});

test('getModelInfo: a small model maximum wins over a bigger requested window', async () => {
  const fetch = fakeFetch(() => ({ model_info: { 'llama.context_length': 4096 } }));
  const info = await new OllamaProvider({ fetch, contextWindow: 8192 }).getModelInfo('m');
  assert.equal(info.contextLimit, 4096);
});

test('getModelInfo: no *.context_length key → warn loudly and fall back to the requested window', async () => {
  const warnings = [];
  const fetch = fakeFetch(() => ({ model_info: {} }));
  const p = new OllamaProvider({ fetch, contextWindow: 8192, onWarn: (m) => warnings.push(m) });
  const info = await p.getModelInfo('m');
  assert.equal(info.maxContext, null);
  assert.equal(info.contextLimit, 8192);
  assert.equal(warnings.length, 1);
});

test('a model that cannot think: drop `think`, warn once, retry, and leave it out from then on', async () => {
  const warnings = [];
  const fetch = fakeFetch((url, body) => (body.think !== undefined
    ? new Response(JSON.stringify({ error: '"tiny:1b" does not support thinking' }), { status: 400 })
    : { model: 'tiny:1b', message: { role: 'assistant', content: 'hi' }, done: true, done_reason: 'stop' }));
  const p = new OllamaProvider({ fetch, model: 'tiny:1b', think: true, onWarn: (m) => warnings.push(m) });
  const r = await p.chat([{ role: 'user', content: 'hi' }], []);
  assert.equal(r.content, 'hi');
  assert.equal(fetch.calls.length, 2, 'one rejected request, one retry');
  assert.equal(fetch.calls[1].body.think, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /does not support thinking/);
  await p.chat([{ role: 'user', content: 'again' }], []);
  assert.equal(fetch.calls.length, 3, 'the next request leaves think out from the start');
  assert.equal(fetch.calls[2].body.think, undefined);
});

test('a model glitch (HTTP 500) is a bad_response that names the model and says what to do', async () => {
  for (const error of ["error parsing tool call: raw='{\"path\": '", 'prediction aborted, token repeat limit reached']) {
    const fetch = fakeFetch(() => new Response(JSON.stringify({ error }), { status: 500 }));
    await assert.rejects(new OllamaProvider({ fetch, model: 'tiny' }).chat([{ role: 'user', content: 'hi' }], []), (err) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'bad_response');
      assert.match(err.message, /^tiny produced output Ollama could not use \((error parsing tool call|token repeat limit reached)\)$/);
      assert.match(err.hint, /stronger model/);
      return true;
    });
    assert.equal(fetch.calls.length, 1, 'no automatic retry: it did not help when measured');
  }
});

test('a server fault (any other HTTP 500) stays an http error', async () => {
  const fetch = fakeFetch(() => new Response(JSON.stringify({ error: 'model requires more system memory' }), { status: 500 }));
  await assert.rejects(new OllamaProvider({ fetch }).chat([{ role: 'user', content: 'hi' }], []), (err) => {
    assert.equal(err.kind, 'http');
    assert.match(err.message, /HTTP 500/);
    return true;
  });
});

test('setModel changes what the next request sends', async () => {
  const fetch = fakeFetch(() => ({ model: 'x', message: { role: 'assistant', content: 'ok' }, done: true }));
  const p = new OllamaProvider({ fetch, model: 'a' });
  p.setModel('b');
  await p.chat([{ role: 'user', content: 'hi' }], []);
  assert.equal(fetch.calls[0].body.model, 'b');
});
