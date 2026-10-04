// toy/agent.mjs — Day 1: your first agent. An LLM, a loop, and one tool.
// Run: node toy/agent.mjs        (type /quit to leave)
import { spawnSync } from 'node:child_process';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const MODEL = process.env.AH_MODEL ?? 'qwen3.5:4b';
const OLLAMA = 'http://localhost:11434/api/chat';
const MAX_TURNS = 10;

const rl = readline.createInterface({ input, output });

// The tool catalog the model sees. It is only a description — the model cannot run anything itself.
const tools = [{
  type: 'function',
  function: {
    name: 'bash',
    description: 'Run a shell command in the current directory and return its output.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The command to run' } },
      required: ['command'],
    },
  },
}];

async function chat(messages) {
  const res = await fetch(OLLAMA, {
    method: 'POST',
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools,
      stream: false,
      think: false,                 // Day 4 turns thinking on and shows it
      options: { num_ctx: 8192 },   // never trust the server's default window (Day 7)
    }),
  });
  if (!res.ok) throw new Error(`Ollama answered ${res.status}: ${await res.text()}`);
  return (await res.json()).message;
}

// The tool runs in YOUR process — after YOU say yes.
async function runBash(command) {
  const answer = await rl.question(`\n  run \`${command}\`? [y/N] `);
  if (answer.trim().toLowerCase() !== 'y') return 'The user denied this command.';
  const r = spawnSync('sh', ['-c', command], { encoding: 'utf8', timeout: 10_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return out.slice(0, 4000) || `(exit code ${r.status}, no output)`; // Day 4 explains why slice() is wrong here
}

const messages = [{
  role: 'system',
  content: 'You are a helpful assistant running in a terminal. Use the bash tool when you need to look at files or the system.',
}];

console.log(`toy agent on ${MODEL} — type /quit to leave`);
while (true) {
  const line = (await rl.question('\nyou> ')).trim();
  if (line === '/quit') break;
  if (!line) continue;
  messages.push({ role: 'user', content: line });

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const reply = await chat(messages);
    messages.push(reply);                                  // the assistant message, tool calls and all
    if (!reply.tool_calls?.length) {                       // no tools requested: this is the answer
      console.log(`\nagent> ${reply.content}`);
      break;
    }
    for (const call of reply.tool_calls) {                 // run every requested tool, in order
      const result = await runBash(call.function.arguments.command);
      messages.push({ role: 'tool', tool_name: call.function.name, tool_call_id: call.id, content: result });
    }
    if (turn === MAX_TURNS) console.log('\n(agent stopped: too many turns)');
  }
}
rl.close();
