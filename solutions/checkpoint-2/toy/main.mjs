// toy/main.mjs — the toy agent's REPL (Days 2–5; the real bash tool, Day 11). Run: node toy/main.mjs [--model <name>] [--num-ctx <tokens>]
// Ctrl+C during an answer or at a [y/N] question aborts the run; Ctrl+C at the prompt (or /quit) exits.
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { createOllamaClient } from './ollama.mjs';
import { runTurns } from './loop.mjs';
import { parseArgs, getUsage, UsageError } from '../src/cli/args-parser.js';
import { ValidationError } from '../src/shared/errors.js';
import { createBashTool } from '../src/tools/builtin/bash.js';

// Day 5: the toy is the first user of the real CLI parser.
/** @type {import('../src/cli/args-parser.js').FlagDef[]} */
const FLAGS = [
  { name: 'model', long: '--model', type: 'string', valueName: 'name', description: 'Model to use (default: $AH_MODEL or qwen3.5:4b)' },
  { name: 'numCtx', long: '--num-ctx', type: 'string', valueName: 'tokens', description: 'Context window to ask Ollama for (default: 8192)' },
  { name: 'help', short: '-h', long: '--help', type: 'boolean', description: 'Show this help' },
];
const USAGE = getUsage(FLAGS, { name: 'node toy/main.mjs' });

/** argv → options. Throws UsageError / ValidationError (category 'user') for bad input. */
function readOptions(argv) {
  const { values, positionals } = parseArgs(argv, FLAGS);
  if (positionals.length) throw new UsageError(`Unexpected argument: ${positionals[0]}`, { token: positionals[0] });
  const numCtx = Number(values.numCtx ?? 8192);
  if (!Number.isInteger(numCtx) || numCtx < 1024) {
    throw new ValidationError(`--num-ctx must be a whole number of at least 1024, got "${values.numCtx}"`, { field: 'num-ctx' });
  }
  const model = /** @type {string | undefined} */ (values.model) ?? process.env.AH_MODEL ?? 'qwen3.5:4b';
  return { help: values.help === true, model, numCtx };
}

let options;
try {
  options = readOptions(process.argv.slice(2));
} catch (err) {
  if (err.category !== 'user') throw err; // route on the category, never on the message text
  console.error(`${err.message}\n\n${USAGE}`);
  process.exit(2);
}
if (options.help) {
  console.log(USAGE);
  process.exit(0);
}

const DIM = '\x1b[2m', RESET = '\x1b[0m';
const client = createOllamaClient({ model: options.model, numCtx: options.numCtx });
const rl = readline.createInterface({ input, output });
const messages = [{
  role: 'system',
  content: 'You are a helpful assistant running in a terminal. Use the bash tool when you need to look at files or the system.',
}];

let controller = null; // non-null while a run is in flight
rl.on('SIGINT', () => {
  if (controller) { controller.abort(); output.write('\n(aborting…)\n'); }
  else { rl.close(); process.exit(130); }
});

/**
 * Passing the signal means Ctrl+C also cancels an open [y/N] question: it rejects with an AbortError.
 * @param {string} command
 * @param {{ signal?: AbortSignal }} [opts]
 */
const confirm = async (command, { signal } = {}) =>
  (await rl.question(`\n  run \`${command}\`? [y/N] `, { signal })).trim().toLowerCase() === 'y';

// Day 11: the toy's hands are now the real bash tool (process-group kill, capped timeout, head + tail output),
// plugged in through the runTool seam from Day 2. Approval stays with the toy's own confirm: the loop asks, the tool runs.
const bash = createBashTool({ root: process.cwd() });
/** @param {string} command @param {{ signal?: AbortSignal }} [opts] */
const runTool = async (command, { signal } = {}) => {
  const result = await bash.execute({ command }, { signal });
  return typeof result === 'string' ? result : result.content; // a tool may return a plain string (Day 9)
};

console.log(`toy agent on ${client.model} — Ctrl+C stops an answer, /quit leaves`);
while (true) {
  const line = (await rl.question('\nyou> ')).trim();
  if (line === '/quit') break;
  if (!line) continue;
  messages.push({ role: 'user', content: line });

  controller = new AbortController();
  let thinking = false;
  output.write('\nagent> ');
  const result = await runTurns({
    client, messages, confirm, runTool, signal: controller.signal,
    onThinking: (s) => { if (!thinking) { thinking = true; output.write(DIM); } output.write(s); },
    onText: (s) => { if (thinking) { thinking = false; output.write(`${RESET}\n`); } output.write(s); },
  });
  output.write(RESET);
  if (result.aborted) output.write('\n(aborted)');
  controller = null;
}
rl.close();
