#!/usr/bin/env node
// src/cli/main.js — the agent-harness command (Day 15 → Day 26).
//
// Exit codes: 0 ok · 1 runtime error · 2 usage/settings error · 3 no final answer (maxTurns ran out)
//             · 4 answered, but tool calls were denied · 130 interrupted (Ctrl+C)
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, getUsage, UsageError } from './args-parser.js';
import { createApp } from '../app.js';
import { createProvider } from '../provider/index.js';
import { loadSettings, saveGlobalSetting } from '../config/settings.js';
import { createLogger } from '../config/logger.js';
import { formatError, installErrorHandler } from '../config/error-handler.js';
import { configDir, globalPaths } from '../config/paths.js';
import { HarnessError } from '../shared/errors.js';
import { killAllCommands } from '../tools/builtin/bash.js';
import { sanitizeForTerminal } from '../ui/printer.js';

/** @type {import('./args-parser.js').FlagDef[]} */
export const FLAGS = [
  { name: 'print', short: '-p', long: '--print', type: 'boolean', description: 'One-shot: answer the prompt on stdout and exit (tools needing approval are DENIED unless --auto-approve or an allow rule)' },
  { name: 'continue', short: '-c', long: '--continue', type: 'boolean', description: 'Continue the most recent session in this folder' },
  { name: 'resume', long: '--resume', type: 'boolean', description: "Pick one of this folder's sessions to resume" },
  { name: 'new', long: '--new', type: 'boolean', description: 'Start a fresh session without asking' },
  { name: 'model', long: '--model', type: 'string', valueName: 'name', description: 'Model to use' },
  { name: 'provider', long: '--provider', type: 'string', valueName: 'name', description: 'ollama | openai-compatible | scripted' },
  { name: 'script', long: '--script', type: 'string', valueName: 'file', description: 'Script file for --provider scripted (tests, evals, demo)' },
  { name: 'system-prompt', long: '--system-prompt', type: 'string', valueName: 'text', description: 'Extra instructions for this run' },
  { name: 'extension', long: '--extension', type: 'string', repeatable: true, valueName: 'file', description: 'Load an extension file' },
  { name: 'allow-project-extensions', long: '--allow-project-extensions', type: 'boolean', description: 'Load .agent-harness/extensions without the trust prompt (CI)' },
  { name: 'permission-mode', long: '--permission-mode', type: 'string', valueName: 'mode', description: 'default | read-only | accept-edits | yolo' },
  { name: 'auto-approve', long: '--auto-approve', type: 'boolean', description: 'Same as --permission-mode yolo (deny rules still apply)' },
  { name: 'no-tools', long: '--no-tools', type: 'boolean', description: 'Disable all tools' },
  { name: 'tools', long: '--tools', type: 'string', valueName: 'a,b', description: 'Enable only these tools' },
  { name: 'verbose', short: '-V', long: '--verbose', type: 'boolean', description: 'Debug logging (to the log file)' },
  { name: 'help', short: '-h', long: '--help', type: 'boolean', description: 'Show this help' },
  { name: 'version', short: '-v', long: '--version', type: 'boolean', description: 'Print the version' },
];

const USAGE_INFO = { name: 'agent-harness', usage: 'agent-harness [options] [prompt]', description: 'A terminal coding agent you built in 30 days.' };

export function usage() { return getUsage(FLAGS, USAGE_INFO); }

export function version() {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8'));
  return pkg.version;
}

/**
 * @param {string[]} argv
 * @param {{ env?: Record<string,string|undefined>, cwd?: string, stdin?: NodeJS.ReadableStream & { isTTY?: boolean },
 *           stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream }} [io]
 * @returns {Promise<number|undefined>} an exit code (print mode, errors) — undefined while interactive mode keeps running
 */
