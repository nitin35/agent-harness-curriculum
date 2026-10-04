// Course test — Day 10: the workspace jail, read, and write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveInWorkspace, PathEscapeError } from '../../src/tools/workspace-path.js';
import { createReadTool } from '../../src/tools/builtin/read.js';
import { createWriteTool } from '../../src/tools/builtin/write.js';

/** A fresh temp workspace per test; removed afterwards. */
function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-ws-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('jail: relative, nested and absolute-inside paths resolve', (t) => {
  const root = workspace(t);
  assert.equal(resolveInWorkspace(root, 'a.txt'), path.join(root, 'a.txt'));
  assert.equal(resolveInWorkspace(root, 'sub/../b.txt'), path.join(root, 'b.txt'));
  assert.equal(resolveInWorkspace(root, path.join(root, 'c.txt')), path.join(root, 'c.txt'));
  assert.equal(resolveInWorkspace(root, '.'), path.resolve(root));
});

test('jail: escapes, empty and NUL paths are rejected', (t) => {
  const root = workspace(t);
  for (const bad of ['', '   ', 'a\0b', '../etc/passwd', 'sub/../../escape', '/etc/passwd']) {
    assert.throws(() => resolveInWorkspace(root, bad), PathEscapeError, JSON.stringify(bad));
  }
});

test('jail: the startsWith trap — a sibling directory sharing the prefix is outside', (t) => {
  const parent = workspace(t);
  const root = path.join(parent, 'workspace');
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(parent, 'workspace-evil'));
  assert.throws(() => resolveInWorkspace(root, '../workspace-evil/x'), PathEscapeError);
  assert.throws(() => resolveInWorkspace(root, path.join(parent, 'workspace-evil', 'x')), PathEscapeError);
});

test('jail: a symlink inside the workspace that points outside is rejected', (t) => {
  const outside = workspace(t);
  const root = workspace(t);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
  fs.symlinkSync(outside, path.join(root, 'linkdir'));
  assert.throws(() => resolveInWorkspace(root, 'link.txt'), /symlink/);
  assert.throws(() => resolveInWorkspace(root, 'linkdir/new-file.txt'), /symlink/);
});

test('jail: a symlink that stays inside the workspace is fine', (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, 'real.txt'), 'ok');
  fs.symlinkSync(path.join(root, 'real.txt'), path.join(root, 'alias.txt'));
  assert.equal(resolveInWorkspace(root, 'alias.txt'), path.join(root, 'alias.txt'));
});

test('jail: a name that merely starts with two dots is inside the workspace', async (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, '..notes'), 'two dots, still inside');
  assert.equal(resolveInWorkspace(root, '..notes'), path.join(root, '..notes'));
  assert.equal(resolveInWorkspace(root, '..data/config.json'), path.join(root, '..data', 'config.json'));
  const r = await createReadTool({ root }).execute({ path: '..notes' }, {});
  assert.equal(r.isError, false, r.content);
});

test('jail: a DANGLING symlink that points outside is rejected, and write creates nothing there', async (t) => {
  const base = workspace(t);
  const root = path.join(base, 'ws');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  // The link's target doesn't exist yet, so realpath fails on it; writing through it would create the target.
  fs.symlinkSync(path.join(outside, 'planted.txt'), path.join(root, 'notes.txt'));
  assert.throws(() => resolveInWorkspace(root, 'notes.txt'), PathEscapeError);
  const r = await createWriteTool({ root }).execute({ path: 'notes.txt', content: 'x' }, {});
  assert.equal(r.isError, true);
  assert.match(r.content, /symlink/);
  assert.equal(fs.existsSync(path.join(outside, 'planted.txt')), false, 'nothing was created outside the workspace');
});

