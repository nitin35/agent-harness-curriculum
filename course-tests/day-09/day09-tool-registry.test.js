// Course test — Day 9: tool contracts and the registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { validateToolDefinition, validateToolResult, validateArguments } from '../../src/shared/tool-schemas.js';

const okTool = (name = 'echo', extra = {}) => ({
  name,
  description: 'Echo the text back.',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  execute: async ({ text }) => ({ content: String(text), isError: false }),
  ...extra,
});

test('a good definition validates', () => {
  assert.deepEqual(validateToolDefinition(okTool()), { ok: true });
});

test('bad definitions fail with a message naming the field', () => {
  const cases = [
    [null, /object/],
    [{ ...okTool(), name: '' }, /name/],
    [{ ...okTool(), name: 'has space' }, /name/],
    [{ ...okTool(), description: '' }, /description/],
    [{ ...okTool(), parameters: 'nope' }, /parameters/],
    [{ ...okTool(), parameters: { type: 'string' } }, /parameters\.type/],
    [{ ...okTool(), execute: 'run' }, /execute/],
    [{ ...okTool(), needsApproval: 'yes' }, /needsApproval/],
  ];
  for (const [def, re] of cases) {
    const r = validateToolDefinition(def);
    assert.equal(r.ok, false, JSON.stringify(def));
    assert.match(r.error, re);
  }
});

test('validateToolResult', () => {
  assert.deepEqual(validateToolResult({ content: 'x', isError: false }), { ok: true });
  assert.match(validateToolResult({ content: 1, isError: false }).error, /content/);
  assert.match(validateToolResult({ content: 'x' }).error, /isError/);
});

test('validateArguments catches what models get wrong', () => {
  const schema = {
    type: 'object',
    properties: { path: { type: 'string' }, limit: { type: 'integer' }, mode: { type: 'string', enum: ['a', 'b'] } },
    required: ['path'],
  };
  assert.deepEqual(validateArguments(schema, { path: 'x' }), { ok: true });
  assert.match(validateArguments(schema, {}).error, /path/);
  assert.match(validateArguments(schema, { path: 3 }).error, /path must be string/);
  assert.match(validateArguments(schema, { path: 'x', limit: 1.5 }).error, /limit must be integer/);
  assert.match(validateArguments(schema, { path: 'x', mode: 'c' }).error, /mode/);
  assert.match(validateArguments(schema, 'not an object').error, /object/);
});

test('register, look up, list in registration order, unregister', () => {
  const reg = new ToolRegistry();
  reg.registerTool(okTool('b'));
  reg.registerTool(okTool('a'));
  assert.equal(reg.getTool('a').name, 'a');
  assert.deepEqual(reg.getTools().map((t) => t.name), ['b', 'a']);
  assert.equal(reg.unregisterTool('b'), true);
  assert.deepEqual(reg.getTools().map((t) => t.name), ['a']);
  assert.equal(reg.getTool('b'), undefined);
});

test('registerTool returns an unregister function', () => {
  const reg = new ToolRegistry();
  const off = reg.registerTool(okTool('x'));
  off();
  assert.equal(reg.getTools().length, 0);
});

test('duplicate names are rejected loudly', () => {
  const reg = new ToolRegistry();
  reg.registerTool(okTool('dup'));
  assert.throws(() => reg.registerTool(okTool('dup')), /already registered/);
});

test('invalid definitions are rejected at registration', () => {
  assert.throws(() => new ToolRegistry().registerTool({ name: 'x' }), /description/);
});

test('names like toString or __proto__ are safe (Map, not a plain object)', () => {
  const reg = new ToolRegistry();
  assert.equal(reg.getTool('toString'), undefined);
  reg.registerTool(okTool('toString'));
  assert.equal(reg.getTool('toString').name, 'toString');
});

test('toProviderTools: plain JSON, no execute, no needsApproval, round-trips through JSON', () => {
  const reg = new ToolRegistry();
  reg.registerTool(okTool('write', { needsApproval: true, label: 'Write file' }));
  const specs = reg.toProviderTools();
  assert.deepEqual(specs, [{ name: 'write', description: 'Echo the text back.', parameters: okTool().parameters }]);
  assert.deepEqual(JSON.parse(JSON.stringify(specs)), specs);
});

test('toProviderTools(enabled) keeps only the enabled names', () => {
  const reg = new ToolRegistry();
  reg.registerTool(okTool('read'));
  reg.registerTool(okTool('bash'));
  assert.deepEqual(reg.toProviderTools(['read']).map((t) => t.name), ['read']);
});

test('additionalProperties: false refuses invented arguments by name, and lists what is allowed', () => {
  const schema = { type: 'object', properties: { path: { type: 'string' }, limit: { type: 'integer' } }, required: ['path'], additionalProperties: false };
  const r = validateArguments(schema, { path: 'a.txt', output: 'made-up file contents' });
  assert.equal(r.ok, false);
  assert.match(r.error, /unexpected property 'output'/);
  assert.match(r.error, /allowed: path, limit/);
  const open = { ...schema };
  delete open.additionalProperties;
  assert.equal(validateArguments(open, { path: 'a.txt', output: 'x' }).ok, true, 'without it, JSON Schema allows extra properties');
});
