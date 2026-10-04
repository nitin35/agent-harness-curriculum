// Course test — Day 21: SSE framing and the OpenAI-compatible provider (string arguments, fragments by index).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SseParser } from '../../src/shared/sse.js';
import { OpenAICompatibleProvider, toWireMessages } from '../../src/provider/openai-compatible.js';
import { AgentLoop } from '../../src/agent/agent-loop.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';

const enc = new TextEncoder();

test('SSE: data lines accumulate, a blank line dispatches, comments ignored, CRLF ok', () => {
  const p = new SseParser();
  const events = [
    ...p.push(enc.encode(': keep-alive\n\ndata: {"a":')),
    ...p.push(enc.encode('1}\r\n\r\nevent: custom\ndata: line1\ndata: line2\n\n')),
    ...p.flush(),
  ];
  assert.deepEqual(events, [
    { event: 'message', data: '{"a":1}' },
    { event: 'custom', data: 'line1\nline2' },
  ]);
});

test('SSE: a final event without a trailing blank line comes out of flush()', () => {
  const p = new SseParser();
  assert.deepEqual(p.push(enc.encode('data: [DONE]')), []);
  assert.deepEqual(p.flush(), [{ event: 'message', data: '[DONE]' }]);
});

// Real capture from Ollama 0.32 /v1 (course-assets/captures/ollama-0.32/openai-compat-stream.sse), shortened.
const OLLAMA_V1 = [
  'data: {"id":"chatcmpl-900","object":"chat.completion.chunk","model":"qwen3.5:4b","choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning":"The"},"finish_reason":null}]}',
  'data: {"id":"chatcmpl-900","object":"chat.completion.chunk","model":"qwen3.5:4b","choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning":" user"},"finish_reason":null}]}',
  'data: {"id":"chatcmpl-900","object":"chat.completion.chunk","model":"qwen3.5:4b","choices":[{"index":0,"delta":{"role":"assistant","content":"","tool_calls":[{"id":"call_uxknz800","index":0,"type":"function","function":{"name":"bash","arguments":"{\\"command\\":\\"ls /tmp/\\"}"}}]},"finish_reason":null}]}',
  'data: {"id":"chatcmpl-900","object":"chat.completion.chunk","model":"qwen3.5:4b","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":"tool_calls"}]}',
  'data: [DONE]',
].join('\n\n') + '\n\n';

// Hand-made: how hosted OpenAI-style APIs stream — arguments split mid-token, two calls interleaved by index.
const FRAGMENTED = [
  { choices: [{ index: 0, delta: { role: 'assistant', content: 'Let me ' } }] },
  { choices: [{ index: 0, delta: { content: 'check.' } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_A', type: 'function', function: { name: 'read', arguments: '' } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_B', type: 'function', function: { name: 'bash', arguments: '{"comm' } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th": "src/a.js"}' } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: 'and": "ls"}' } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  { choices: [], usage: { prompt_tokens: 50, completion_tokens: 12 } },
].map((c) => `data: ${JSON.stringify({ model: 'hosted-model', ...c })}`).join('\n\n') + '\n\ndata: [DONE]\n\n';

function sseFetch(body, { size = 9, capture } = {}) {
  return async (url, init) => {
    capture?.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const bytes = enc.encode(body);
    let i = 0;
    return new Response(new ReadableStream({
      pull(c) {
        if (i >= bytes.length) return c.close();
        c.enqueue(bytes.subarray(i, i + size));
        i += size;
      },
    }));
  };
}

async function collect(gen) { const out = []; for await (const e of gen) out.push(e); return out; }

test('real Ollama /v1 stream: reasoning → thinking_delta; string arguments → object', async () => {
  const p = new OpenAICompatibleProvider({ fetch: sseFetch(OLLAMA_V1) });
  const events = await collect(p.chatStream([{ role: 'user', content: 'ls' }], []));
  assert.deepEqual(events.filter((e) => e.type === 'thinking_delta').map((e) => e.content), ['The', ' user']);
  const { response } = events.at(-1);
  assert.deepEqual(response.toolCalls, [{ id: 'call_uxknz800', name: 'bash', arguments: { command: 'ls /tmp/' } }]);
  assert.equal(response.finishReason, 'tool_calls');
  assert.equal(response.thinking, 'The user');
});

test('fragmented stream: one start per call, fragments routed by index, each parsed ONCE', async () => {
  const p = new OpenAICompatibleProvider({ fetch: sseFetch(FRAGMENTED, { size: 13 }) });
  const events = await collect(p.chatStream([{ role: 'user', content: 'go' }], []));
  assert.deepEqual(events.filter((e) => e.type === 'tool_call_start').map((e) => [e.id, e.name]), [['call_A', 'read'], ['call_B', 'bash']]);
  assert.equal(events.filter((e) => e.type === 'tool_call_delta').length, 4);
  const { response } = events.at(-1);
  assert.equal(response.content, 'Let me check.');
  assert.deepEqual(response.toolCalls, [
    { id: 'call_A', name: 'read', arguments: { path: 'src/a.js' } },
    { id: 'call_B', name: 'bash', arguments: { command: 'ls' } },
  ]);
  assert.deepEqual(response.usage, { promptTokens: 50, completionTokens: 12 });
});

test('request: POST /chat/completions, tools wrapped, include_usage, Bearer key only when set', async () => {
  const capture = [];
  const p = new OpenAICompatibleProvider({ baseUrl: 'http://x/v1', apiKey: 'sk-test', model: 'm', fetch: sseFetch(OLLAMA_V1, { capture }) });
  await collect(p.chatStream([{ role: 'user', content: 'hi' }], [{ name: 'bash', description: 'd', parameters: { type: 'object' } }]));
  const [{ url, init, body }] = capture;
  assert.equal(url, 'http://x/v1/chat/completions');
  assert.equal(init.headers.Authorization, 'Bearer sk-test');
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.tools[0].type, 'function');
  const noKey = [];
  await collect(new OpenAICompatibleProvider({ fetch: sseFetch(OLLAMA_V1, { capture: noKey }) }).chatStream([{ role: 'user', content: 'hi' }], []));
  assert.equal(noKey[0].init.headers.Authorization, undefined);
});

test('toWireMessages: arguments go out as a JSON STRING; results key by tool_call_id', () => {
  const wire = toWireMessages([
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'bash', arguments: { command: 'ls' } }] },
    { role: 'tool_result', content: 'a.txt', toolCallId: 'c1', toolName: 'bash' },
  ]);
  assert.deepEqual(wire[0].tool_calls[0], { id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } });
  assert.deepEqual(wire[1], { role: 'tool', tool_call_id: 'c1', content: 'a.txt' });
});

