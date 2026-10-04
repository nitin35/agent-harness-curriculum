#!/usr/bin/env node
// examples/demo.js — the offline demo (Day 30). No network, no Ollama: a ScriptedProvider plays the model.
// It uses ONLY the public library API (src/index.js) — proof that the harness is a library, not just a CLI.
// Run: node examples/demo.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop, ScriptedProvider, SessionManager, ToolRegistry, createBuiltinTools, EventBus } from '../src/index.js';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-demo-'));
fs.writeFileSync(path.join(ws, 'notes.txt'), 'Release: October\nOwner: Grace\n');

const bus = new EventBus();
bus.on('tool_call_start', ({ name, arguments: a }) => console.log(`  ⚙ ${name} ${JSON.stringify(a)}`));
bus.on('tool_result', ({ content, isError }) => console.log(`  · ${isError ? '✗' : '✓'} ${content.split('\n')[0]}`));

const registry = new ToolRegistry();
for (const tool of createBuiltinTools({ root: ws })) registry.registerTool(tool);

const provider = new ScriptedProvider([
  ScriptedProvider.toolCalls(['read', { path: 'notes.txt' }, 'call_1']),
  (messages) => ScriptedProvider.text(`The notes say: ${messages.at(-1).content.replace(/\n/g, ' · ')}`),
  ScriptedProvider.toolCalls(['edit', { path: 'notes.txt', oldString: 'Owner: Grace', newString: 'Owner: Grace\nStatus: on track' }, 'call_2']),
  ScriptedProvider.text('Added "Status: on track" under the owner.'),
]);

// autoApprove is explicit and safe HERE: a throwaway temp workspace, a scripted model.
const loop = new AgentLoop({ provider, registry, autoApprove: true, emit: (e, p) => bus.emit(e, p) });
const session = SessionManager.create({ cwd: ws, model: provider.model, dir: path.join(ws, '.sessions') });

for (const question of ['What does notes.txt say?', 'Add a status line saying we are on track.']) {
  console.log(`\nyou> ${question}`);
  const result = await loop.run(question, session.getMessages());
  await session.appendMessages(result.newMessages);
  console.log(`agent> ${result.response}`);
}

console.log(`\n--- saved ${session.getEntries().length} entries to ${path.basename(session.path)}; reopening…`);
const resumed = await SessionManager.open(session.path);
for (const m of resumed.getMessages()) {
  const text = m.toolCalls ? `[calls ${m.toolCalls.map((c) => c.name).join(', ')}]` : m.content.split('\n')[0];
  console.log(`  ${m.role.padEnd(11)} ${text}`);
}
console.log(`\nnotes.txt is now:\n${fs.readFileSync(path.join(ws, 'notes.txt'), 'utf8')}`);
fs.rmSync(ws, { recursive: true, force: true });
