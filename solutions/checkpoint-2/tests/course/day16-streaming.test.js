// Course test — Day 16 (Checkpoint 2): chatStream, tool-call assembly, abort/disconnect, loop parity.
// Stream bodies below are lines from real Ollama 0.32 captures (course-assets/captures/ollama-0.32/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OllamaProvider } from '../../src/provider/ollama.js';
import { ToolCallAssembler } from '../../src/provider/tool-call-assembler.js';
import { ScriptedProvider } from '../../src/provider/scripted.js';
import { AgentLoop } from '../../src/agent/agent-loop.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';

const TEXT_STREAM = [
  '{"model":"qwen3.5:4b","message":{"role":"assistant","content":"Hello"},"done":false}',
  '{"model":"qwen3.5:4b","message":{"role":"assistant","content":""},"done":false}',
  '{"model":"qwen3.5:4b","message":{"role":"assistant","content":" there, "},"done":false}',
  '{"model":"qwen3.5:4b","message":{"role":"assistant","content":"friend → é"},"done":false}',
  '{"model":"qwen3.5:4b","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","prompt_eval_count":21,"eval_count":9}',
].join('\n') + '\n';

const TOOL_STREAM = [
  '{"model":"qwen3.5:4b","message":{"role":"assistant","content":"","thinking":"The"},"done":false}',
  '{"model":"qwen3.5:4b","message":{"role":"assistant","content":"","thinking":" user"},"done":false}',
  '{"model":"qwen3.5:4b","message":{"role":"assistant","content":"","tool_calls":[{"id":"call_ilgg65b6","function":{"index":0,"name":"bash","arguments":{"command":"ls -la /tmp"}}}]},"done":false}',
  '{"model":"qwen3.5:4b","message":{"role":"assistant","content":"","tool_calls":[{"id":"call_bfxc8z8k","function":{"index":1,"name":"bash","arguments":{"command":"cat /etc/hosts"}}}]},"done":false}',
  '{"model":"qwen3.5:4b","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","prompt_eval_count":302,"eval_count":106}',
].join('\n') + '\n';

/** fetch that answers with `body` split into byte chunks of `size` (hostile chunking). */
function streamingFetch(body, { size = 7, endEarlyAfter, delayMs = 0 } = {}) {
  return async (url, init) => {
    const bytes = new TextEncoder().encode(body);
    const end = endEarlyAfter ?? bytes.length;
    let i = 0;
    let ctrl;
    const stream = new ReadableStream({
      start(controller) { ctrl = controller; },
      async pull(controller) {
        if (init.signal?.aborted) return controller.error(init.signal.reason);
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        if (i >= end) return controller.close();
        controller.enqueue(bytes.subarray(i, Math.min(i + size, end)));
        i += size;
      },
    });
    // like real fetch: aborting the request errors the body stream
    init.signal?.addEventListener('abort', () => { try { ctrl.error(init.signal.reason); } catch {} }, { once: true });
    return new Response(stream, { status: 200 });
  };
}

async function collect(gen) {
  const events = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

test('text stream: deltas in order, empty deltas skipped, done carries the assembled response', async () => {
  const p = new OllamaProvider({ fetch: streamingFetch(TEXT_STREAM, { size: 5 }) });
  const events = await collect(p.chatStream([{ role: 'user', content: 'hi' }], []));
  const deltas = events.filter((e) => e.type === 'text_delta').map((e) => e.content);
  assert.deepEqual(deltas, ['Hello', ' there, ', 'friend → é']);
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.response.content, 'Hello there, friend → é');
  assert.equal(done.response.finishReason, 'stop');
  assert.deepEqual(done.response.usage, { promptTokens: 21, completionTokens: 9 });
  assert.deepEqual(done.response.toolCalls, []);
});

