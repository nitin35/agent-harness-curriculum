// Course test — Day 18: the command registry, the parser, built-ins, and listModels().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandRegistry, splitArgs } from '../../src/commands/registry.js';
import { createBuiltinCommands } from '../../src/commands/builtin/index.js';
import { OllamaProvider } from '../../src/provider/ollama.js';

function registryWithBuiltins() {
  const r = new CommandRegistry();
  for (const def of createBuiltinCommands()) r.register(def);
  return r;
}

test('parse: bare, with args, quoted args; a bare "/" or plain text is not a command', () => {
  const r = new CommandRegistry();
  assert.deepEqual(r.parse('/help'), { name: 'help', args: [] });
  assert.deepEqual(r.parse('/model qwen3.5:9b'), { name: 'model', args: ['qwen3.5:9b'] });
  assert.deepEqual(r.parse('/new "my session with spaces" x'), { name: 'new', args: ['my session with spaces', 'x'] });
  assert.equal(r.parse('/'), null);
  assert.equal(r.parse('hello /help'), null);
});

test('splitArgs: whitespace runs collapse; quotes group; empty quotes give an empty arg', () => {
  assert.deepEqual(splitArgs('  a   b  '), ['a', 'b']);
  assert.deepEqual(splitArgs('"a b" c'), ['a b', 'c']);
  assert.deepEqual(splitArgs('""'), ['']);
});

test('register: duplicates and alias clashes are rejected; aliases resolve; unregister works', () => {
  const r = new CommandRegistry();
  const off = r.register({ name: 'greet', aliases: ['g'], description: 'hi', handler: () => 'hi' });
  assert.throws(() => r.register({ name: 'greet', description: 'x', handler: () => {} }), /already/);
  assert.throws(() => r.register({ name: 'other', aliases: ['g'], description: 'x', handler: () => {} }), /already/);
  assert.equal(r.get('g').name, 'greet');
  off();
  assert.equal(r.get('greet'), undefined);
  assert.equal(r.get('g'), undefined);
});

test('handle: unknown commands are friendly text, never the model, never a throw', async () => {
  const r = new CommandRegistry();
  assert.deepEqual(await r.handle('/frobnicate', {}), { ok: false, output: 'Unknown command: /frobnicate. Try /help.' });
});

test('handle: a throwing handler becomes text; success emits command_run', async () => {
  const r = new CommandRegistry();
  const emitted = [];
  r.register({ name: 'boom', description: 'x', handler: () => { throw new Error('kaput'); } });
  r.register({ name: 'ok', description: 'x', handler: (args) => `got ${args.join(',')}` });
  const bus = { emit: (e, p) => emitted.push([e, p]) };
  assert.deepEqual(await r.handle('/boom', { bus }), { ok: false, output: '/boom failed: kaput' });
  assert.deepEqual(await r.handle('/ok a b', { bus }), { ok: true, output: 'got a,b' });
  assert.deepEqual(emitted, [['command_run', { name: 'ok', args: ['a', 'b'] }]]);
});

test('every command /help lists can be typed: names AND aliases follow the command grammar', () => {
  const r = registryWithBuiltins();
  for (const def of r.list()) {
    for (const n of [def.name, ...(def.aliases ?? [])]) {
      assert.equal(r.get(r.parse(`/${n}`)?.name ?? '')?.name, def.name, `/${n} must reach /${def.name}`);
    }
  }
  assert.throws(() => r.register({ name: 'ask', aliases: ['?'], description: 'x', handler: () => {} }), /alias/);
  assert.equal(r.parse('/Users/me/app.js why?'), null, 'a path is not a command');
});

test('idle commands refuse while a run is in flight; the others still run', async () => {
  const r = new CommandRegistry();
  let ran = 0;
  r.register({ name: 'fresh', idle: true, description: 'x', handler: () => { ran++; return 'ok'; } });
  r.register({ name: 'peek', description: 'x', handler: () => 'peeked' });
  const busy = { isBusy: () => true };
  const refused = await r.handle('/fresh', busy);
  assert.equal(refused.ok, false);
  assert.match(refused.output, /between runs/);
  assert.equal(ran, 0);
  assert.equal((await r.handle('/peek', busy)).output, 'peeked');
  assert.equal((await r.handle('/fresh', { isBusy: () => false })).output, 'ok');
  assert.equal(createBuiltinCommands().find((c) => c.name === 'new').idle, true, '/new swaps the session, so it is idle-only');
});

test('/help lists every command with its aliases', async () => {
  const r = registryWithBuiltins();
  const { output } = await r.handle('/help', { commands: r });
  for (const name of ['help', 'session', 'new', 'model', 'quit']) assert.match(output, new RegExp(`/${name}`));
  assert.match(output, /\/exit/);
});

/** A tiny fake context for built-ins. */
function fakeCtx(r, extra = {}) {
  const session = { id: 'abcdef12-0000', header: { model: 'a' }, entries: [], saved: 0, getEntries() { return this.entries; }, getPath() { return []; }, setModel(m) { this.header.model = m; }, async save() { this.saved++; } };
  const provider = {
    model: 'a',
    async listModels() { return [{ name: 'a' }, { name: 'b' }, { name: 'c:latest' }]; },
    setModel(m) { this.model = m; },
    async getModelInfo(m) { return { name: m, capabilities: m === 'b' ? ['completion'] : ['completion', 'tools'] }; },
  };
  return { commands: r, provider, session, getSession: () => session, cwd: '/w', ...extra };
}

test('/model: lists with the active one marked; switches by name or number; refuses a model that is not installed', async () => {
  const r = registryWithBuiltins();
  const ctx = fakeCtx(r);
  const list = (await r.handle('/model', ctx)).output;
  assert.match(list, /\* 1\. a/);
  assert.match(list, / {2}2\. b/);
  const out = (await r.handle('/model 2', ctx)).output;
  assert.equal(ctx.provider.model, 'b');
  assert.equal(ctx.session.header.model, 'b');
  assert.match(out, /model → b/);
  assert.match(out, /does not list "tools"/, 'warns when the model cannot call tools');
  const missing = (await r.handle('/model nope:1b', ctx)).output;
  assert.match(missing, /not installed/);
  assert.match(missing, /ollama pull nope:1b/);
  assert.equal(ctx.provider.model, 'b', 'a typo changes nothing');
  assert.equal(ctx.session.header.model, 'b');
  await r.handle('/model c', ctx);
  assert.equal(ctx.provider.model, 'c:latest', 'a name without a tag means :latest, as in Ollama');
});

test('/quit calls ctx.quit(0)', async () => {
  const r = registryWithBuiltins();
  let code;
  await r.handle('/quit', fakeCtx(r, { quit: (c) => { code = c; } }));
  assert.equal(code, 0);
});

test('OllamaProvider.listModels: GET /api/tags → names', async () => {
  const fetch = async (url, init) => {
    assert.match(url, /\/api\/tags$/);
    assert.equal(init.method, 'GET');
    return new Response(JSON.stringify({ models: [{ name: 'qwen3.5:4b', model: 'qwen3.5:4b', size: 3 }, { name: 'gemma4:e4b', size: 9 }] }));
  };
  assert.deepEqual((await new OllamaProvider({ fetch }).listModels()).map((m) => m.name), ['qwen3.5:4b', 'gemma4:e4b']);
});
