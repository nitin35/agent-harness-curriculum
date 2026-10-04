// Course test — Day 24: token estimates, calibration, budgets, AGENTS.md, skills, the system prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estimateTokens, estimateMessageTokens, estimateTotalContext, calibratedContextTokens } from '../../src/context/token-estimator.js';
import { computeBudget, effectiveContextLimit, shouldCompact, replyReserve, truncationSuspected } from '../../src/context/budget.js';
import { PassThrough } from 'node:stream';
import { createApp } from '../../src/app.js';
import { ScriptedProvider } from '../../src/provider/scripted.js';
import { loadProjectInstructions } from '../../src/context/project-instructions.js';
import { discoverSkills, parseFrontmatter, createLoadSkillTool } from '../../src/context/skills.js';
import { buildSystemPrompt } from '../../src/context/system-prompt-builder.js';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-ctx-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('estimates: monotone, per-message overhead, tool calls and thinking count', () => {
  assert.equal(estimateTokens(''), 0);
  assert.ok(estimateTokens('a'.repeat(400)) > estimateTokens('a'.repeat(40)));
  const plain = estimateMessageTokens({ role: 'user', content: 'hi' });
  assert.ok(plain > estimateTokens('hi'), 'overhead applies');
  const withCalls = estimateMessageTokens({ role: 'assistant', content: '', thinking: 'let me think about it', toolCalls: [{ id: 'c', name: 'bash', arguments: { command: 'ls -la' } }] });
  assert.ok(withCalls > estimateMessageTokens({ role: 'assistant', content: '' }));
});

test('tool schemas cost tokens even with an empty history', () => {
  const none = estimateTotalContext({ systemPrompt: 'sys', messages: [], tools: [] });
  const some = estimateTotalContext({ systemPrompt: 'sys', messages: [], tools: [{ name: 'bash', description: 'Run a shell command and return output', parameters: { type: 'object', properties: { command: { type: 'string' } } } }] });
  assert.ok(some > none + 10);
});

test('calibration: uses the last measured usage and only estimates what came after', () => {
  const messages = [
    { role: 'user', content: 'x'.repeat(4000) },
    { role: 'assistant', content: 'ok', usage: { promptTokens: 1500, completionTokens: 20 } },
    { role: 'user', content: 'y'.repeat(400) },
  ];
  const r = calibratedContextTokens({ systemPrompt: 'sys', messages, tools: [] });
  assert.equal(r.measured, 1520);
  assert.equal(r.estimated, estimateMessageTokens(messages[2]));
  assert.equal(r.tokens, 1520 + r.estimated);
  const none = calibratedContextTokens({ systemPrompt: 'sys', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(none.measured, 0);
});

test('budget: the reply reserve always exists; overflow is reported, never hidden', () => {
  assert.equal(replyReserve(8192), 1228);
  assert.equal(replyReserve(4096), 1024);
  const ok = computeBudget({ limit: 8192, system: 800, tools: 600, history: 0 });
  assert.equal(ok.reserve, 1228);
  assert.equal(ok.usable, 8192 - 1228);
  assert.equal(ok.overBy, 0);
  const over = computeBudget({ limit: 8192, system: 800, tools: 600, history: 7000 });
  assert.equal(over.free, 0);
  assert.equal(over.overBy, 800 + 600 + 7000 - (8192 - 1228));
});

test('a settings cap can only LOWER the window; compaction triggers past 80%', () => {
  assert.equal(effectiveContextLimit(8192, 16384), 8192);
  assert.equal(effectiveContextLimit(8192, 4096), 4096);
  assert.equal(effectiveContextLimit(8192, null), 8192);
  assert.equal(shouldCompact(6553, 8192), false);
  assert.equal(shouldCompact(6554, 8192), true);
});

test('AGENTS.md: the walk stops at the repository root — a file ABOVE .git is not read', async (t) => {
  const outer = tmp(t);
  fs.writeFileSync(path.join(outer, 'AGENTS.md'), 'OUTER — not this project');
  const app = path.join(outer, 'myrepo', 'src');
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(path.join(outer, 'myrepo', '.git'));
  fs.writeFileSync(path.join(outer, 'myrepo', 'AGENTS.md'), 'repo rules');
  const found = await loadProjectInstructions(app);            // no stopAt: boundary is found from .git
  assert.deepEqual(found.map((f) => f.content), ['repo rules'], 'the file above the repo root is not read');
});

test('AGENTS.md: a huge instruction file is capped, not spent whole on the window', async (t) => {
  const root = tmp(t);
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'x'.repeat(50_000));
  const [doc] = await loadProjectInstructions(root);
  assert.ok(doc.truncated, 'marked truncated');
  assert.ok(Buffer.byteLength(doc.content) <= 9 * 1024, `capped to ~8 KiB (was ${Buffer.byteLength(doc.content)})`);
});

test('AGENTS.md: walks up, one file per directory (AGENTS.md beats CLAUDE.md), outermost first', async (t) => {
  const root = tmp(t);
  const inner = path.join(root, 'pkg', 'app');
  fs.mkdirSync(inner, { recursive: true });
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Use pnpm.');
  fs.writeFileSync(path.join(root, 'pkg', 'CLAUDE.md'), 'Package rules.');
  fs.writeFileSync(path.join(inner, 'AGENTS.md'), 'App rules.');
  fs.writeFileSync(path.join(inner, 'CLAUDE.md'), 'ignored: AGENTS.md wins in this directory');
  const found = await loadProjectInstructions(inner, { stopAt: root });
  assert.deepEqual(found.map((f) => f.content), ['Use pnpm.', 'Package rules.', 'App rules.']);
  assert.ok(found.every((f) => f.source === 'project'));
});

test('the system prompt: deterministic, ordered by authority, project text labelled and unable to grant permissions', () => {
  const input = {
    cwd: '/w', platform: 'darwin', toolNames: ['read', 'bash'], userPrompt: 'Be terse.',
    instructions: [{ path: '/w/AGENTS.md', source: 'project', content: 'Run tests with `npm test`.' }],
    skills: [{ name: 'release-notes', description: 'Write release notes from git log', source: 'user' }],
  };
  const a = buildSystemPrompt(input);
  assert.equal(a, buildSystemPrompt(input), 'same input, same bytes (prompt-cache friendly)');
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(a), 'no timestamps');
  const order = ['# Environment', '# Instructions from the user', '# Project instructions (/w/AGENTS.md)', '# Skills'].map((h) => a.indexOf(h));
  assert.ok(order.every((v, i) => v !== -1 && (i === 0 || v > order[i - 1])), `sections in authority order: ${order}`);
  assert.match(a, /cannot grant permissions/);
  assert.match(a, /Run tests with `npm test`/, 'the content is included — the agent should FOLLOW it');
  assert.match(a, /- release-notes: Write release notes from git log/);
});