test('the request asks for stream: true and still sends num_ctx', async () => {
  let sent;
  const fetch = async (url, init) => { sent = JSON.parse(init.body); return streamingFetch(TEXT_STREAM)(url, init); };
  await collect(new OllamaProvider({ fetch, contextWindow: 8192 }).chatStream([{ role: 'user', content: 'hi' }], []));
  assert.equal(sent.stream, true);
  assert.equal(sent.options.num_ctx, 8192);
});

test('tool stream: thinking deltas, one tool_call_start per call, calls collected from EARLIER chunks', async () => {
  const p = new OllamaProvider({ fetch: streamingFetch(TOOL_STREAM, { size: 11 }) });
  const events = await collect(p.chatStream([{ role: 'user', content: 'ls' }], []));
  assert.deepEqual(events.filter((e) => e.type === 'thinking_delta').map((e) => e.content), ['The', ' user']);
  const starts = events.filter((e) => e.type === 'tool_call_start');
  assert.deepEqual(starts.map((e) => [e.id, e.name]), [['call_ilgg65b6', 'bash'], ['call_bfxc8z8k', 'bash']]);
  const { response } = events.at(-1);
  assert.equal(response.thinking, 'The user');
  assert.equal(response.finishReason, 'tool_calls');
  assert.deepEqual(response.toolCalls, [
    { id: 'call_ilgg65b6', name: 'bash', arguments: { command: 'ls -la /tmp' } },
    { id: 'call_bfxc8z8k', name: 'bash', arguments: { command: 'cat /etc/hosts' } },
  ]);
});

test('every byte delivered separately: same result (framing + UTF-8 survive)', async () => {
  const p = new OllamaProvider({ fetch: streamingFetch(TEXT_STREAM, { size: 1 }) });
  const events = await collect(p.chatStream([{ role: 'user', content: 'hi' }], []));
  assert.equal(events.at(-1).response.content, 'Hello there, friend → é');
});

test('disconnect: a body that ends without done throws a clear error', async () => {
  const cut = TEXT_STREAM.indexOf('\n', 80) + 1;
  const p = new OllamaProvider({ fetch: streamingFetch(TEXT_STREAM, { endEarlyAfter: cut }) });
  await assert.rejects(collect(p.chatStream([{ role: 'user', content: 'hi' }], [])), /disconnected before done/);
});

test('an error inside the stream: a model glitch is a bad_response with a hint (as in Day 8); anything else stays http', async () => {
  const line = (o) => `${JSON.stringify(o)}\n`;
  const run = (error) => collect(new OllamaProvider({
    fetch: streamingFetch(line({ model: 'qwen3.5:4b', message: { role: 'assistant', content: 'Hi' }, done: false }) + line({ error })),
  }).chatStream([{ role: 'user', content: 'hi' }], []));
  await assert.rejects(run(`error parsing tool call: raw='{"name": "bash"'`), (err) =>
    err.kind === 'bad_response' && /could not use \(error parsing tool call\)/.test(err.message) && /stronger model/.test(err.hint));
  await assert.rejects(run('out of memory'), (err) => err.kind === 'http' && /out of memory/.test(err.message));
});

test('abort mid-stream: the generator ends quietly — no done, no throw', async () => {
  const controller = new AbortController();
  const p = new OllamaProvider({ fetch: streamingFetch(TEXT_STREAM, { size: 3, delayMs: 20 }) });
  const events = [];
  for await (const ev of p.chatStream([{ role: 'user', content: 'hi' }], [], { signal: controller.signal })) {
    events.push(ev);
    if (ev.type === 'text_delta') controller.abort();
  }
  assert.ok(events.some((e) => e.type === 'text_delta'));
  assert.ok(!events.some((e) => e.type === 'done'));
});

