// Course test — Day 4: the toy's bash tool decodes output safely and truncates it honestly.
// Copy into your project as tests/course/day04-toy-bash.test.js, then: node --test tests/course/day04-*
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBash } from '../../toy/bash-tool.mjs';

// runBash spawns a real shell, so these need a POSIX `sh` (macOS, Linux, or WSL on Windows).
const posix = { skip: process.platform === 'win32' ? 'needs a POSIX shell (use WSL)' : false };
const node = `"${process.execPath}"`;

test('a character split across two output chunks arrives whole', posix, async () => {
  // The child writes "h" plus the first byte of "é", waits, then the second byte plus "!".
  const js = 'process.stdout.write(Buffer.from([0x68,0xc3]));setTimeout(()=>process.stdout.write(Buffer.from([0xa9,0x21])),100)';
  const out = await runBash(`${node} -e '${js}'`);
  assert.equal(out, 'hé!', 'out += chunk decodes each chunk on its own; use setEncoding("utf8")');
});

test('long output is cut at 4000 bytes, and the marker suggests nothing the toy cannot do', posix, async () => {
  const out = await runBash(`${node} -e 'process.stdout.write("x".repeat(5000))'`);
  assert.match(out, /\n\.\.\.\[truncated: showing 4000 of 5000 bytes\. .+\]$/);
  assert.doesNotMatch(out, /\bread\b/, 'the toy has no `read` tool, so the hint must not mention one');
});
