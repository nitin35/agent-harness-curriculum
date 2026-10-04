#!/usr/bin/env node
// examples/evals/run.js — run the eval tasks and print an honest table (Day 29).
//
//   node examples/evals/run.js                          scripted (deterministic): tests YOUR HARNESS — must be 100%
//   node examples/evals/run.js --live --trials 5        the real model: measures the MODEL through your harness
//   node examples/evals/run.js --live --model qwen3.5:9b --only fix-bug
// Results (one JSON line per trial, with the transcript) go to examples/evals/results/, or to --out <dir>
// (the course test uses a temp folder, so running the tests never leaves files behind).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../../src/cli/args-parser.js';
import { DEFAULT_MODEL } from '../../src/shared/constants.js';
import { TASKS } from './tasks.js';
import { runTrial, summarize, formatTable } from './lib.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs(process.argv.slice(2), [
  { name: 'live', long: '--live', type: 'boolean' },
  { name: 'trials', long: '--trials', type: 'string' },
  { name: 'model', long: '--model', type: 'string' },
  { name: 'only', long: '--only', type: 'string' },
  { name: 'k', long: '--k', type: 'string' },
  { name: 'out', long: '--out', type: 'string' },
]);
const live = Boolean(values.live);
const trials = Number(values.trials ?? (live ? 5 : 1));
const k = Number(values.k ?? Math.min(3, trials));
const tasks = values.only ? TASKS.filter((t) => values.only.split(',').includes(t.id)) : TASKS;

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
// Each trial gets fresh settings (its own AGENT_HARNESS_HOME), so without --model the CLI's default model runs.
const model = values.model ?? DEFAULT_MODEL;
const label = live ? model.replace(/[^\w.-]/g, '_') : 'scripted';
const outDir = values.out ? path.resolve(String(values.out)) : path.join(HERE, 'results');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${stamp}_${label}.jsonl`);

console.log(`evals: ${tasks.length} tasks × ${trials} trials · ${live ? `LIVE ${model}` : 'scripted'} · ${outFile}`);
const results = [];
for (const task of tasks) {
  for (let i = 1; i <= trials; i++) {
    const r = runTrial(task, { live, model: values.model });
    results.push(r);
    fs.appendFileSync(outFile, `${JSON.stringify({ ...r, trial: i, kind: task.kind, live })}\n`); // r.model: what really ran
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'} ${task.id} #${i} (${(r.ms / 1000).toFixed(1)} s) — ${r.reason}`);
  }
}
const rows = summarize(results, k);
console.log(`\n${formatTable(rows, k)}`);
const failed = results.filter((r) => !r.pass).length;
if (!live && failed) console.log(`\n${failed} scripted trial(s) failed — that is a HARNESS bug (the script is fixed), not the model.`);
process.exitCode = !live && failed ? 1 : 0;
