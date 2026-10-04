// Course test — Day 22: the extension loader, its isolation, exact unloading, and the project trust gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExtensionLoader, loadProjectExtensions } from '../../src/extensions/loader.js';
import { TrustStore, fingerprintDir } from '../../src/extensions/trust.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { CommandRegistry } from '../../src/commands/registry.js';
import { EventBus } from '../../src/events/event-bus.js';
import { AgentLoop } from '../../src/agent/agent-loop.js';
import { ScriptedProvider } from '../../src/provider/scripted.js';

const HELLO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../examples/extensions/hello-world.js');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-ext-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setup() {
  const registry = new ToolRegistry();
  const commands = new CommandRegistry();
  const bus = new EventBus({ onError: () => {} });
  const warnings = [];
  const submitted = [];
  const notes = [];
  const printed = [];
  const loader = new ExtensionLoader({
    cwd: '/w', registry, commands, bus,
    submit: (c) => submitted.push(c),
    appendNote: (c) => notes.push(c),
    ui: { printSystem: (t) => printed.push(t), ask: async () => 'y' },
    onWarn: (m) => warnings.push(m),
  });
  return { registry, commands, bus, loader, warnings, submitted, notes, printed };
}

function writeExt(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body);
  return path.join(dir, name);
}

test('hello-world: its tool shows up in the NEXT provider call (tools are fetched fresh every turn)', async () => {
  const { registry, commands, bus, loader } = setup();
  const provider = new ScriptedProvider([ScriptedProvider.text('before'), ScriptedProvider.text('after')]);
  const loop = new AgentLoop({ provider, registry });
  await loop.run('one');
  assert.equal(await loader.loadFile(HELLO), 'hello-world');
  await loop.run('two');
  assert.deepEqual(provider.calls[0].tools.map((t) => t.name), []);
  assert.deepEqual(provider.calls[1].tools.map((t) => t.name), ['greet']);
  assert.ok(commands.get('greet'));
  assert.equal(bus.listenerCount('session_start'), 1);
});

test('isolation: a syntax error and a throwing factory are reported; the good extension still loads', async (t) => {
  const dir = tmp(t);
  writeExt(dir, 'a-broken.js', 'export default function ( {');
  writeExt(dir, 'b-throws.js', 'export default function (api) { api.registerTool({ name: "half", description: "x", parameters: { type: "object" }, execute() {} }); throw new Error("nope"); }');
  writeExt(dir, 'c-good.js', 'export default function (api) { api.registerTool({ name: "good", description: "x", parameters: { type: "object" }, execute() { return "ok"; } }); }');
  const { loader, registry, warnings } = setup();
  assert.deepEqual(await loader.loadDir(dir), ['c-good']);
  assert.equal(warnings.length, 2);
  assert.deepEqual(registry.getTools().map((x) => x.name), ['good'], 'the throwing one was rolled back');
});

test('an unknown event name fails that extension at load time (and nothing leaks)', async (t) => {
  const dir = tmp(t);
  const file = writeExt(dir, 'typo.js', 'export default function (api) { api.registerCommand({ name: "x", description: "x", handler() {} }); api.on("tool_call", () => {}); }');
  const { loader, commands, warnings } = setup();
  assert.equal(await loader.loadFile(file), null);
  assert.match(warnings[0], /unknown event 'tool_call'/);
  assert.equal(commands.get('x'), undefined);
});

test('unload removes exactly what the extension registered', async () => {
  const { loader, registry, commands, bus } = setup();
  registry.registerTool({ name: 'core', description: 'x', parameters: { type: 'object' }, execute() {} });
  await loader.loadFile(HELLO);
  assert.equal(loader.unloadExtension('hello-world'), true);
  assert.deepEqual(registry.getTools().map((x) => x.name), ['core']);
  assert.equal(commands.get('greet'), undefined);
  assert.equal(bus.listenerCount('session_start'), 0);
  assert.deepEqual(loader.list(), []);
});

test('sendMessage: queue goes through submit (never a re-entrant run); note is appended without running', async (t) => {
  const dir = tmp(t);
  const file = writeExt(dir, 'poke.js', 'export default function (api) { api.sendMessage("continue the task"); api.sendMessage("user prefers tabs", { as: "note" }); }');
  const { loader, submitted, notes } = setup();
  await loader.loadFile(file);
  assert.deepEqual(submitted, ['continue the task']);
  assert.deepEqual(notes, ['[note from poke] user prefers tabs']);
});

test('trust gate: untrusted + non-interactive → skipped; nothing ran', async (t) => {
  const project = tmp(t);
  const extDir = path.join(project, '.agent-harness', 'extensions');
  writeExt(extDir, 'evil.js', 'globalThis.__evilRan = true; export default function () {}');
  const { loader } = setup();
  const r = await loadProjectExtensions({ dir: extDir, projectRoot: project, loader, trustStore: new TrustStore(path.join(tmp(t), 'trusted.json')), interactive: false });
  assert.equal(r.skipped, true);
  assert.equal(globalThis.__evilRan, undefined);
});

