// src/mcp/mcp-client.js — a minimal MCP client over stdio (Day 23). No SDK: JSON-RPC + a child process.
//
// Spec: https://modelcontextprotocol.io/specification/2026-07-28
//   - stdio framing: one JSON-RPC message per line; the server logs to stderr only
//   - MODERN (2026-07-28): no handshake; EVERY request carries _meta with protocolVersion + clientCapabilities
//   - LEGACY (2025-11-25 and earlier): `initialize` + `notifications/initialized` first, then plain requests
//   - We are "dual-era": probe with server/discover; a DiscoverResult (or UnsupportedProtocolVersion) means
//     modern; any other error or no answer within the probe timeout means legacy → initialize.
//   - Cancel an in-flight request with notifications/cancelled; shut down by closing the server's stdin.
import { spawn } from 'node:child_process';
import os from 'node:os';
import { NdjsonParser } from '../shared/ndjson.js';

// An MCP server is a child PROCESS, and it inherits whatever environment we give it. Handing it all of
// process.env would leak your shell's secrets — API keys, tokens, this harness's own provider key — into
// a program you may barely know. Pass only a short, safe baseline plus what the server config names
// explicitly (the official SDK does the same). Secrets a server needs go in its `env`, from settings.
const SAFE_ENV_KEYS = ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TMP', 'TEMP',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'SYSTEMROOT', 'SYSTEMDRIVE', 'PATHEXT', 'COMSPEC', 'WINDIR'];
export function defaultEnv(base = process.env) {
  const out = {};
  for (const k of SAFE_ENV_KEYS) if (base[k] !== undefined) out[k] = base[k];
  return out;
}

export const MODERN_VERSION = '2026-07-28';
export const LEGACY_VERSION = '2025-11-25';
const UNSUPPORTED_VERSION = -32022;

export class McpError extends Error {
  /** @param {string} message @param {{ code?: number, data?: any }} [opts]   data: whatever JSON the server sent */
  constructor(message, { code, data } = {}) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.data = data;
  }
}

