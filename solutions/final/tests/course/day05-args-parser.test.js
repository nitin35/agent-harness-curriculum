// Course test — Day 5: src/cli/args-parser.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, getUsage, UsageError } from '../../src/cli/args-parser.js';

/** The example spec from Day 5. */
const SPEC = [
  { name: 'version', short: '-v', long: '--version', type: 'boolean', description: 'Print the version and exit' },
  { name: 'verbose', short: '-V', long: '--verbose', type: 'boolean', description: 'Debug logging' },
  { name: 'model', long: '--model', type: 'string', description: 'Model to use' },
  { name: 'extension', long: '--extension', type: 'string', repeatable: true, description: 'Load an extension file' },
  { name: 'help', short: '-h', long: '--help', type: 'boolean', description: 'Show this help' },
];

test('-v means --version (never verbose)', () => {
  const { values } = parseArgs(['-v'], SPEC);
  assert.equal(values.version, true);
  assert.equal(values.verbose, undefined);
});

test('--flag=value', () => {
  assert.equal(parseArgs(['--model=qwen3.5:4b'], SPEC).values.model, 'qwen3.5:4b');
});

test('--flag value', () => {
  assert.equal(parseArgs(['--model', 'qwen3.5:4b'], SPEC).values.model, 'qwen3.5:4b');
});

test('repeatable flags collect into an array, in order', () => {
  assert.deepEqual(parseArgs(['--extension', 'a.js', '--extension=b.js'], SPEC).values.extension, ['a.js', 'b.js']);
});

test('positionals are kept in order', () => {
  const { values, positionals } = parseArgs(['-v', 'hello', 'world'], SPEC);
  assert.equal(values.version, true);
  assert.deepEqual(positionals, ['hello', 'world']);
});

test('everything after -- is positional', () => {
  assert.deepEqual(parseArgs(['--', '-v', '--model'], SPEC).positionals, ['-v', '--model']);
});

test('unknown flag throws UsageError naming the token', () => {
  assert.throws(() => parseArgs(['--nope'], SPEC), (err) => {
    assert.ok(err instanceof UsageError);
    assert.equal(err.token, '--nope');
    assert.match(err.message, /--nope/);
    return true;
  });
});

test('string flag with no value throws UsageError', () => {
  assert.throws(() => parseArgs(['--model'], SPEC), UsageError);
});

test('UsageError is a user-category error', () => {
  assert.throws(() => parseArgs(['--nope'], SPEC), (err) => {
    assert.equal(err.category, 'user');
    return true;
  });
});

test('getUsage lists every form and keeps -v as version', () => {
  const usage = getUsage(SPEC, { name: 'agent-harness' });
  assert.match(usage, /-v, --version/);
  assert.match(usage, /-V, --verbose/);
  assert.match(usage, /--model <value>/);
  const vLine = usage.split('\n').find((l) => l.includes('-v, --version'));
  assert.doesNotMatch(vLine, /verbose/i);
});
