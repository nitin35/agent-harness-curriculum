// scripts/trace.js — Day 14: print every canonical event of one live run.
// Run: node scripts/trace.js "How many files are in toy/?"
// Tools that need approval ask you y/N (Day 3's rl.question). No pattern decides that a command is safe:
// `ls; rm -rf ~` starts with ls, and `find . -delete` is a find. Rules that pre-approve commands are Day 20's job.
import * as readline from 'node:readline/promises';
import { AgentLoop } from '../src/agent/agent-loop.js';
import { EventBus } from '../src/events/event-bus.js';
import { OllamaProvider } from '../src/provider/ollama.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { createBuiltinTools } from '../src/tools/builtin/index.js';
import { ALL_EVENTS } from '../src/shared/events.js';
import { checkTrace } from '../tests/helpers/event-protocol.js';

const bus = new EventBus();
const names = []; // every event, in order, for the Day 6 protocol check
for (const name of ALL_EVENTS) {
  bus.on(name, (payload) => {
    names.push(name);
    if (name.endsWith('_delta')) return; // too chatty for a trace
    const json = JSON.stringify(payload);
    console.log(`${name.padEnd(16)} ${json.length > 140 ? `${json.slice(0, 139)}…` : json}`);
  });
}

const registry = new ToolRegistry();
for (const tool of createBuiltinTools({ root: process.cwd() })) registry.registerTool(tool);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const loop = new AgentLoop({
  provider: new OllamaProvider(),
  registry,
  emit: (e, p) => bus.emit(e, p),
  approve: async (call, tool, { signal }) =>
    (await rl.question(`  allow ${call.name} ${JSON.stringify(call.arguments)}? [y/N] `, { signal })).trim().toLowerCase() === 'y',
});
try {
  await loop.run(process.argv[2] ?? 'How many files are in toy/? Use bash.');
} finally {
  rl.close();
}

const check = checkTrace(names);
console.log(check.ok ? '✔ the trace follows the Day 6 event protocol' : `✖ protocol violation: ${check.error}`);
