// Course test — Day 4: NDJSON framing on hostile chunks.
// Copy into your project as tests/course/day04-ndjson.test.js, then: node --test tests/course/day04-*
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NdjsonParser, readNdjson } from '../../src/shared/ndjson.js';

const BODY = '{"text":"héllo → world"}\n{"n":2}\n{"done":true}\n';
const bytes = new TextEncoder().encode(BODY);

/** Split a Uint8Array at the given byte offsets. */
function splitAt(buf, offsets) {
  const out = [];
  let start = 0;
  for (const end of offsets) { out.push(buf.subarray(start, end)); start = end; }
  out.push(buf.subarray(start));
  return out;
}

const EXPECTED = [{ text: 'héllo → world' }, { n: 2 }, { done: true }];

test('one chunk containing several lines yields every record', () => {
  const p = new NdjsonParser();
  assert.deepEqual([...p.push(bytes), ...p.flush()], EXPECTED);
});

test('a chunk boundary in the middle of a line', () => {
  const p = new NdjsonParser();
  const out = splitAt(bytes, [5, 30]).flatMap((c) => p.push(c));
  assert.deepEqual([...out, ...p.flush()], EXPECTED);
});

test('a chunk boundary inside a multi-byte character (é is 2 bytes, → is 3)', () => {
  const eAt = BODY.indexOf('é');                       // UTF-16 index == byte index here (all ASCII before)
  const arrowByte = Buffer.byteLength(BODY.slice(0, BODY.indexOf('→')));
  const p = new NdjsonParser();
  const out = splitAt(bytes, [eAt + 1, arrowByte + 1, arrowByte + 2]).flatMap((c) => p.push(c));
  const all = [...out, ...p.flush()];
  assert.deepEqual(all, EXPECTED);
  assert.ok(!JSON.stringify(all).includes('�'), 'no replacement characters');
});

test('every byte delivered separately still works', () => {
  const p = new NdjsonParser();
  const out = [];
  for (let i = 0; i < bytes.length; i++) out.push(...p.push(bytes.subarray(i, i + 1)));
  assert.deepEqual([...out, ...p.flush()], EXPECTED);
});

test('a final line without a trailing newline comes out of flush()', () => {
  const p = new NdjsonParser();
  const first = p.push(new TextEncoder().encode('{"a":1}\n{"b":2}'));
  assert.deepEqual(first, [{ a: 1 }]);
  assert.deepEqual(p.flush(), [{ b: 2 }]);
});

test('blank lines are ignored', () => {
  const p = new NdjsonParser();
  assert.deepEqual(p.push(new TextEncoder().encode('{"a":1}\n\n\n{"b":2}\n')), [{ a: 1 }, { b: 2 }]);
});

test('readNdjson() turns a ReadableStream into records', async () => {
  const chunks = splitAt(bytes, [3, 17, 40]);
  const stream = new ReadableStream({
    start(controller) { for (const c of chunks) controller.enqueue(c); controller.close(); },
  });
  const records = [];
  for await (const r of readNdjson(stream)) records.push(r);
  assert.deepEqual(records, EXPECTED);
});

test('breaking out of readNdjson() early cancels the stream', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new TextEncoder().encode('{"tick":1}\n')); },
    cancel() { cancelled = true; },
  });
  for await (const r of readNdjson(stream)) { assert.deepEqual(r, { tick: 1 }); break; }
  assert.equal(cancelled, true);
});