export async function main(argv = process.argv.slice(2), { env = process.env, cwd = process.cwd(), stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs(argv, FLAGS));
  } catch (err) {
    if (err instanceof UsageError) { stderr.write(`${err.message}\n\n${usage()}\n`); return 2; }
    throw err;
  }
  if (values.help) { stdout.write(`${usage()}\n`); return 0; }
  if (values.version) { stdout.write(`${version()}\n`); return 0; }

  const home = configDir(env);
  const logFile = path.join(globalPaths(home).logs, 'harness.log');
  const logger = createLogger({ file: logFile, level: values.verbose ? 'debug' : 'info' });
  const log = logger.child('cli');

  let settings;
  try {
    ({ settings } = loadSettings({ cwd, home, flags: values, onWarn: (m) => { stderr.write(`warning: ${sanitizeForTerminal(m)}\n`); log.warn(m); } }));
  } catch (err) {
    stderr.write(`${formatError(err, { logFile })}\n`);
    return err instanceof HarnessError && err.category === 'user' ? 2 : 1;
  }

  let provider;
  try {
    provider = createProvider({
      provider: settings.provider, model: settings.defaultModel, contextWindow: settings.contextWindow, think: settings.think,
      ollamaUrl: settings.ollamaUrl, openai: settings.openai, scriptFile: /** @type {string|undefined} */ (values.script), env,
    });
  } catch (err) {
    stderr.write(`${sanitizeForTerminal(err.message)}\n`);
    return 2;
  }

  const print = Boolean(values.print);
  const common = {
    cwd, provider, home, logger,
    streaming: print ? false : settings.streaming,
    maxTurns: settings.maxTurns,
    enabledTools: settings.tools.enabled,
    permissions: settings.permissions,
    mcpServers: settings.mcpServers,
    systemPrompt: settings.systemPrompt,
    contextLimitCap: settings.compaction.contextLimit,
    compaction: { enabled: settings.compaction.enabled, keepMessages: settings.compaction.keepMessages },
    extensions: { files: /** @type {string[]} */ (values.extension ?? []), allowProjectExtensions: Boolean(values['allow-project-extensions']) },
    persistModel: (name) => saveGlobalSetting('defaultModel', name, { home }),
  };
  log.info(`start ${print ? 'print' : 'interactive'} provider=${settings.provider} model=${settings.defaultModel} mode=${settings.permissions.mode}`);

  if (print) return runPrint({ common, values, positionals, stdin, stdout, stderr, log, logFile });

  // ---- interactive ----
  let done = false;
  let uninstall = () => {};
  const shutdown = (code) => {
    if (done) return;
    done = true;
    uninstall();
    log.info(`exit ${code}`);
    process.exitCode = code; // never process.exit(): let stdout drain and the event loop empty on its own
  };
  const app = createApp({ ...common, interactive: true, onExit: shutdown });
  uninstall = installErrorHandler({ logger: log, logFile, shutdown: (code) => { app.stop(code); shutdown(code); }, stderr });
  const resume = values.continue ? 'last' : values.new ? 'new' : values.resume ? 'pick' : 'ask';
  await app.start({ resume });
  return undefined;
}

async function runPrint({ common, values, positionals, stdin, stdout, stderr, log, logFile }) {
  let prompt = positionals.join(' ').trim();
  if (!prompt && !stdin.isTTY) prompt = (await readAll(stdin)).trim(); // `echo "question" | agent-harness -p`
  if (!prompt) { stderr.write(`-p needs a prompt\n\n${usage()}\n`); return 2; }

  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);
  // stdout carries ONLY the answer; everything else (tool lines, warnings) goes to stderr
  const app = createApp({ ...common, interactive: false, input: Readable.from([]), output: stderr, terminal: false, color: 'never', onExit: () => {} });
  try {
    const result = await app.runOnce(prompt, { resume: values.continue ? 'last' : 'new', signal: controller.signal });
    if (result.aborted) { stderr.write('aborted\n'); return 130; }
    // A pipe gets the exact bytes (a script may need them); a terminal gets them sanitized (Day 27).
    stdout.write(`${stdout.isTTY ? sanitizeForTerminal(result.response) : result.response}\n`);
    // maxTurns ran out: stdout holds no final answer, and a script or CI job must be able to tell.
    if (result.warning) { stderr.write(`warning: ${result.warning}\n`); return 3; }
    // Tool calls were refused (nobody could approve them). The answer can't reflect what they would have
    // done — and a model sometimes answers as if a denied command ran. Say so, and exit 4 so CI can tell.
    const denied = result.toolCalls.filter((c) => c.denied);
    if (denied.length) {
      // Say WHY, from the log's fields: nobody could answer (non-interactive), or your rules or mode refused.
      const unanswered = denied.filter((c) => c.unanswered).length;
      const refused = denied.length - unanswered;
      const why = [unanswered && 'nobody could approve', refused && 'refused by your rules or mode'].filter(Boolean).join('; ');
      const advice = [
        unanswered && 'Allow tools (--auto-approve or an allow rule), or rule them out with --no-tools.',
        refused && `Change the deny rule or the permission mode if ${refused > 1 ? 'they' : 'it'} should run.`,
      ].filter(Boolean).join(' ');
      const n = denied.length;
      stderr.write(`warning: ${n} tool call${n > 1 ? 's were' : ' was'} denied (${why}); the answer can't reflect what ${n > 1 ? 'they' : 'it'} would have done. ${advice}\n`);
      return 4;
    }
    return 0;
  } catch (err) {
    log.error(err);
    stderr.write(`${formatError(err, { logFile })}\n`);
    return 1;
  } finally {
    process.off('SIGINT', onSigint);
    app.stop(0);
  }
}

async function readAll(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

// Run when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  // SIGTERM (`kill`, a process supervisor) and SIGHUP (a closed terminal) end Node without an 'exit' event
  // unless someone handles them. Handle them, so commands the bash tool started die with us (Day 11).
  /** @type {Array<[NodeJS.Signals, number]>} */
  const fatalSignals = [['SIGTERM', 143], ['SIGHUP', 129]];
  for (const [signal, code] of fatalSignals) {
    process.once(signal, () => { killAllCommands(); process.exit(code); });
  }
  const code = await main();
  if (code !== undefined) process.exitCode = code;
}
