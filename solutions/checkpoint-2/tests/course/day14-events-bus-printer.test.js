// Course test — Day 14: canonical events, the EventBus, the Printer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENTS, ALL_EVENTS, CORE_EVENTS, UI_EVENTS, isCanonicalEvent } from '../../src/shared/events.js';
import { EventBus } from '../../src/events/event-bus.js';
import { Printer } from '../../src/ui/printer.js';

test('the canonical list, verbatim — and no aliases', () => {
  assert.deepEqual([...CORE_EVENTS].sort(), [
    'agent_end', 'agent_start', 'command_run', 'compaction', 'error', 'session_shutdown', 'session_start',
    'text_delta', 'thinking_delta', 'tool_approval_request', 'tool_approval_result', 'tool_call_end',
    'tool_call_start', 'tool_result', 'turn_end', 'turn_start',
  ]);
  assert.deepEqual([...UI_EVENTS].sort(), ['abort', 'command', 'user_message']);
  assert.equal(ALL_EVENTS.length, 19);
  assert.ok(Object.isFrozen(EVENTS));
  for (const alias of ['tool_call', 'done', 'message_update', 'assistant_start']) {
    assert.equal(isCanonicalEvent(alias), false, `${alias} must not exist`);
  }
  assert.equal(EVENTS.TEXT_DELTA, 'text_delta');
});

test('listeners run in registration order', () => {
  const bus = new EventBus();
  const order = [];
  bus.on('turn_start', () => order.push(1));
  bus.on('turn_start', () => order.push(2));
  bus.on('turn_start', () => order.push(3));
  bus.emit('turn_start', { turn: 1 });
  assert.deepEqual(order, [1, 2, 3]);
});

test('a throwing listener is reported, the rest still run, emit() does not throw', () => {
  const errors = [];
  const bus = new EventBus({ onError: (err, { event }) => errors.push([err.message, event]) });
  const ran = [];
  bus.on('turn_start', () => ran.push('a'));
  bus.on('turn_start', () => { throw new Error('boom'); });
  bus.on('turn_start', () => ran.push('c'));
  assert.doesNotThrow(() => bus.emit('turn_start', { turn: 1 }));
  assert.deepEqual(ran, ['a', 'c']);
  assert.deepEqual(errors, [['boom', 'turn_start']]);
});

test('an async listener rejection reaches onError; emit stays synchronous', async () => {
  const errors = [];
  const bus = new EventBus({ onError: (err) => errors.push(err.message) });
  bus.on('agent_end', async () => { throw new Error('later'); });
  bus.emit('agent_end', { response: '', turns: 1, aborted: false });
  assert.deepEqual(errors, [], 'not yet: emit did not await');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(errors, ['later']);
});

test('off removes exactly that listener; on() returns an unsubscribe', () => {
  const bus = new EventBus();
  const calls = [];
  const a = () => calls.push('a');
  const b = () => calls.push('b');
  bus.on('turn_end', a);
  const offB = bus.on('turn_end', b);
  bus.off('turn_end', a);
  bus.emit('turn_end', { turn: 1 });
  offB();
  bus.emit('turn_end', { turn: 2 });
  assert.deepEqual(calls, ['b']);
  assert.equal(bus.listenerCount('turn_end'), 0);
});

test('once fires exactly once — even if its first run throws or re-emits', () => {
  const bus = new EventBus({ onError: () => {} });
  let n = 0;
  bus.once('turn_start', () => { n++; bus.emit('turn_start', { turn: 2 }); throw new Error('x'); });
  bus.emit('turn_start', { turn: 1 });
  bus.emit('turn_start', { turn: 3 });
  assert.equal(n, 1);
  assert.equal(bus.listenerCount('turn_start'), 0);
});

test('off() also removes a once() listener by its original function', () => {
  const bus = new EventBus();
  const fn = () => assert.fail('should not run');
  bus.once('turn_start', fn);
  bus.off('turn_start', fn);
  bus.emit('turn_start', { turn: 1 });
});

test('listenerCount tracks adds and removes', () => {
  const bus = new EventBus();
  const off1 = bus.on('error', () => {});
  bus.on('error', () => {});
  assert.equal(bus.listenerCount('error'), 2);
  off1();
  assert.equal(bus.listenerCount('error'), 1);
});

test('strict by default: unknown event names throw on on() and emit()', () => {
  const bus = new EventBus();
  assert.throws(() => bus.on('tool_call', () => {}), /unknown event/);
  assert.throws(() => bus.emit('done', {}), /unknown event/);
  const loose = new EventBus({ events: null });
  assert.doesNotThrow(() => loose.emit('anything', {}));
});

/** A fake writable that records what was written. */
function sink({ isTTY = false } = {}) {
  const chunks = [];
  return { isTTY, write: (s) => { chunks.push(s); return true; }, text: () => chunks.join('') };
}

test('printer: role prefixes, one line each', () => {
  const out = sink();
  const p = new Printer({ out, color: 'never' });
  p.printUser('hi');
  p.printAssistant('hello');
  p.printTool('bash', '{"command":"ls"}');
  p.printSystem('note');
  p.printError('bad');
  assert.equal(out.text(), 'you> hi\nagent> hello\n  ⚙ bash {"command":"ls"}\n  · note\nerror> bad\n');
});

test('printer colour gate: never → no escapes; auto on a non-TTY → none; always → some', () => {
  const never = sink({ isTTY: true });
  new Printer({ out: never, color: 'never' }).printError('x');
  assert.ok(!never.text().includes('\x1b['));
  const autoPipe = sink({ isTTY: false });
  new Printer({ out: autoPipe, color: 'auto', env: {} }).printError('x');
  assert.ok(!autoPipe.text().includes('\x1b['));
  const autoNoColor = sink({ isTTY: true });
  new Printer({ out: autoNoColor, color: 'auto', env: { NO_COLOR: '1' } }).printError('x');
  assert.ok(!autoNoColor.text().includes('\x1b['));
  const always = sink();
  new Printer({ out: always, color: 'always' }).printError('x');
  assert.ok(always.text().includes('\x1b['));
});

test('printer.write streams chunks without newlines', () => {
  const out = sink();
  const p = new Printer({ out, color: 'never' });
  p.write('Hel');
  p.write('lo');
  assert.equal(out.text(), 'Hello');
});