export class McpClient {
  /**
   * @param {{
   *   name: string, command: string, args?: string[], env?: Record<string, string>, cwd?: string,
   *   requestTimeoutMs?: number, probeTimeoutMs?: number,
   *   clientInfo?: { name: string, version: string },
   *   onLog?: (line: string) => void,
   * }} opts
   */
  constructor({ name, command, args = [], env, cwd, requestTimeoutMs = 30_000, probeTimeoutMs = 2_000, clientInfo = { name: 'agent-harness', version: '0.1.0' }, onLog = () => {} }) {
    this.name = name;
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.requestTimeoutMs = requestTimeoutMs;
    this.probeTimeoutMs = probeTimeoutMs;
    this.clientInfo = clientInfo;
    this.onLog = onLog;
    this.child = null;
    /** @type {'modern'|'legacy'|null} */ this.era = null;
    this.protocolVersion = null;
    this.serverInfo = null;
    this.instructions = undefined;
    this.#nextId = 1;
    /** @type {Map<number, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
    this.#pending = new Map();
  }

  #nextId;
  #pending;
  /** Set once the server process has exited or failed to start: every later request fails with it at once. */
  #gone = null;

  /** Spawn the server and work out which protocol era it speaks. */
  async start() {
    this.child = spawn(this.command, this.args, { cwd: this.cwd, env: { ...defaultEnv(), ...this.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const parser = new NdjsonParser();
    this.child.stdout.on('data', (chunk) => {
      let messages;
      try { messages = parser.push(chunk); } catch (err) { this.onLog(`bad JSON from server: ${err.message}`); return; }
      for (const msg of messages) this.#onMessage(msg);
    });
    this.child.stderr.on('data', (d) => { for (const line of String(d).split('\n')) if (line.trim()) this.onLog(line); });
    this.child.on('exit', (code, signal) => this.#failAll(new McpError(`MCP server '${this.name}' exited (${signal ?? `code ${code}`})`)));
    this.child.on('error', (err) => this.#failAll(new McpError(`could not start MCP server '${this.name}': ${err.message}`)));
    this.child.stdin.on('error', () => {}); // EPIPE after the server dies is reported via 'exit'

    // --- era detection ---
    try {
      const r = await this.#request('server/discover', {}, { timeoutMs: this.probeTimeoutMs, version: MODERN_VERSION });
      this.era = 'modern';
      this.protocolVersion = r.supportedVersions?.includes(MODERN_VERSION) ? MODERN_VERSION : r.supportedVersions?.[0];
      this.serverInfo = r._meta?.['io.modelcontextprotocol/serverInfo'] ?? null;
      this.instructions = r.instructions;
    } catch (err) {
      if (this.#gone) throw this.#gone; // the server died or never started: there is no era to detect
      if (err instanceof McpError && err.code === UNSUPPORTED_VERSION && Array.isArray(err.data?.supported)) {
        this.era = 'modern';
        this.protocolVersion = err.data.supported[0];
      } else {
        await this.#legacyHandshake();
      }
    }
    return this;
  }

  async #legacyHandshake() {
    this.era = 'legacy';
    const r = await this.#request('initialize', { protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo: this.clientInfo }, { legacy: true });
    this.protocolVersion = r.protocolVersion ?? LEGACY_VERSION;
    this.serverInfo = r.serverInfo ?? null;
    this.instructions = r.instructions;
    this.#notify('notifications/initialized', {});
  }

  /** @returns {Promise<Array<{ name: string, title?: string, description?: string, inputSchema: object, annotations?: { readOnlyHint?: boolean } }>>} */
  async listTools() {
    const tools = [];
    let cursor;
    do {
      const r = await this.request('tools/list', cursor ? { cursor } : {});
      tools.push(...(r.tools ?? []));
      cursor = r.nextCursor;
    } while (cursor);
    return tools;
  }

  /**
   * @param {string} name @param {object} args
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<{ content: any[], isError: boolean, structuredContent?: unknown }>}
   */
  async callTool(name, args, { signal } = {}) {
    const r = await this.request('tools/call', { name, arguments: args ?? {} }, { signal });
    if (r.resultType === 'input_required') {
      return { content: [{ type: 'text', text: `MCP tool ${name} asked for user input (elicitation), which this harness does not support yet.` }], isError: true };
    }
    return { content: r.content ?? [], isError: Boolean(r.isError), structuredContent: r.structuredContent };
  }

  /**
   * A request in the negotiated era (adds _meta for modern servers).
   * @param {string} method @param {Record<string, any>} [params] @param {{ signal?: AbortSignal, timeoutMs?: number }} [opts]
   */
  request(method, params = {}, { signal, timeoutMs } = {}) {
    return this.#request(method, params, { signal, timeoutMs, version: this.era === 'modern' ? this.protocolVersion : undefined, legacy: this.era === 'legacy' });
  }

  /** @param {string} method @param {Record<string, any>} params @param {{ signal?: AbortSignal, timeoutMs?: number, version?: string, legacy?: boolean }} opts */
  #request(method, params, { signal, timeoutMs = this.requestTimeoutMs, version, legacy = false }) {
    if (!this.child) return Promise.reject(new McpError('client not started'));
    if (this.#gone) return Promise.reject(this.#gone); // nothing would ever answer: fail now, not after the timeout
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = this.#nextId++;
    const finalParams = legacy || !version ? params : {
      ...params,
      _meta: {
        ...(params._meta ?? {}),
        'io.modelcontextprotocol/protocolVersion': version,
        'io.modelcontextprotocol/clientInfo': this.clientInfo,
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    };
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); this.#pending.delete(id); };
      const timer = setTimeout(() => {
        cleanup();
        this.#notify('notifications/cancelled', { requestId: id, reason: 'timeout' });
        reject(new McpError(`MCP ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      const onAbort = () => {
        cleanup();
        this.#notify('notifications/cancelled', { requestId: id, reason: 'aborted by user' });
        reject(signal.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(id, { resolve: (v) => { cleanup(); resolve(v); }, reject: (e) => { cleanup(); reject(e); }, timer });
      this.#write({ jsonrpc: '2.0', id, method, params: finalParams });
    });
  }

  #notify(method, params) { this.#write({ jsonrpc: '2.0', method, params }); }

  #write(msg) {
    if (this.child?.stdin.writable) this.child.stdin.write(`${JSON.stringify(msg)}\n`); // one message per line — JSON.stringify never emits raw newlines
  }

  #onMessage(msg) {
    if (msg.id === undefined || msg.id === null) return; // server notifications (progress, logging) — ignored here
    const p = this.#pending.get(msg.id);
    if (!p) return; // a reply to something we cancelled
    if (msg.error) p.reject(new McpError(msg.error.message ?? 'MCP error', { code: msg.error.code, data: msg.error.data }));
    else p.resolve(msg.result ?? {});
  }

  #failAll(err) {
    this.#gone ??= err; // the first cause wins ('error' and 'exit' can both fire)
    for (const [, p] of this.#pending) p.reject(err);
    this.#pending.clear();
  }

  /** Graceful shutdown: close stdin, wait, then SIGTERM, then SIGKILL. */
  async close({ graceMs = 1_000 } = {}) {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((r) => child.once('exit', r));
    child.stdin.end();
    const timeout = (ms) => new Promise((r) => setTimeout(r, ms).unref());
    if (await Promise.race([exited.then(() => true), timeout(graceMs).then(() => false)])) return;
    child.kill('SIGTERM');
    if (await Promise.race([exited.then(() => true), timeout(graceMs).then(() => false)])) return;
    child.kill('SIGKILL');
  }
}