test('trust gate: "n" skips; "y" loads AND records trust in YOUR config (not in the repo)', async (t) => {
  const project = tmp(t);
  const home = tmp(t);
  const extDir = path.join(project, '.agent-harness', 'extensions');
  writeExt(extDir, 'helper.js', 'export default function (api) { api.registerTool({ name: "helper", description: "x", parameters: { type: "object" }, execute() { return "ok"; } }); }');
  const store = new TrustStore(path.join(home, 'trusted-projects.json'));

  const s1 = setup();
  const no = await loadProjectExtensions({ dir: extDir, projectRoot: project, loader: s1.loader, trustStore: store, ask: async () => 'n' });
  assert.equal(no.skipped, true);
  assert.equal(s1.registry.getTools().length, 0);

  const s2 = setup();
  let asked = '';
  const yes = await loadProjectExtensions({ dir: extDir, projectRoot: project, loader: s2.loader, trustStore: store, ask: async (q) => { asked = q; return 'y'; } });
  assert.match(asked, /helper\.js/);
  assert.match(asked, /YOUR privileges/);
  assert.deepEqual(yes.loaded, ['helper']);
  assert.ok(fs.existsSync(path.join(home, 'trusted-projects.json')));
  assert.ok(!fs.readdirSync(path.join(project, '.agent-harness')).some((n) => n.includes('trust')), 'no trust file in the repo');

  const s3 = setup();
  const again = await loadProjectExtensions({ dir: extDir, projectRoot: project, loader: s3.loader, trustStore: store, ask: async () => { throw new Error('should not ask'); } });
  assert.equal(again.reason, 'trusted');
});

test('trust gate: changing or adding a file asks again (trust is per exact code)', async (t) => {
  const project = tmp(t);
  const extDir = path.join(project, '.agent-harness', 'extensions');
  writeExt(extDir, 'a.js', 'export default function () {}');
  const store = new TrustStore(path.join(tmp(t), 'trusted.json'));
  await store.trust(project, await fingerprintDir(extDir));
  assert.equal(await store.isTrusted(project, await fingerprintDir(extDir)), true);
  writeExt(extDir, 'a.js', 'export default function () { /* changed */ }');
  assert.equal(await store.isTrusted(project, await fingerprintDir(extDir)), false);
});

test('trust covers imported helpers too: changing a file the extension imports re-asks', async (t) => {
  const project = tmp(t);
  const extDir = path.join(project, '.agent-harness', 'extensions');
  writeExt(extDir, 'main.js', "import { go } from './lib/helper.js';\nexport default (api) => go(api);\n");
  writeExt(path.join(extDir, 'lib'), 'helper.js', "export const go = () => {};\n");
  const store = new TrustStore(path.join(tmp(t), 'trusted.json'));
  await store.trust(project, await fingerprintDir(extDir));
  assert.equal(await store.isTrusted(project, await fingerprintDir(extDir)), true);
  // the entry point is unchanged; only the imported helper changed — still must re-ask
  writeExt(path.join(extDir, 'lib'), 'helper.js', "export const go = (api) => { api.somethingEvil?.(); };\n");
  assert.equal(await store.isTrusted(project, await fingerprintDir(extDir)), false);
});

test('a trusted.json shipped INSIDE the repo has no effect', async (t) => {
  const project = tmp(t);
  const extDir = path.join(project, '.agent-harness', 'extensions');
  writeExt(extDir, 'x.js', 'export default function () {}');
  fs.writeFileSync(path.join(project, '.agent-harness', 'trusted.json'), JSON.stringify({ trusted: true, projects: { [project]: { files: {} } } }));
  const { loader } = setup();
  const r = await loadProjectExtensions({ dir: extDir, projectRoot: project, loader, trustStore: new TrustStore(path.join(tmp(t), 'mine.json')), interactive: false });
  assert.equal(r.skipped, true);
});

test('--allow-project-extensions loads without asking (for CI) and records nothing', async (t) => {
  const project = tmp(t);
  const home = tmp(t);
  const extDir = path.join(project, '.agent-harness', 'extensions');
  writeExt(extDir, 'ci.js', 'export default function () {}');
  const { loader } = setup();
  const r = await loadProjectExtensions({ dir: extDir, projectRoot: project, loader, trustStore: new TrustStore(path.join(home, 't.json')), allowProjectExtensions: true });
  assert.deepEqual(r.loaded, ['ci']);
  assert.equal(fs.existsSync(path.join(home, 't.json')), false);
});
