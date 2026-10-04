// Course test — Day 4: the byte-safe truncation contract (README "Tool output truncation contract").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncateText } from '../../src/tools/truncate.js';

const MARKER = /\n\.\.\.\[truncated: showing (\d+) of (\d+) bytes\. Use read with offset\/limit or a narrower command to see more\.\]$/;

test('short text passes through untouched', () => {
  assert.deepEqual(truncateText('hello', 100), { content: 'hello', truncated: false, byteLength: 5, shownBytes: 5 });
});

test('text exactly at the cap is not truncated', () => {
  const r = truncateText('a'.repeat(64), 64);
  assert.equal(r.truncated, false);
  assert.equal(r.shownBytes, 64);
});

test('ASCII over the cap: exact prefix plus the contract marker', () => {
  const text = 'x'.repeat(100);
  const r = truncateText(text, 40);
  assert.equal(r.truncated, true);
  assert.equal(r.byteLength, 100);
  assert.equal(r.shownBytes, 40);
  const m = r.content.match(MARKER);
  assert.ok(m, `marker missing in: ${r.content.slice(-140)}`);
  assert.equal(Number(m[1]), 40);
  assert.equal(Number(m[2]), 100);
  assert.equal(r.content.slice(0, m.index), 'x'.repeat(40));
});

test('multi-byte text with an odd cap never splits a character', () => {
  const text = 'é'.repeat(50); // 100 bytes, every char is 2 bytes
  const r = truncateText(text, 31);
  assert.equal(r.truncated, true);
  assert.equal(r.byteLength, 100);
  assert.equal(r.shownBytes, 30, 'backs up to the character boundary');
  const prefix = r.content.replace(MARKER, '');
  assert.equal(prefix, 'é'.repeat(15));
  assert.ok(!prefix.includes('�'));
});

test('3- and 4-byte characters (→ and 🙂) at the boundary', () => {
  for (const ch of ['→', '🙂']) {
    const text = ch.repeat(20);
    const size = Buffer.byteLength(ch);
    for (let cap = 1; cap < size * 3; cap++) {
      const r = truncateText(text, cap);
      assert.ok(r.shownBytes <= cap, 'shownBytes never exceeds the cap');
      assert.equal(r.shownBytes % size, 0, `cut on a boundary for ${ch} at cap ${cap}`);
      assert.ok(!r.content.includes('�'));
    }
  }
});

test('a caller can replace the advice at the end of the marker', () => {
  const r = truncateText('x'.repeat(100), 40, { hint: 'Run a narrower command to see more.' });
  assert.ok(
    r.content.endsWith('\n...[truncated: showing 40 of 100 bytes. Run a narrower command to see more.]'),
    `wrong marker: ${r.content.slice(-90)}`,
  );
});

test('the default cap is 32 KiB', () => {
  const r = truncateText('y'.repeat(40_000));
  assert.equal(r.shownBytes, 32 * 1024);
  assert.equal(r.byteLength, 40_000);
});