test('jail: a dangling symlink that points inside is fine, and a symlink loop is an error result', async (t) => {
  const root = workspace(t);
  fs.symlinkSync(path.join(root, 'later.txt'), path.join(root, 'alias.txt'));
  const w = await createWriteTool({ root }).execute({ path: 'alias.txt', content: 'hello' }, {});
  assert.equal(w.isError, false, w.content);
  assert.equal(fs.readFileSync(path.join(root, 'later.txt'), 'utf8'), 'hello');
  fs.symlinkSync(path.join(root, 'b'), path.join(root, 'a'));
  fs.symlinkSync(path.join(root, 'a'), path.join(root, 'b'));
  const r = await createReadTool({ root }).execute({ path: 'a' }, {});
  assert.equal(r.isError, true);
});

test('read: a small file comes back whole', async (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, 'a.txt'), 'line1\nline2\nline3');
  const r = await createReadTool({ root }).execute({ path: 'a.txt' }, {});
  assert.equal(r.isError, false);
  assert.equal(r.content, 'line1\nline2\nline3');
  assert.equal(r.details.totalLines, 3);
  fs.writeFileSync(path.join(root, 'b.txt'), 'line1\nline2\nline3\n');
  const nl = await createReadTool({ root }).execute({ path: 'b.txt' }, {});
  assert.equal(nl.content, 'line1\nline2\nline3\n', 'a whole file comes back exactly, final newline included');
  assert.equal(nl.details.totalLines, 3, 'a final newline ends the last line; it does not add an empty one');
});

test('read: offset/limit returns a window and says so', async (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, 'n.txt'), Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n'));
  const r = await createReadTool({ root }).execute({ path: 'n.txt', offset: 3, limit: 2 }, {});
  assert.match(r.content, /^L3\nL4\n/);
  assert.match(r.content, /showing lines 3-4 of 10/);
  fs.writeFileSync(path.join(root, 'nl.txt'), `${Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n')}\n`);
  const nl = await createReadTool({ root }).execute({ path: 'nl.txt', offset: 3, limit: 2 }, {});
  assert.match(nl.content, /showing lines 3-4 of 10/, 'still 10 lines when the file ends with a newline');
});

test('read: missing, binary, directory and escaping paths are error RESULTS, not throws', async (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  fs.mkdirSync(path.join(root, 'dir'));
  const read = createReadTool({ root });
  for (const [p, re] of [['missing.txt', /not found/i], ['bin.dat', /binary/i], ['dir', /directory/i], ['../x', /outside/i]]) {
    const r = await read.execute({ path: p }, {});
    assert.equal(r.isError, true, p);
    assert.match(r.content, re, p);
  }
});

test('read: a huge file goes through the truncation contract', async (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, 'big.txt'), 'é'.repeat(30_000)); // 60 000 bytes, one line
  const r = await createReadTool({ root }).execute({ path: 'big.txt' }, {});
  assert.equal(r.details.truncated, true);
  assert.ok(r.details.shownBytes <= 32 * 1024);
  assert.match(r.content, /\[truncated: showing \d+ of 60000 bytes/);
  assert.ok(!r.content.includes('�'));
});

test('write: creates parents, reports bytes, needs approval; read sees it', async (t) => {
  const root = workspace(t);
  const write = createWriteTool({ root });
  assert.equal(write.needsApproval, true);
  const r = await write.execute({ path: 'deep/dir/out.txt', content: 'héllo' }, {});
  assert.equal(r.isError, false);
  assert.equal(r.details.byteLength, 6);
  assert.equal(r.details.created, true);
  const back = await createReadTool({ root }).execute({ path: 'deep/dir/out.txt' }, {});
  assert.equal(back.content, 'héllo');
});

test('write: escaping paths are error results and write nothing', async (t) => {
  const root = workspace(t);
  const r = await createWriteTool({ root }).execute({ path: '../evil.txt', content: 'x' }, {});
  assert.equal(r.isError, true);
  assert.equal(fs.existsSync(path.join(path.dirname(root), 'evil.txt')), false);
});
