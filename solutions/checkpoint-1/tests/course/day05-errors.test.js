// Course test — Day 5: src/shared/errors.js, the error vocabulary every later day uses.
// Copy into your project as tests/course/day05-errors.test.js, then: node --test tests/course/day05-*
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HarnessError, UsageError, ValidationError, ProviderError, isAbortError } from '../../src/shared/errors.js';

test('HarnessError is an Error with a name, a category (default "internal") and an optional hint', () => {
  const e = new HarnessError('boom');
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'HarnessError');
  assert.equal(e.message, 'boom');
  assert.equal(e.category, 'internal');
  assert.equal(new HarnessError('x', { category: 'provider', hint: 'try y' }).hint, 'try y');
});

test('the cause is kept, so adding context never hides the original failure', () => {
  const root = new Error('ECONNREFUSED');
  assert.equal(new HarnessError('provider call failed', { cause: root }).cause, root);
});

test('UsageError: category "user", remembers the offending token, and is a HarnessError', () => {
  const e = new UsageError('Unknown option: --nope', { token: '--nope' });
  assert.ok(e instanceof HarnessError);
  assert.equal(e.name, 'UsageError');
  assert.equal(e.category, 'user');
  assert.equal(e.token, '--nope');
});

test('ValidationError: names the field; category defaults to "user" but can be "internal"', () => {
  const e = new ValidationError('--num-ctx must be a number', { field: 'num-ctx' });
  assert.ok(e instanceof HarnessError);
  assert.equal(e.name, 'ValidationError');
  assert.equal(e.field, 'num-ctx');
  assert.equal(e.category, 'user');
  assert.equal(new ValidationError('bad tool schema', { field: 'parameters', category: 'internal' }).category, 'internal');
});

test('ProviderError: category "provider", with kind, status, cause and hint', () => {
  const cause = new TypeError('fetch failed');
  const e = new ProviderError('Cannot reach Ollama', { kind: 'unreachable', cause, hint: 'Is Ollama running? Try: ollama serve' });
  assert.ok(e instanceof HarnessError);
  assert.equal(e.name, 'ProviderError');
  assert.equal(e.category, 'provider');
  assert.equal(e.kind, 'unreachable');
  assert.equal(e.cause, cause);
  assert.match(e.hint, /ollama serve/);
  assert.equal(new ProviderError('HTTP 500', { kind: 'http', status: 500 }).status, 500);
});

test('isAbortError: true for a user abort and a timeout, false for everything else', async () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal(isAbortError(controller.signal.reason), true, 'a DOMException named AbortError');

  const timeout = AbortSignal.timeout(1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(isAbortError(timeout.reason), true, 'a DOMException named TimeoutError');

  assert.equal(isAbortError(new Error('boom')), false);
  assert.equal(isAbortError(new ProviderError('HTTP 500', { kind: 'http' })), false);
  assert.equal(isAbortError(undefined), false);
  assert.equal(isAbortError(null), false);
});
