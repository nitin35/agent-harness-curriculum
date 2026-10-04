// scripts/interrupt-experiment.js — Day 15 stretch: does the model know you stopped it?
// Run: node scripts/interrupt-experiment.js [trials]   (about 2 minutes with the default 8 trials)
// History: you asked for a bash command, then pressed Ctrl+C at the approval question. Now you ask
// something unrelated. How often does the model go back to the cancelled task, with and without the note?
import { OllamaProvider } from '../src/provider/ollama.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { createBuiltinTools } from '../src/tools/builtin/index.js';
import { DEFAULT_SYSTEM_PROMPT } from '../src/agent/agent-loop.js';
import { INTERRUPTED_NOTE } from '../src/bridge.js';

const registry = new ToolRegistry();
for (const tool of createBuiltinTools({ root: process.cwd() })) registry.registerTool(tool);
const tools = registry.toProviderTools();
const provider = new OllamaProvider();

/** @typedef {import('../src/shared/message-schemas.js').AgentMessage} AgentMessage */
/** @type {AgentMessage[]} */
const cancelled = [
  { role: 'system', content: DEFAULT_SYSTEM_PROMPT },
  { role: 'user', content: 'How many files are in the toy folder? Use bash.' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'bash', arguments: { command: 'find ./toy -type f | wc -l' } }] },
  { role: 'tool_result', toolCallId: 'call_1', toolName: 'bash', content: 'User denied bash', isError: true },
];
/** @type {Record<string, AgentMessage[]>} */
const variants = {
  'no note': cancelled,
  'with note': [...cancelled, { role: 'user', content: INTERRUPTED_NOTE }],
};

const trials = Number(process.argv[2] ?? 8);
console.log(`model ${provider.model}, ${trials} trials each. "Went back" = called a tool, or didn't answer 4.`);
for (const [name, history] of Object.entries(variants)) {
  let wentBack = 0;
  for (let i = 0; i < trials; i++) {
    const reply = await provider.chat([...history, { role: 'user', content: 'What is 2+2? Reply with just the digit.' }], tools);
    if (reply.toolCalls.length || !/4/.test(reply.content)) wentBack++;
  }
  console.log(`${name.padEnd(10)} went back to the cancelled task ${wentBack}/${trials}`);
}
