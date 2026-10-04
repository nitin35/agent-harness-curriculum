// Course test — Day 29: eval maths and the scripted eval run (which tests YOUR HARNESS, deterministically).
// Needs examples/evals/ (lib.js, tasks.js, run.js, scripts/, fixture-repo/ from course-assets/eval-fixture-repo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { passAtK, passHatK, summarize, runTrial, trialEnv } from '../../examples/evals/lib.js';
import { TASKS } from '../../examples/evals/tasks.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('pass@k: "at least one of k passes" — unbiased estimate from n trials with c passes', () => {
  assert.equal(passAtK(5, 0, 1), 0);
  assert.equal(passAtK(5, 5, 1), 1);
  assert.equal(passAtK(5, 2, 1), 0.4);
  assert.ok(Math.abs(passAtK(5, 2, 3) - 0.9) < 1e-9, '1 − C(3,3)/C(5,3) = 1 − 1/10');
  assert.equal(passAtK(5, 2, 4), 1, 'with only 3 failures, any 4 picks include a pass');
  assert.throws(() => passAtK(3, 1, 4), RangeError);
});

test('pass^k: "all k pass" — the reliability number for an agent you leave alone', () => {
  assert.equal(passHatK(5, 5, 3), 1);
  assert.equal(passHatK(5, 2, 3), 0);
  assert.ok(Math.abs(passHatK(5, 4, 2) - 0.6) < 1e-9, 'C(4,2)/C(5,2) = 6/10');
  assert.ok(passHatK(10, 9, 5) < passAtK(10, 9, 1), 'reliability over 5 runs is lower than one-shot success');
});

test('summarize: per-task rows with n, c, pass@1, pass@k, pass^k', () => {
  const rows = summarize([
    { task: 'a', pass: true, ms: 100 }, { task: 'a', pass: false, ms: 300 },
    { task: 'b', pass: true, ms: 50 },
  ], 2);
  assert.deepEqual(rows.map((r) => [r.task, r.n, r.c, r.passAt1, r.avgMs]), [['a', 2, 1, 0.5, 200], ['b', 1, 1, 1, 50]]);
  assert.equal(rows[0].passAtK, 1);
  assert.equal(rows[0].passHatK, 0);
});

test('every task has an id, a prompt and a checker; at least one safety task', () => {
  assert.ok(TASKS.length >= 4);
  for (const t of TASKS) {
    assert.match(t.id, /^[a-z0-9-]+$/);
    assert.equal(typeof t.prompt, 'string');
    assert.equal(typeof t.check, 'function');
  }
  assert.ok(TASKS.some((t) => t.kind === 'safety'));
});

test('one scripted trial: fresh copy, real CLI, checker on the RESULT, transcript captured', () => {
  const task = TASKS.find((t) => t.id === 'fix-bug');
  const r = runTrial(task);
  assert.equal(r.pass, true, r.reason);
  assert.ok(r.transcript.some((rec) => rec.type === 'message' && rec.message.role === 'tool_result'), 'the transcript was captured');
  assert.equal(r.model, r.transcript.find((rec) => rec.type === 'header').model, 'the record names the model that actually ran');
  assert.equal(typeof r.model, 'string');
});

test('the scripted suite is 100% green (any failure is a harness bug) and exits 0', (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-evals-'));   // results go here, not into your project
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'examples/evals/run.js'), '--trials', '1', '--out', out], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const t of TASKS) assert.match(r.stdout, new RegExp(`${t.id}\\s+1/1`));
  assert.equal(fs.readdirSync(out).length, 1, 'one results file, in the folder we chose');
});

test('trialEnv: a trial gets its own HOME and a minimal environment — no API keys for the model to find', () => {
  const env = trialEnv('/tmp/eval-x/.home', { PATH: '/usr/bin', HOME: '/Users/you', LANG: 'en_US.UTF-8', OPENAI_API_KEY: 'sk-secret', GITHUB_TOKEN: 'ghp_x' });
  assert.equal(env.HOME, '/tmp/eval-x/.home', '~ is the trial folder, not your home');
  assert.equal(env.AGENT_HARNESS_HOME, '/tmp/eval-x/.home');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
});
