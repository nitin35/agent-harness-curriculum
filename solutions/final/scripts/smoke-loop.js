// scripts/smoke-loop.js — Days 12–13 live smoke: the REAL loop, real tools, real model, YOUR approval.
// Run: node scripts/smoke-loop.js "What files are in this directory? Use the bash tool."
// Ctrl+C aborts the run; you get a structured result back, not a stack trace.
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { AgentLoop } from '../src/agent/agent-loop.js';
import { OllamaProvider } from '../src/provider/ollama.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { createBuiltinTools } from '../src/tools/builtin/index.js';

const question = process.argv[2] ?? 'What files are in this directory? Use the bash tool.';
const registry = new ToolRegistry();
for (const tool of createBuiltinTools({ root: process.cwd() })) registry.registerTool(tool);

const rl = readline.createInterface({ input, output });
const controller = new AbortController();
rl.on('SIGINT', () => controller.abort());

const loop = new AgentLoop({
  provider: new OllamaProvider(),
  registry,
  // The minimal approval gate: a y/N question. Day 20 replaces it with the real gate.
  approve: async (call) => {
    const answer = await rl.question(`  allow ${call.name} ${JSON.stringify(call.arguments)}? [y/N] `, { signal: controller.signal }).catch(() => 'n');
    return answer.trim().toLowerCase() === 'y';
  },
  emit: (event, payload) => {
    if (event === 'tool_call_start') console.log(`  → ${payload.name} ${JSON.stringify(payload.arguments)}`);
    if (event === 'tool_result') console.log(`  ← ${payload.isError ? 'ERROR ' : ''}${payload.content.split('\n')[0].slice(0, 100)}`);
  },
});

const result = await loop.run(question, [], { signal: controller.signal });
console.log(`\nanswer (${result.turns} turns, aborted=${result.aborted}):\n${result.response}`);
rl.close();