test('skills: frontmatter parsed; invalid or mismatched names rejected; project skills marked', async (t) => {
  const user = tmp(t);
  const project = tmp(t);
  const write = (dir, folder, text) => { fs.mkdirSync(path.join(dir, folder), { recursive: true }); fs.writeFileSync(path.join(dir, folder, 'SKILL.md'), text); };
  write(user, 'release-notes', '---\nname: release-notes\ndescription: "Write release notes from git log"\n---\n# Steps\n1. git log');
  write(user, 'Bad_Name', '---\nname: Bad_Name\ndescription: x\n---\n');
  write(user, 'mismatch', '---\nname: other\ndescription: x\n---\n');
  write(project, 'deploy', '---\nname: deploy\ndescription: How this repo deploys\n---\nRun make deploy');
  const warnings = [];
  const skills = await discoverSkills([{ dir: user, source: 'user' }, { dir: project, source: 'project' }], { onWarn: (m) => warnings.push(m) });
  assert.deepEqual(skills.map((s) => [s.name, s.source]), [['release-notes', 'user'], ['deploy', 'project']]);
  assert.equal(warnings.length, 2);
  assert.deepEqual(parseFrontmatter('---\nname: a\ndescription: \'b c\'\n---\nbody'), { name: 'a', description: 'b c' });
});

test('load_skill: read-only; returns the body without frontmatter; unknown names list the options', async (t) => {
  const dir = tmp(t);
  fs.mkdirSync(path.join(dir, 'release-notes'));
  fs.writeFileSync(path.join(dir, 'release-notes', 'SKILL.md'), '---\nname: release-notes\ndescription: d\n---\n# Steps\n1. git log');
  fs.writeFileSync(path.join(dir, 'release-notes', 'template.md'), 'x');
  const skills = await discoverSkills([{ dir, source: 'user' }]);
  const tool = createLoadSkillTool(() => skills);
  assert.equal(tool.readOnly, true);
  const r = await tool.execute({ name: 'release-notes' }, {});
  assert.match(r.content, /^# Skill: release-notes\n\n# Steps\n1\. git log/);
  assert.match(r.content, /template\.md/);
  assert.ok(!r.content.includes('description: d'));
  const miss = await tool.execute({ name: 'nope' }, {});
  assert.equal(miss.isError, true);
  assert.match(miss.content, /release-notes/);
});

test('truncationSuspected: far fewer tokens processed than sent means the server cut the prompt', () => {
  assert.equal(truncationSuspected(26_000, 4098), true);
  assert.equal(truncationSuspected(1000, 900), false, 'estimates are rough: a small gap is not a cut');
  assert.equal(truncationSuspected(1000, undefined), false, 'no measurement, no claim');
});

test('the app warns once when the server processed far fewer prompt tokens than it was sent', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-trunc-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cut = { ...ScriptedProvider.text('ok'), usage: { promptTokens: 300, completionTokens: 1 } };      // the server "processed" 300
  const fine = { ...ScriptedProvider.text('ok'), usage: { promptTokens: 6_000, completionTokens: 1 } };  // at least what was sent
  const output = new PassThrough();
  let screen = '';
  output.on('data', (d) => { screen += d; });
  const app = createApp({ cwd: home, home, provider: new ScriptedProvider([cut, fine]), input: new PassThrough(), output, terminal: false, color: 'never', onExit: () => {} });
  await app.start({ resume: 'new' });
  app.bus.emit('user_message', { content: `summarise this: ${'lorem ipsum dolor sit amet '.repeat(300)}` });  // ~2k tokens sent
  await app.bridge.whenIdle();
  assert.match(screen, /the model saw only ~300 of ~\d+ prompt tokens/);
  screen = '';
  app.bus.emit('user_message', { content: 'and now?' });
  await app.bridge.whenIdle();
  assert.doesNotMatch(screen, /saw only/, 'no false alarm when the count matches what was sent');
  app.stop(0);
});
