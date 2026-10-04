// Course test — Day 23: the MCP client (modern + legacy eras) and MCP tools in the registry.
// Needs examples/mcp/notes-server.mjs (copy it from course-assets/mcp/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpClient, MODERN_VERSION, defaultEnv } from '../../src/mcp/mcp-client.js';
import { registerMcpTools, mcpToolName } from '../../src/mcp/mcp-tools.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { AgentLoop } from '../../src/agent/agent-loop.js';
import { ScriptedProvider } from '../../src/provider/scripted.js';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../examples/mcp/notes-server.mjs');

async function startClient(t, { legacy = false, ...opts } = {}) {
  const client = new McpClient({ name: 'notes', command: process.execPath, args: [SERVER, ...(legacy ? ['--legacy'] : [])], ...opts });
  t.after(() => client.close());
  return client.start();
}

test('modern server: server/discover → era "modern" on 2026-07-28, instructions read', async (t) => {
  const c = await startClient(t);
  assert.equal(c.era, 'modern');
  assert.equal(c.protocolVersion, MODERN_VERSION);
  assert.equal(c.serverInfo?.name, 'notes-server');
  assert.match(c.instructions, /add_note/);
});

test('modern: tools/list and tools/call work (the server rejects any request missing _meta, so this proves it is sent)', async (t) => {
  const c = await startClient(t);
  assert.deepEqual((await c.listTools()).map((x) => x.name), ['add_note', 'list_notes', 'sleep', 'fail']);
  const saved = await c.callTool('add_note', { text: 'buy milk' });
  assert.deepEqual(saved.content, [{ type: 'text', text: 'Saved note #1.' }]);
  assert.equal(saved.isError, false);
  assert.match((await c.callTool('list_notes', {})).content[0].text, /1\. buy milk/);
});

test('legacy server: the probe fails, the client falls back to initialize, tools still work', async (t) => {
  const c = await startClient(t, { legacy: true, probeTimeoutMs: 1_000 });
  assert.equal(c.era, 'legacy');
  assert.equal(c.protocolVersion, '2025-11-25');
  assert.ok((await c.listTools()).some((x) => x.name === 'add_note'));
  assert.equal((await c.callTool('add_note', { text: 'x' })).isError, false);
});

test('a tool-level failure is a RESULT with isError, not an exception', async (t) => {
  const c = await startClient(t);
  const r = await c.callTool('fail', {});
  assert.equal(r.isError, true);
});

test('abort: the request rejects at once (and notifications/cancelled is sent)', async (t) => {
  const c = await startClient(t);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const started = Date.now();
  await assert.rejects(c.callTool('sleep', { ms: 5_000 }, { signal: controller.signal }), { name: 'AbortError' });
  assert.ok(Date.now() - started < 1_000);
  assert.equal((await c.callTool('list_notes', {})).isError, false, 'the client is still usable afterwards');
});

test('timeout: a slow request fails with a clear message', async (t) => {
  const c = await startClient(t, { requestTimeoutMs: 100 });
  await assert.rejects(c.callTool('sleep', { ms: 2_000 }), /timed out after 100 ms/);
});

test('a server that dies fails pending requests instead of hanging', async (t) => {
  const c = await startClient(t);
  const pending = c.callTool('sleep', { ms: 10_000 });
  c.child.kill('SIGKILL');
  await assert.rejects(pending, /exited/);
  const started = Date.now();
  await assert.rejects(c.callTool('list_notes', {}), /exited/, 'a request after the death fails with the same error');
  assert.ok(Date.now() - started < 1_000, 'at once, not after the request timeout');
  // A server that can't start at all fails start() at once, too, instead of timing out in a fallback.
  const ghost = new McpClient({ name: 'ghost', command: path.join(path.dirname(SERVER), 'no-such-server') });
  await assert.rejects(ghost.start(), /could not start MCP server 'ghost'/);
});

test('close() shuts the server down by closing its stdin', async (t) => {
  const c = await startClient(t);
  await c.close();
  assert.ok(c.child.exitCode !== null || c.child.signalCode !== null);
});

test('registered as harness tools: namespaced, needsApproval, origin in the description', async (t) => {
  const c = await startClient(t);
  const registry = new ToolRegistry();
  const { names, unregister } = await registerMcpTools(registry, c);
  assert.ok(names.includes('mcp__notes__add_note'));
  const tool = registry.getTool('mcp__notes__add_note');
  assert.equal(tool.needsApproval, true);
  assert.match(tool.description, /^\[MCP server "notes"\]/);
  assert.equal(mcpToolName('my server!', 'do it'), 'mcp__my_server___do_it');
  unregister();
  assert.equal(registry.getTools().length, 0);
});

test('end to end: the agent loop calls an MCP tool and the result comes back as a normal tool result', async (t) => {
  const c = await startClient(t);
  const registry = new ToolRegistry();
  await registerMcpTools(registry, c);
  const provider = new ScriptedProvider([
    ScriptedProvider.toolCalls(['mcp__notes__add_note', { text: 'from the loop' }, 'c1']),
    ScriptedProvider.toolCalls(['mcp__notes__list_notes', {}, 'c2']),
    (messages) => ScriptedProvider.text(`notes: ${messages.at(-1).content}`),
  ]);
  const loop = new AgentLoop({ provider, registry, approve: async () => true });
  const r = await loop.run('remember this');
  assert.match(r.response, /from the loop/);
  assert.ok(provider.calls[0].tools.some((x) => x.name === 'mcp__notes__add_note'));
});

test('defaultEnv: a server gets a safe baseline, never your whole environment (no secret leaks)', () => {
  const env = defaultEnv({ PATH: '/bin', HOME: '/home/u', LANG: 'en_US.UTF-8', OPENAI_API_KEY: 'sk-secret', AWS_SECRET_ACCESS_KEY: 'x' });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/home/u');
  assert.equal(env.LANG, 'en_US.UTF-8');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
});

test('two tools that collide after sanitizing: the duplicate is skipped with a warning, not a throw', async () => {
  const registry = new ToolRegistry();
  const warnings = [];
  const fake = { name: 'notes', async listTools() { return [
    { name: 'search_notes', description: 'by tag', inputSchema: { type: 'object' } },
    { name: 'search notes', description: 'by text', inputSchema: { type: 'object' } },
  ]; } };
  const { names, unregister } = await registerMcpTools(registry, fake, { onWarn: (m) => warnings.push(m) });
  assert.deepEqual(names, ['mcp__notes__search_notes']);
  assert.equal(registry.getTools().length, 1, 'only the first tool registered');
  assert.match(warnings[0], /already taken/);
  unregister();
  assert.equal(registry.getTools().length, 0, 'unregister still removes exactly what was added');
});
