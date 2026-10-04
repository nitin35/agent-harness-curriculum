// examples/evals/lib.js — run tasks against the harness and score them honestly (Day 29).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultEnv } from '../../src/mcp/mcp-client.js';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MAIN = path.resolve(HERE, '../../src/cli/main.js');
export const FIXTURE = path.join(HERE, 'fixture-repo');

/** n choose k (as a float; fine for the small numbers evals use). */
function choose(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/**
 * pass@k: the probability that AT LEAST ONE of k attempts passes, estimated from n trials with c passes
 * (the unbiased estimator from the HumanEval paper: 1 − C(n−c, k) / C(n, k)). "Can it ever do this?"
 */
export function passAtK(n, c, k) {
  if (k > n) throw new RangeError('k must be ≤ n');
  return n - c < k ? 1 : 1 - choose(n - c, k) / choose(n, k);
}

/**
 * pass^k: the probability that ALL k attempts pass (C(c, k) / C(n, k)). "Can I rely on it?" —
 * the number that matters for an agent you leave alone.
 */
export function passHatK(n, c, k) {
  if (k > n) throw new RangeError('k must be ≤ n');
  return choose(c, k) / choose(n, k);
}

/**
 * The trial's environment: a safe baseline (PATH, LANG, …) instead of your whole environment, so the
 * model's commands find no API keys or tokens, and HOME pointed at the trial's own folder, so `~` is
 * scratch space, not your home. This shrinks the blast radius of --auto-approve. It is NOT a sandbox:
 * `bash` can still reach anything your user can (Day 27). Run live evals of models or tasks you don't
 * trust in a container or VM.
 * @param {string} home  the trial's own folder
 * @param {Record<string, string|undefined>} [base]
 */
export function trialEnv(home, base = process.env) {
  return { ...defaultEnv(base), HOME: home, AGENT_HARNESS_HOME: home, NO_COLOR: '1' };
}

/**
 * Run ONE trial of a task: fresh temp copy of the fixture, the real CLI in -p mode, then the checker.
 * --auto-approve is used deliberately (nobody is there to approve), which is why the trial gets its own
 * HOME and a minimal environment (trialEnv). The copy protects the fixture, not your machine.
 * @param {{ id: string, prompt: string, check: Function, autoApprove?: boolean }} task
 * @param {{ live?: boolean, model?: string, scriptsDir?: string, timeoutMs?: number, keepDir?: boolean }} opts
 */
export function runTrial(task, { live = false, model, scriptsDir = path.join(HERE, 'scripts'), timeoutMs = 180_000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `eval-${task.id}-`));
  const home = path.join(dir, '.home');
  const ws = path.join(dir, 'ws');
  fs.cpSync(FIXTURE, ws, { recursive: true });
  const args = ['-p', ...(task.autoApprove === false ? [] : ['--auto-approve'])];
  if (live) { if (model) args.push('--model', model); }
  else args.push('--provider', 'scripted', '--script', path.join(scriptsDir, `${task.id}.json`));
  args.push(task.prompt);
  const started = Date.now();
  const r = spawnSync(process.execPath, [MAIN, ...args], { cwd: ws, env: trialEnv(home), encoding: 'utf8', input: '', timeout: timeoutMs });
  const ms = Date.now() - started;
  let verdict;
  try {
    verdict = r.status === 0 || r.status === 4 ? task.check({ ws, stdout: r.stdout, stderr: r.stderr }) : { pass: false, reason: `exit ${r.status}: ${(r.stderr || '').trim().split('\n').at(-1)}` };
  } catch (err) {
    verdict = { pass: false, reason: `checker threw: ${err.message}` };
  }
  const transcript = readTranscript(home);
  fs.rmSync(dir, { recursive: true, force: true });
  // The model that actually ran, from the session header: the record must say, even without --model.
  const ranModel = transcript.find((rec) => rec.type === 'header')?.model ?? null;
  return { task: task.id, pass: Boolean(verdict.pass), reason: verdict.reason ?? '', ms, model: ranModel, stdout: r.stdout, stderr: r.stderr, transcript };
}

function readTranscript(home) {
  const dir = path.join(home, 'sessions');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
}

/** Per-task summary rows. */
export function summarize(results, k) {
  const byTask = new Map();
  for (const r of results) {
    const row = byTask.get(r.task) ?? { task: r.task, n: 0, c: 0, ms: 0 };
    row.n++; row.c += r.pass ? 1 : 0; row.ms += r.ms;
    byTask.set(r.task, row);
  }
  return [...byTask.values()].map((row) => ({
    ...row,
    passAt1: passAtK(row.n, row.c, 1),
    passAtK: passAtK(row.n, row.c, Math.min(k, row.n)),
    passHatK: passHatK(row.n, row.c, Math.min(k, row.n)),
    avgMs: Math.round(row.ms / row.n),
  }));
}

export function formatTable(rows, k) {
  const pct = (x) => `${Math.round(x * 100)}%`.padStart(5);
  const lines = [`${'task'.padEnd(18)} ${'passed'.padStart(7)} ${'pass@1'.padStart(7)} ${`pass@${k}`.padStart(7)} ${`pass^${k}`.padStart(7)} ${'avg s'.padStart(6)}`];
  for (const r of rows) lines.push(`${r.task.padEnd(18)} ${`${r.c}/${r.n}`.padStart(7)} ${pct(r.passAt1).padStart(7)} ${pct(r.passAtK).padStart(7)} ${pct(r.passHatK).padStart(7)} ${(r.avgMs / 1000).toFixed(1).padStart(6)}`);
  return lines.join('\n');
}