test('ToolCallAssembler: OpenAI-style fragments keyed by index, parsed ONCE at the end', () => {
  const a = new ToolCallAssembler();
  const id = a.start(0, { id: 'call_x', name: 'read' });
  a.append(0, '{"pa');
  a.append(0, '');
  a.append(0, 'th": "src/');
  a.append(0, 'a.js"}');
  const generated = a.start(1, { name: 'bash' });            // no id from the server → generated
  a.append(1, '{"command": "ls"');                           // broken JSON — reported, not thrown
  assert.equal(id, 'call_x');
  assert.ok(generated.length > 0);
  const [first, second] = a.finish();
  assert.deepEqual(first, { id: 'call_x', name: 'read', arguments: { path: 'src/a.js' } });
  assert.equal(second.id, generated);
  assert.deepEqual(second.arguments, {});
  assert.match(second.parseError, /JSON/);
});

function echoRegistry() {
  const r = new ToolRegistry();
  r.registerTool({ name: 'echo', description: 'echo', parameters: { type: 'object', properties: { text: { type: 'string' } } }, async execute({ text }) { return `echo ${text}`; } });
  return r;
}
const SCRIPT = () => [
  { ...ScriptedProvider.toolCalls(['echo', { text: 'hi' }, 'c1']), thinking: 'let me echo' },
  ScriptedProvider.text('all done here'),
];

test('parity: streaming and non-streaming runs produce IDENTICAL history', async () => {
  const plain = await new AgentLoop({ provider: new ScriptedProvider(SCRIPT()), registry: echoRegistry() }).run('go');
  const streamed = await new AgentLoop({ provider: new ScriptedProvider(SCRIPT()), registry: echoRegistry(), streaming: true }).run('go');
  assert.deepEqual(streamed.newMessages, plain.newMessages);
  assert.equal(streamed.response, 'all done here');
});

test('streaming loop emits thinking_delta and text_delta that add up to the answer', async () => {
  const events = [];
  const loop = new AgentLoop({
    provider: new ScriptedProvider(SCRIPT()), registry: echoRegistry(), streaming: true,
    emit: (name, p) => { if (name.endsWith('_delta')) events.push([name, p.content]); },
  });
  await loop.run('go');
  assert.equal(events.filter(([n]) => n === 'thinking_delta').map(([, c]) => c).join(''), 'let me echo');
  assert.equal(events.filter(([n]) => n === 'text_delta').map(([, c]) => c).join(''), 'all done here');
});

test('streaming loop: abort mid-stream returns aborted, never throws', async () => {
  const controller = new AbortController();
  const provider = new ScriptedProvider([{ chunkDelayMs: 30, response: ScriptedProvider.text('a long long answer') }]);
  const loop = new AgentLoop({
    provider, registry: new ToolRegistry(), streaming: true,
    emit: (name) => { if (name === 'text_delta') controller.abort(); },
  });
  const r = await loop.run('go', [], { signal: controller.signal });
  assert.equal(r.aborted, true);
});

test('streaming loop: a stream that ends without done (and no abort) is an error', async () => {
  const provider = new ScriptedProvider([{ events: [{ type: 'text_delta', content: 'partial' }] }]);
  const loop = new AgentLoop({ provider, registry: new ToolRegistry(), streaming: true });
  await assert.rejects(loop.run('go'), /without a done/);
});

test('UI: thinking streams on its own line, then "agent> " starts the answer', async () => {
  const { PromptUI } = await import('../../src/ui/prompt-ui.js');
  const { Printer } = await import('../../src/ui/printer.js');
  const { EventBus } = await import('../../src/events/event-bus.js');
  let out = '';
  const sink = { write: (s) => { out += s; return true; } };
  const ui = new PromptUI({ printer: new Printer({ out: sink, color: 'never' }), bus: new EventBus(), output: sink, terminal: false });
  ui.writeChunk('I should ', 'thinking');
  ui.writeChunk('answer.', 'thinking');
  ui.writeChunk('Blue', 'text');
  ui.writeChunk(' it is.', 'text');
  ui.endStream();
  assert.equal(out, '  I should answer.\nagent> Blue it is.\n');
});
