// scripts/smoke-provider.js — Day 8 live smoke against a running Ollama. Run: node scripts/smoke-provider.js
// Another model: AH_MODEL=llama3.2:1b node scripts/smoke-provider.js
// Asserts STRUCTURE, never model phrasing: a local model's words vary; its JSON shape does not.
import assert from 'node:assert/strict';
import { OllamaProvider } from '../src/provider/ollama.js';
import { ProviderError } from '../src/shared/errors.js';

const provider = new OllamaProvider({ model: process.env.AH_MODEL }); // undefined → the course model
const bash = {
  name: 'bash',
  description: 'Run a shell command and return stdout and stderr',
  parameters: { type: 'object', properties: { command: { type: 'string', description: 'The command to run' } }, required: ['command'] },
};

// 1. plain chat
const plain = await provider.chat([{ role: 'user', content: 'What is 2+2? Answer with one word.' }], []);
assert.ok(typeof plain.content === 'string' && plain.content.length > 0, 'non-empty content');
assert.ok(plain.finishReason, 'finishReason present');
console.log('✔ plain chat:', JSON.stringify(plain.content), `(${plain.usage?.promptTokens} prompt tokens)`);

// 2. forced tool call — small local models sometimes answer in prose instead; retry once and SAY so
let tooly;
for (let attempt = 1; attempt <= 2; attempt++) {
  tooly = await provider.chat([{ role: 'user', content: 'What files are in /tmp? Use the bash tool.' }], [bash]);
  if (tooly.toolCalls.length) break;
  console.log(`  (attempt ${attempt}: no tool call — the model answered in prose: ${JSON.stringify(tooly.content.slice(0, 80))})`);
}
assert.ok(tooly.toolCalls.length > 0, 'the model requested a tool (2 attempts)');
const [call] = tooly.toolCalls;
assert.equal(call.name, 'bash');
assert.ok(call.id, 'every call has an id');
assert.equal(typeof call.arguments, 'object', 'arguments is a plain object');
console.log('✔ tool call:', call.id, call.name, JSON.stringify(call.arguments));

// 3. model info — the window we will REALLY get
const info = await provider.getModelInfo();
console.log(`✔ model info: max ${info.maxContext}, using ${info.contextLimit}, capabilities ${info.capabilities.join(',')}`);

// 4. wrong model → actionable message
await assert.rejects(
  new OllamaProvider({ model: 'definitely-not-a-model' }).chat([{ role: 'user', content: 'hi' }], []),
  (err) => err instanceof ProviderError && /ollama pull/.test(err.message),
);
console.log('✔ wrong model → "ollama pull" hint');

// 5. abort reaches fetch
const controller = new AbortController();
setTimeout(() => controller.abort(), 50);
await assert.rejects(provider.chat([{ role: 'user', content: 'Write a long poem.' }], [], { signal: controller.signal }), { name: 'AbortError' });
console.log('✔ abort → AbortError');