test('non-stream chat(): string arguments parsed; broken arguments → parseError', async () => {
  const fetch = async () => new Response(JSON.stringify({
    model: 'm',
    choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } },
      { id: 'c2', type: 'function', function: { name: 'read', arguments: '{"path":' } },
    ] } }],
    usage: { prompt_tokens: 5, completion_tokens: 2 },
  }));
  const r = await new OpenAICompatibleProvider({ fetch }).chat([{ role: 'user', content: 'x' }], []);
  assert.deepEqual(r.toolCalls[0], { id: 'c1', name: 'read', arguments: { path: 'a' } });
  assert.match(r.toolCalls[1].parseError, /JSON/);
  assert.equal(r.content, '');
  assert.deepEqual(r.usage, { promptTokens: 5, completionTokens: 2 });
});

test('the SAME AgentLoop runs on this provider unchanged (the seam holds)', async () => {
  const registry = new ToolRegistry();
  const seen = [];
  registry.registerTool({ name: 'read', description: 'r', parameters: { type: 'object', properties: { path: { type: 'string' } } }, async execute({ path }) { seen.push(path); return 'file body'; } });
  registry.registerTool({ name: 'bash', description: 'b', parameters: { type: 'object', properties: { command: { type: 'string' } } }, async execute({ command }) { seen.push(command); return 'out'; } });
  let call = 0;
  const fetch = async (url, init) => (++call === 1 ? sseFetch(FRAGMENTED)(url, init) : new Response(enc.encode('data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')));
  const loop = new AgentLoop({ provider: new OpenAICompatibleProvider({ fetch }), registry, streaming: true });
  const r = await loop.run('go');
  assert.deepEqual(seen, ['src/a.js', 'ls']);
  assert.equal(r.response, 'done');
});

test('getModelInfo: no standard context field — reports the configured window, maxContext null', async () => {
  const info = await new OpenAICompatibleProvider({ contextWindow: 16384 }).getModelInfo('m');
  assert.deepEqual(info, { name: 'm', contextLimit: 16384, maxContext: null, capabilities: [] });
});

test('request: max_tokens is sent (default = the window) so a runaway generation stops', async () => {
  let sent;
  const reply = () => new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }));
  await new OpenAICompatibleProvider({ fetch: async (u, init) => { sent = JSON.parse(init.body); return reply(); }, contextWindow: 2048 }).chat([{ role: 'user', content: 'hi' }], []);
  assert.equal(sent.max_tokens, 2048);
  let sent2;
  await new OpenAICompatibleProvider({ fetch: async (u, init) => { sent2 = JSON.parse(init.body); return reply(); }, maxOutputTokens: 128 }).chat([{ role: 'user', content: 'hi' }], []);
  assert.equal(sent2.max_tokens, 128);
});
