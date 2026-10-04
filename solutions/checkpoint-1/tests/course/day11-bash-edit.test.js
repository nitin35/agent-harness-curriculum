// Course test — Day 11: bash (timeout, abort, process lifetime, exit codes, truncation, jailed cwd) and edit.
// The bash tests need a POSIX shell (macOS, Linux, WSL). They are skipped on native Windows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createBashTool, clampTimeout } from '../../src/tools/builtin/bash.js';
import { createEditTool } from '../../src/tools/builtin/edit.js';
import { createBuiltinTools } from '../../src/tools/builtin/index.js';
import { validateArguments } from '../../src/shared/tool-schemas.js';

const posix = process.platform !== 'win32';

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-ws-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Is a process with this pid still alive? */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** The pid a command wrote to `pid` with `echo $! > pid` (the pid of the process it put in the background). */
function readPid(root) {
  return Number(fs.readFileSync(path.join(root, 'pid'), 'utf8'));
}

const settle = () => new Promise((res) => setTimeout(res, 300));

test('bash: success returns stdout, isError false, needs approval', { skip: !posix }, async (t) => {
  const bash = createBashTool({ root: workspace(t) });
  assert.equal(bash.needsApproval, true);
  const r = await bash.execute({ command: 'echo hello' }, {});
  assert.equal(r.isError, false);
  assert.match(r.content, /^hello/);
  assert.equal(r.details.exitCode, 0);
});

test('bash: a failing command is an error RESULT with the exit code and stderr', { skip: !posix }, async (t) => {
  const r = await createBashTool({ root: workspace(t) }).execute({ command: 'echo oops >&2; exit 3' }, {});
  assert.equal(r.isError, true);
  assert.match(r.content, /oops/);
  assert.match(r.content, /exit code 3/);
});

test('bash: timeout kills the command — and its children — promptly', { skip: !posix }, async (t) => {
  const root = workspace(t);
  const pidFile = path.join(root, 'pid');
  const started = Date.now();
  // `$!` is the pid of `sleep` itself, not of the shell: killing only the shell would leave this one running
  const r = await createBashTool({ root }).execute({ command: 'sleep 30 & echo $! > pid; wait', timeout: 500 }, {});
  assert.ok(Date.now() - started < 5_000, 'returned long before 30 s');
  assert.equal(r.isError, true);
  assert.match(r.content, /timed out/);
  const sleeper = Number(fs.readFileSync(pidFile, 'utf8'));
  await settle();
  assert.equal(alive(sleeper), false, 'the sleeping grandchild is gone too');
});

test('bash: an AbortSignal kills the in-flight command', { skip: !posix }, async (t) => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  const started = Date.now();
  const r = await createBashTool({ root: workspace(t) }).execute({ command: 'sleep 30' }, { signal: controller.signal });
  assert.ok(Date.now() - started < 5_000);
  assert.equal(r.isError, true);
  assert.match(r.content, /aborted/);
});

