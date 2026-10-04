// Course test — Day 15: PromptUI (input routing, Ctrl+C, ask) and UIBridge (runs, queue, abort, errors, history).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventBus } from '../../src/events/event-bus.js';
import { Printer } from '../../src/ui/printer.js';
import { PromptUI } from '../../src/ui/prompt-ui.js';
import { UIBridge } from '../../src/bridge.js';
import { AgentLoop } from '../../src/agent/agent-loop.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { ScriptedProvider } from '../../src/provider/scripted.js';

const tick = () => new Promise((r) => setImmediate(r));

/** A PromptUI over in-memory streams. */
function makeUI({ onExit = () => {} } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (d) => { written += d; });
  const bus = new EventBus();
  const ui = new PromptUI({ input, output, terminal: false, bus, printer: new Printer({ out: output, color: 'never' }), onExit });
  return { ui, bus, input, output: () => written };
}

/** A fake UI that records calls — what the bridge tests drive. */
function fakeUI() {
  const log = [];
  const ui = {
    busy: false,
    log,
    setBusy(b) { ui.busy = b; log.push(['busy', b]); },
    showPrompt() { log.push(['prompt']); },
    printAssistant(t) { log.push(['assistant', t]); },
    printSystem(t) { log.push(['system', t]); },
    printError(t) { log.push(['error', t]); },
    printTool(n, t) { log.push(['tool', n, t]); },
    writeChunk(t, kind) { log.push(['chunk', kind, t]); },
    endStream() {},
    ask: async () => 'n',
  };
  return ui;
}

function makeBridge(script) {
  const bus = new EventBus();
  const provider = new ScriptedProvider(script);
  const loop = new AgentLoop({ provider, registry: new ToolRegistry(), emit: (e, p) => bus.emit(e, p) });
  const ui = fakeUI();
  const bridge = new UIBridge({ bus, loop, ui });
  return { bus, provider, loop, ui, bridge };
}

test('PromptUI: a typed line becomes user_message; a /command becomes command; a line starting with a path is a message', async () => {
  const { ui, bus, input } = makeUI();
  const seen = [];
  bus.on('user_message', (p) => seen.push(['msg', p.content]));
  bus.on('command', (p) => seen.push(['cmd', p.line]));
  ui.start();
  input.write('  hello there  \n\n/help\n/model 2\n/Users/me/app.js why does this crash?\n');
  await tick();
  assert.deepEqual(seen, [
    ['msg', 'hello there'],
    ['cmd', '/help'],
    ['cmd', '/model 2'],
    ['msg', '/Users/me/app.js why does this crash?'], // what dragging a file into the terminal types
  ]);
  ui.stop();
});

test('PromptUI: Ctrl+C while busy emits abort once; a second press exits 130; idle press exits 130', () => {
  const exits = [];
  const { ui, bus } = makeUI({ onExit: (c) => exits.push(c) });
  let aborts = 0;
  bus.on('abort', () => aborts++);
  ui.start();
  ui.setBusy(true);
  ui.handleInterrupt();
  assert.equal(aborts, 1);
  assert.deepEqual(exits, []);
  ui.handleInterrupt();
  assert.deepEqual(exits, [130]);
  ui.setBusy(false);
  ui.handleInterrupt();
  assert.deepEqual(exits, [130, 130]);
  ui.stop();
});

test('PromptUI.ask() answers through the same readline, and that line is NOT a user_message', async () => {
  const { ui, bus, input } = makeUI();
  const msgs = [];
  bus.on('user_message', (p) => msgs.push(p.content));
  ui.start();
  const answer = ui.ask('allow? [y/N] ');
  input.write('y\n');
  assert.equal(await answer, 'y');
  await tick();
  assert.deepEqual(msgs, []);
  ui.stop();
});

test('PromptUI.stop() releases stdin (safe to call twice)', () => {
  const { ui } = makeUI();
  ui.start();
  ui.stop();
  ui.stop();
  assert.equal(ui.rl, null);
});

test('bridge: a message runs, the answer prints, the prompt comes back exactly once', async () => {
  const { bus, bridge, ui } = makeBridge([ScriptedProvider.text('hello!')]);
  bus.emit('user_message', { content: 'hi' });
  await bridge.whenIdle();
  assert.ok(ui.log.some(([k, t]) => k === 'assistant' && t === 'hello!'));
  assert.equal(ui.log.filter(([k]) => k === 'prompt').length, 1);
  assert.equal(ui.busy, false);
});

test('bridge: input during a run is queued and runs next, in order', async () => {
  const { bus, bridge, provider, ui } = makeBridge([
    { delayMs: 50, response: ScriptedProvider.text('first') },
    ScriptedProvider.text('second'),
    ScriptedProvider.text('third'),
  ]);
  bus.emit('user_message', { content: 'one' });
  bus.emit('user_message', { content: 'two' });
  bus.emit('user_message', { content: 'three' });
  assert.ok(ui.log.some(([k, t]) => k === 'system' && /queued/.test(t)));
  await bridge.whenIdle();
  const answers = ui.log.filter(([k]) => k === 'assistant').map(([, t]) => t);
  assert.deepEqual(answers, ['first', 'second', 'third']);
  assert.deepEqual(provider.calls.map((c) => c.messages.at(-1).content), ['one', 'two', 'three']);
});

