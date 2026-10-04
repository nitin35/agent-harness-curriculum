#!/usr/bin/env node
// course-assets/mcp/notes-server.mjs — a tiny MCP server over stdio, for Day 23. No dependencies.
//
//   node notes-server.mjs            dual-era: modern (2026-07-28, per-request _meta) AND legacy (initialize handshake)
//   node notes-server.mjs --legacy   legacy only (2025-11-25 style): rejects server/discover, requires initialize
//
// Tools: add_note {text}, list_notes {}, sleep {ms} (for timeout/abort tests), fail {} (returns isError).
// Protocol notes: one JSON-RPC message per line on stdout; logs go to stderr ONLY.
import readline from 'node:readline';

const MODERN = '2026-07-28';
const LEGACY = '2025-11-25';
const legacyOnly = process.argv.includes('--legacy');
const SERVER_INFO = { name: 'notes-server', version: '1.0.0' };

const notes = [];
let legacyInitialized = false;
const inFlight = new Map(); // id → { cancelled }

const TOOLS = [
  { name: 'add_note', title: 'Add note', description: 'Save a short text note. Returns the note number.', inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'The note text' } }, required: ['text'] } },
  { name: 'list_notes', title: 'List notes', description: 'List all saved notes, numbered.', inputSchema: { type: 'object', additionalProperties: false } },
  { name: 'sleep', description: 'Wait for ms milliseconds, then reply (for testing timeouts).', inputSchema: { type: 'object', properties: { ms: { type: 'integer' } }, required: ['ms'] } },
  { name: 'fail', description: 'Always fails (for testing error results).', inputSchema: { type: 'object' } },
];

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const result = (id, body) => send({ jsonrpc: '2.0', id, result: { resultType: 'complete', ...body, _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO } } });
const error = (id, code, message, data) => send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
const log = (...a) => process.stderr.write(`[notes-server] ${a.join(' ')}\n`);

async function handle(msg) {
  const { id, method, params = {} } = msg;
  if (id === undefined) { // notification
    if (method === 'notifications/cancelled') { const f = inFlight.get(params.requestId); if (f) f.cancelled = true; log('cancelled', params.requestId); }
    if (method === 'notifications/initialized') log('client initialized (legacy)');
    return;
  }

  if (method === 'initialize') {
    legacyInitialized = true;
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: LEGACY, capabilities: { tools: {} }, serverInfo: SERVER_INFO } });
  }

  const meta = params._meta ?? {};
  const version = meta['io.modelcontextprotocol/protocolVersion'];
  const modern = version !== undefined;

  if (modern) {
    if (legacyOnly) return error(id, -32601, `Method not found: ${method}`); // a legacy server doesn't know modern requests
    if (version !== MODERN) return error(id, -32022, 'Unsupported protocol version', { supported: [MODERN, LEGACY], requested: version });
    if (!meta['io.modelcontextprotocol/clientCapabilities']) return error(id, -32602, 'missing _meta io.modelcontextprotocol/clientCapabilities');
  } else {
    if (method === 'server/discover') return error(id, -32601, 'Method not found: server/discover'); // only reached in legacy-only mode or without _meta
    if (!legacyInitialized) return error(id, -32602, 'request without _meta before initialize');
  }

  switch (method) {
    case 'server/discover':
      return result(id, { supportedVersions: [MODERN, LEGACY], capabilities: { tools: {} }, instructions: 'Use add_note to remember things and list_notes to recall them.' });
    case 'tools/list':
      return result(id, { tools: TOOLS });
    case 'tools/call': {
      const args = params.arguments ?? {};
      switch (params.name) {
        case 'add_note':
          if (typeof args.text !== 'string' || !args.text) return result(id, { content: [{ type: 'text', text: 'text must be a non-empty string' }], isError: true });
          notes.push(args.text);
          return result(id, { content: [{ type: 'text', text: `Saved note #${notes.length}.` }], structuredContent: { number: notes.length }, isError: false });
        case 'list_notes':
          return result(id, { content: [{ type: 'text', text: notes.length ? notes.map((n, i) => `${i + 1}. ${n}`).join('\n') : '(no notes)' }], isError: false });
        case 'sleep': {
          const flight = { cancelled: false };
          inFlight.set(id, flight);
          await new Promise((r) => setTimeout(r, Number(args.ms) || 0));
          inFlight.delete(id);
          if (flight.cancelled) return; // MUST NOT send anything for a cancelled request
          return result(id, { content: [{ type: 'text', text: `slept ${args.ms} ms` }], isError: false });
        }
        case 'fail':
          return result(id, { content: [{ type: 'text', text: 'this tool always fails' }], isError: true });
        default:
          return error(id, -32602, `Unknown tool: ${params.name}`);
      }
    }
    default:
      return error(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  handle(msg).catch((err) => error(msg.id, -32603, err.message));
});
rl.on('close', () => process.exit(0)); // stdin closed = the client wants us gone
log(`ready (${legacyOnly ? 'legacy only' : 'dual-era'})`);