test('bash: huge output keeps the head AND the tail, where errors and summaries are', { skip: !posix }, async (t) => {
  const bash = createBashTool({ root: workspace(t) });
  const r = await bash.execute({ command: 'head -c 100000 /dev/zero | tr "\\0" "a"' }, {});
  assert.match(r.content, /\[truncated: showing the first 16384 and the last 16384 of 100000 bytes\./);
  assert.equal(r.details.truncated, true);
  const lines = await bash.execute({ command: 'seq 1 20000' }, {});
  assert.ok(lines.content.startsWith('1\n2\n3\n'), 'the head is kept');
  assert.ok(lines.content.trimEnd().endsWith('19999\n20000'), 'the tail is kept');
  assert.doesNotMatch(lines.content, /\bread\b/, 'the hint suggests a narrower command, not the read tool');
});

test('bash: a background process holding the output is stopped, and the call returns promptly', { skip: !posix }, async (t) => {
  const root = workspace(t);
  const started = Date.now();
  const r = await createBashTool({ root }).execute({ command: 'sleep 30 & echo $! > pid; echo started' }, {});
  assert.ok(Date.now() - started < 3_000, `returned after ${Date.now() - started} ms, not when sleep would have ended`);
  assert.match(r.content, /started/);
  assert.match(r.content, /^\[NOTE: the background processes .* KILLED/, 'the note comes first, where the model reads it');
  await settle();
  assert.equal(alive(readPid(root)), false, 'nothing a command starts outlives the call');
});

test('bash: a background process that redirected its output is stopped too', { skip: !posix }, async (t) => {
  const root = workspace(t);
  const r = await createBashTool({ root }).execute({ command: 'nohup sleep 30 > /dev/null 2>&1 & echo $! > pid' }, {});
  assert.match(r.content, /KILLED/);
  await settle();
  assert.equal(alive(readPid(root)), false);
});

test('bash: the model cannot switch off the timeout', { skip: !posix }, async (t) => {
  assert.equal(clampTimeout(10 ** 12), 600_000, 'capped');
  assert.equal(clampTimeout(undefined), 120_000, 'missing → default');
  assert.equal(clampTimeout(-5), 120_000, 'nonsense → default');
  // 2^31 ms overflows setTimeout, which would fire after 1 ms and kill the command at once
  const r = await createBashTool({ root: workspace(t) }).execute({ command: 'sleep 0.2; echo done', timeout: 2 ** 31 }, {});
  assert.equal(r.isError, false);
  assert.match(r.content, /done/);
});

test('bash: running commands die with the harness', { skip: !posix }, (t) => {
  const root = workspace(t);
  const bashUrl = new URL('../../src/tools/builtin/bash.js', import.meta.url).href;
  // A harness process starts a long command, then exits mid-command.
  const harness = `const { createBashTool } = await import(${JSON.stringify(bashUrl)});
    createBashTool({ root: ${JSON.stringify(root)} }).execute({ command: 'sleep 30 & echo $! > pid; wait' }, {});
    setTimeout(() => process.exit(0), 400);`;
  spawnSync(process.execPath, ['--input-type=module', '-e', harness], { timeout: 10_000 });
  const sleeper = readPid(root);
  spawnSync('sleep', ['0.3']);
  const survived = alive(sleeper);
  if (survived) process.kill(sleeper);
  assert.equal(survived, false, 'the command was killed when the harness exited');
});

test('bash: cwd is jailed', { skip: !posix }, async (t) => {
  const root = workspace(t);
  fs.mkdirSync(path.join(root, 'sub'));
  const bash = createBashTool({ root });
  const ok = await bash.execute({ command: 'pwd', cwd: 'sub' }, {});
  assert.equal(fs.realpathSync(ok.content.trim()), fs.realpathSync(path.join(root, 'sub')));
  const bad = await bash.execute({ command: 'pwd', cwd: '..' }, {});
  assert.equal(bad.isError, true);
  assert.match(bad.content, /outside/);
});

test('edit: a unique match is replaced and a diff is reported', async (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, 'a.js'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  const edit = createEditTool({ root });
  assert.equal(edit.needsApproval, true);
  const r = await edit.execute({ path: 'a.js', oldString: 'const b = 2;', newString: 'const b = 20;' }, {});
  assert.equal(r.isError, false);
  assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), 'const a = 1;\nconst b = 20;\nconst c = 3;\n');
  assert.match(r.details.diff, /^--- a\/a\.js\n\+\+\+ b\/a\.js\n@@ -2,1 \+2,1 @@\n-const b = 2;\n\+const b = 20;$/);
});

test('edit: two matches → error result naming the count; file unchanged', async (t) => {
  const root = workspace(t);
  const file = path.join(root, 'dup.txt');
  fs.writeFileSync(file, 'x = 1\nx = 1\n');
  const r = await createEditTool({ root }).execute({ path: 'dup.txt', oldString: 'x = 1', newString: 'x = 2' }, {});
  assert.equal(r.isError, true);
  assert.match(r.content, /2 times/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'x = 1\nx = 1\n');
});

test('edit: zero matches, missing file and jail escapes are error results', async (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
  const edit = createEditTool({ root });
  assert.match((await edit.execute({ path: 'a.txt', oldString: 'bye', newString: 'x' }, {})).content, /not found/);
  assert.match((await edit.execute({ path: 'nope.txt', oldString: 'a', newString: 'b' }, {})).content, /not found/i);
  assert.equal((await edit.execute({ path: '../outside.txt', oldString: 'a', newString: 'b' }, {})).isError, true);
});

test('edit: a CRLF file matches an LF oldString and keeps its CRLF line endings', async (t) => {
  const root = workspace(t);
  const file = path.join(root, 'win.js');
  fs.writeFileSync(file, 'const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n');
  const r = await createEditTool({ root }).execute({ path: 'win.js', oldString: 'const a = 1;\nconst b = 2;', newString: 'const a = 10;\nconst b = 20;' }, {});
  assert.equal(r.isError, false, r.content);
  assert.equal(fs.readFileSync(file, 'utf8'), 'const a = 10;\r\nconst b = 20;\r\nconst c = 3;\r\n');
  assert.doesNotMatch(r.details.diff, /\r/, 'the diff the model reads uses plain \\n');
});

test('built-in tools refuse invented arguments', (t) => {
  const tools = createBuiltinTools({ root: workspace(t) });
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['bash', 'edit', 'read', 'write']);
  for (const tool of tools) assert.equal(tool.parameters.additionalProperties, false, tool.name);
  const read = tools.find((tool) => tool.name === 'read');
  assert.match(validateArguments(read.parameters, { path: 'a.txt', output: 'invented' }).error, /unexpected property 'output'/);
});