test('bridge: abort during a run → "aborted", prompt restored, the next message still works', async () => {
  const { bus, bridge, ui } = makeBridge([
    { delayMs: 5_000, response: ScriptedProvider.text('too late') },
    ScriptedProvider.text('back again'),
  ]);
  bus.emit('user_message', { content: 'slow' });
  setTimeout(() => bus.emit('abort', {}), 30);
  await bridge.whenIdle();
  assert.ok(ui.log.some(([k, t]) => k === 'system' && t === 'aborted'));
  assert.equal(ui.busy, false);
  bus.emit('user_message', { content: 'again' });
  await bridge.whenIdle();
  assert.ok(ui.log.some(([k, t]) => k === 'assistant' && t === 'back again'));
});

test('bridge: a provider error → error event + printed message + prompt restored', async () => {
  const { bus, bridge, ui } = makeBridge([{ error: new Error('Cannot reach Ollama — is Ollama running? (`ollama serve`)') }]);
  const errors = [];
  bus.on('error', (p) => errors.push(p.message));
  bus.emit('user_message', { content: 'hi' });
  await bridge.whenIdle();
  assert.equal(errors.length, 1);
  assert.ok(ui.log.some(([k, t]) => k === 'error' && /ollama serve/.test(t)));
  assert.equal(ui.log.at(-1)[0], 'prompt');
});

test('bridge: history accumulates — the second run sees the first conversation', async () => {
  const { bus, bridge, provider } = makeBridge([ScriptedProvider.text('noted'), ScriptedProvider.text('blue')]);
  bus.emit('user_message', { content: 'my favourite colour is blue' });
  await bridge.whenIdle();
  bus.emit('user_message', { content: 'what colour did I say?' });
  await bridge.whenIdle();
  const second = provider.calls[1].messages.slice(1).map((m) => m.content);
  assert.deepEqual(second, ['my favourite colour is blue', 'noted', 'what colour did I say?']);
});

test('bridge: tool activity is shown through the UI', async () => {
  const bus = new EventBus();
  const registry = new ToolRegistry();
  registry.registerTool({ name: 'echo', description: 'echo', parameters: { type: 'object' }, async execute() { return 'pong'; } });
  const provider = new ScriptedProvider([ScriptedProvider.toolCalls(['echo', {}, 'c1']), ScriptedProvider.text('done')]);
  const loop = new AgentLoop({ provider, registry, emit: (e, p) => bus.emit(e, p) });
  const ui = fakeUI();
  const bridge = new UIBridge({ bus, loop, ui });
  bus.emit('user_message', { content: 'go' });
  await bridge.whenIdle();
  assert.ok(ui.log.some(([k, n]) => k === 'tool' && n === 'echo'));
  assert.ok(ui.log.some(([k, t]) => k === 'system' && /pong/.test(t)));
});

test('bridge: Ctrl+C with messages queued aborts the run AND drops the queue, so a second Ctrl+C can exit', async () => {
  const { bus, bridge, provider, ui } = makeBridge([
    { delayMs: 5_000, response: ScriptedProvider.text('too late') },
    ScriptedProvider.text('should never run'),
  ]);
  bus.emit('user_message', { content: 'one' });
  bus.emit('user_message', { content: 'two' });
  bus.emit('user_message', { content: 'three' });
  setTimeout(() => bus.emit('abort', {}), 30);
  await bridge.whenIdle();
  assert.equal(provider.calls.length, 1, 'only the first message reached the model');
  assert.ok(ui.log.some(([k, t]) => k === 'system' && /not sent/.test(t) && /two/.test(t) && /three/.test(t)), 'it says what it dropped');
  assert.equal(ui.busy, false);
});

test('bridge: an aborted run stays in history, followed by a note that you interrupted it', async () => {
  const { bus, bridge, provider } = makeBridge([
    { delayMs: 5_000, response: ScriptedProvider.text('too late') },
    ScriptedProvider.text('4'),
  ]);
  bus.emit('user_message', { content: 'count the files' });
  setTimeout(() => bus.emit('abort', {}), 30);
  await bridge.whenIdle();
  bus.emit('user_message', { content: 'what is 2+2?' });
  await bridge.whenIdle();
  const sent = provider.calls[1].messages.slice(1);
  assert.deepEqual(sent.map((m) => m.role), ['user', 'user', 'user']);
  assert.equal(sent[0].content, 'count the files');
  assert.match(sent[1].content, /interrupted/i);
  assert.equal(sent[2].content, 'what is 2+2?');
});

test('bridge: a run that fails AFTER a tool ran keeps the tool pair in history; a run that failed at once is not kept', async () => {
  const bus = new EventBus();
  const registry = new ToolRegistry();
  registry.registerTool({ name: 'write', description: 'write', parameters: { type: 'object' }, async execute() { return 'Created notes.txt'; } });
  const provider = new ScriptedProvider([
    ScriptedProvider.toolCalls(['write', {}, 'w1']),
    { error: new Error('Cannot reach Ollama') },  // turn 2 of the first run: the file is already written
    { error: new Error('Cannot reach Ollama') },  // the second run fails before anything happens
    ScriptedProvider.text('yes'),
  ]);
  const loop = new AgentLoop({ provider, registry, emit: (e, p) => bus.emit(e, p) });
  const ui = fakeUI();
  const bridge = new UIBridge({ bus, loop, ui });
  for (const content of ['create notes.txt', 'are you there?', 'did it work?']) {
    bus.emit('user_message', { content });
    await bridge.whenIdle();
  }
  const sent = provider.calls[3].messages.slice(1);
  assert.deepEqual(sent.map((m) => [m.role, m.content]), [
    ['user', 'create notes.txt'],
    ['assistant', ''],
    ['tool_result', 'Created notes.txt'],
    ['user', 'did it work?'],
  ]);
});
