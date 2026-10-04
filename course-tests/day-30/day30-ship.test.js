// Course test — Day 30: the offline demo, the real extension, and the shipped docs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ExtensionLoader } from '../../src/extensions/loader.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { CommandRegistry } from '../../src/commands/registry.js';
import { EventBus } from '../../src/events/event-bus.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hasGit = spawnSync('git', ['--version']).status === 0;

// Offline, for real: this preload replaces fetch before the demo starts, so any network use fails the run,
// even on a machine where Ollama is running.
const NO_NETWORK = 'data:text/javascript,globalThis.fetch=async()=>{throw new Error("the demo used the network")};';

test('examples/demo.js runs offline and shows a tool call, a save and a resume', () => {
  const r = spawnSync(process.execPath, ['--import', NO_NETWORK, path.join(ROOT, 'examples/demo.js')], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /⚙ \w+/, 'a tool call is shown');
  assert.match(r.stdout, /reopening/i);
  assert.match(r.stdout, /tool_result/);
});

test('git-status extension: git_status is read-only; git_commit needs approval and uses an argument array', { skip: !hasGit }, async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-git-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
  const registry = new ToolRegistry();
  const loader = new ExtensionLoader({
    cwd: repo, registry, commands: new CommandRegistry(), bus: new EventBus(),
    submit: () => {}, appendNote: () => {}, ui: { printSystem: () => {}, ask: async () => 'n' }, onWarn: (m) => assert.fail(m),
  });
  assert.equal(await loader.loadFile(path.join(ROOT, 'examples/extensions/git-status.js')), 'git-status');
  const status = registry.getTool('git_status');
  assert.equal(status.readOnly, true);
  assert.match((await status.execute({}, {})).content, /\?\? a\.txt/);
  const commit = registry.getTool('git_commit');
  assert.equal(commit.needsApproval, true);
  const r = await commit.execute({ message: '"; rm -rf / #' }, {});
  assert.equal(r.isError, true, 'nothing staged → git refuses, and the message never became shell syntax');
});

test('the docs exist and match the code', () => {
  for (const f of ['README.md', 'docs/architecture.md', 'docs/extending.md', 'docs/api.md']) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} exists`);
  }
  const extending = fs.readFileSync(path.join(ROOT, 'docs/extending.md'), 'utf8');
  for (const event of ['tool_call_start', 'tool_result', 'agent_end', 'thinking_delta']) assert.ok(extending.includes(event), `extending.md lists ${event}`);
  assert.ok(!/^\|\s*`(tool_call|done|message_update)`\s*\|/m.test(extending), 'no alias appears as an event row');
  const api = fs.readFileSync(path.join(ROOT, 'docs/api.md'), 'utf8');
  return import('../../src/index.js').then((lib) => {
    for (const name of Object.keys(lib)) assert.ok(api.includes(name), `docs/api.md documents ${name}`);
  });
});
