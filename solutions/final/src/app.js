// src/app.js — createApp(): wires every piece together (Day 15; sessions 17–19; grows on later days).
import { AgentLoop } from './agent/agent-loop.js';
import { EventBus } from './events/event-bus.js';
import { OllamaProvider } from './provider/ollama.js';
import { ToolRegistry } from './tools/tool-registry.js';
import { createBuiltinTools } from './tools/builtin/index.js';
import { Printer } from './ui/printer.js';
import { PromptUI } from './ui/prompt-ui.js';
import { UIBridge, INTERRUPTED_NOTE } from './bridge.js';
import { CommandRegistry } from './commands/registry.js';
import { createBuiltinCommands } from './commands/builtin/index.js';
import { SessionManager, listSessions } from './session/session-manager.js';
import { globalPaths, configDir, projectPaths } from './config/paths.js';
import { EVENTS } from './shared/events.js';
import { PermissionPolicy } from './agent/permissions.js';
import { createApprovalGate, attachApprovalPrompt } from './agent/approval-gate.js';
import { ExtensionLoader, loadProjectExtensions } from './extensions/loader.js';
import { TrustStore } from './extensions/trust.js';
import { McpClient } from './mcp/mcp-client.js';
import { registerMcpTools } from './mcp/mcp-tools.js';
import { buildSystemPrompt } from './context/system-prompt-builder.js';
import { loadProjectInstructions } from './context/project-instructions.js';
import { discoverSkills, createLoadSkillTool } from './context/skills.js';
import { calibratedContextTokens, estimateTokens, estimateToolTokens, estimateTotalContext } from './context/token-estimator.js';
import { computeBudget, effectiveContextLimit, formatBudget, shouldCompact, truncationSuspected } from './context/budget.js';
import { shortenOldToolResults } from './context/compaction.js';
import { expandRefs, extractRefs } from './ui/file-refs.js';
import { DEFAULT_CONTEXT_WINDOW } from './shared/constants.js';
import { createCompleter } from './ui/completer.js';

/**
 * @param {{
 *   cwd?: string,
 *   provider?: import('./shared/message-schemas.js').Provider,
 *   input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, terminal?: boolean,
 *   color?: 'auto'|'always'|'never',
 *   onExit?: (code: number) => void,
 *   streaming?: boolean,
 *   home?: string,                 // config dir override (tests); default ~/.config/agent-harness
 *   permissions?: { mode?: string, allow?: string[], deny?: string[] },   // Day 20
 *   interactive?: boolean,         // false for -p / evals: 'ask' decisions become deny (fail closed)
 *   approvalTimeoutMs?: number,
 *   extensions?: { files?: string[], allowProjectExtensions?: boolean, loadGlobal?: boolean },   // Day 22
 *   mcpServers?: Record<string, { command: string, args?: string[], env?: Record<string,string>, cwd?: string }>, // Day 23 (GLOBAL config only)
 *   systemPrompt?: string,          // Day 24: your extra instructions (--system-prompt / settings)
 *   contextLimitCap?: number|null,  // Day 24: settings compaction.contextLimit — can only LOWER the window
 *   compaction?: { enabled?: boolean, keepMessages?: number },   // Day 25
 *   maxTurns?: number, enabledTools?: string[]|null,            // Day 26 (settings)
 *   logger?: { child: (m: string) => { debug: Function, info: Function, warn: Function, error: Function } },
 *   persistModel?: (name: string) => void | Promise<void>,      // Day 26: /model writes your global settings
 * }} [opts]
 */
export function createApp({
  cwd = process.cwd(), provider = new OllamaProvider(), input, output, terminal, color, onExit, streaming = true, home,
  permissions = {}, interactive = true, approvalTimeoutMs = 120_000,
  extensions = {}, mcpServers = {}, systemPrompt: userPrompt, contextLimitCap = null,
  compaction: compactionOpts = {}, maxTurns, enabledTools = null, logger, persistModel,
} = {}) {
  const paths = globalPaths(home ?? configDir());
  const bus = new EventBus();
  const registry = new ToolRegistry();
  for (const tool of createBuiltinTools({ root: cwd })) registry.registerTool(tool);

  const printer = new Printer({ out: output ?? process.stdout, color });
  const ui = new PromptUI({
    input, output, printer, bus, terminal, onExit: (code) => app.stop(code),
    completer: (line) => completer(line), // assigned below, once the command registry exists
  });

  // Day 20: the permission policy decides first; only 'ask' reaches the human (through the bus).
  const policy = new PermissionPolicy({ ...permissions, root: cwd });
  const gate = createApprovalGate({ bus, policy, interactive, timeoutMs: approvalTimeoutMs });
  if (interactive) attachApprovalPrompt({ bus, ui });

  const loop = new AgentLoop({
    provider, registry, streaming, maxTurns, enabledTools: enabledTools ?? undefined,
    approve: gate.approve,
    gateAllTools: true, // read-only mode and deny rules apply to every tool, not just needsApproval ones
    emit: (event, payload) => bus.emit(event, payload),
  });

  /** @type {SessionManager} */
  let session = SessionManager.create({ cwd, model: provider.model, dir: paths.sessions });
  /** Day 19: the sessions started in THIS folder, newest first (by file time, so nothing can go stale). */
  const sessionsHere = () => listSessions(paths.sessions, { cwd, onWarn: () => {} });
  const lastSessionHere = async () => (await sessionsHere())[0] ?? null;

  const commands = new CommandRegistry();
  for (const def of createBuiltinCommands()) commands.register(def);
  const completer = createCompleter({ commands, root: cwd });

  /** Day 28: expand @refs before the message is sent. Any failed ref → nothing is sent. */
  async function attachRefs(content) {
    if (!extractRefs(content).length) return content;
    // Attachments share the window with the system prompt, tools and history, and they sit in the newest
    // message, which compaction never touches. Give them at most ~40% of the window (4 bytes ≈ 1 token).
    let limit;
    try { limit = await currentLimit(); } catch { limit = DEFAULT_CONTEXT_WINDOW; }
    const { text, attachments, errors } = await expandRefs(content, { root: cwd, budgetBytes: Math.floor(limit * 4 * 0.4) });
    for (const a of attachments) ui.printSystem(`attached: ${a.path} (${a.bytes} B${a.toFit ? ', truncated to fit the context window' : a.truncated ? ', truncated' : ''})`);
    if (errors.length) throw new Error(`not sent — ${errors.join('; ')}`);
    return text;
  }

  /** @type {import('./shared/commands.js').CommandContext} */
  const ctx = {
    ui, provider, bus, commands, cwd, loop, policy,
    getSession: () => session,
    isBusy: () => bridge.busy, // Day 18: `idle` commands (/new, /resume, /compact) refuse to run mid-run
    newSession: async () => {
      bus.emit(EVENTS.SESSION_SHUTDOWN, { sessionId: session.id });
      session = SessionManager.create({ cwd, model: provider.model, dir: paths.sessions });
      bus.emit(EVENTS.SESSION_START, { sessionId: session.id });
      return session;
    },
    openSession: async (file) => {
      const opened = await SessionManager.open(file, { onWarn: (m) => ui.printSystem(m) });
      bus.emit(EVENTS.SESSION_SHUTDOWN, { sessionId: session.id });
      session = opened;
      bus.emit(EVENTS.SESSION_START, { sessionId: session.id });
      return session;
    },
    listSessions: sessionsHere,
    quit: (code = 0) => app.stop(code),
    persistModel,
  };
  commands.register(resumeCommand());
  commands.register(permissionsCommand());

  const bridge = new UIBridge({
    bus, loop, ui,
    // Resume feeds HISTORY, not pixels: the model sees the session's active path.
    getHistory: () => session.getMessages(),
    // Auto-save: after every run (and a run that failed partway), its messages are appended to the session file.
    onRunComplete: async ({ newMessages }) => {
      await session.appendMessages(newMessages);
    },
    onCommand: async (line) => {
      const { output: text } = await commands.handle(line, ctx);
      if (text) for (const l of text.split('\n')) ui.printSystem(l);
    },
    transformInput: attachRefs,
  });

  // Day 22: extensions — in-process code, so project ones sit behind the trust gate.
  const loader = new ExtensionLoader({
    cwd, registry, commands, bus, ui,
    submit: (content) => bridge.submit(content),
    appendNote: (content) => session.appendMessage({ role: 'user', content }),
    onWarn: (m) => ui.printSystem(m),
  });
  const trustStore = new TrustStore(paths.trustedProjects);

  async function loadExtensions() {
    if (extensions.loadGlobal !== false) await loader.loadDir(paths.extensions, { source: 'global' });
    await loadProjectExtensions({
      dir: projectPaths(cwd).extensions, projectRoot: cwd, loader, trustStore,
      ask: (q) => ui.ask(q), interactive, allowProjectExtensions: extensions.allowProjectExtensions,
      notify: (m) => ui.printSystem(m),
    });
    for (const file of extensions.files ?? []) await loader.loadFile(file, { source: 'cli' });
    const names = loader.list().map((e) => e.name);
    if (names.length) ui.printSystem(`extensions: ${names.join(', ')}`);
  }

  // Day 23: MCP servers — starting one runs a program, so they come from YOUR config only.
  /** @type {Map<string, { client: McpClient, tools: string[], unregister: () => void }>} */
  const mcp = new Map();
  async function connectMcpServers() {
    for (const [name, cfg] of Object.entries(mcpServers)) {
      const client = new McpClient({ name, command: cfg.command, args: cfg.args, env: cfg.env, cwd: cfg.cwd ?? cwd, onLog: () => {} });
      try {
        await client.start();
        const { names, unregister } = await registerMcpTools(registry, client, { onWarn: (m) => ui.printSystem(m) });
        mcp.set(name, { client, tools: names, unregister });
        ui.printSystem(`mcp ${name}: ${names.length} tools (${client.era} protocol ${client.protocolVersion})`);
      } catch (err) {
        ui.printSystem(`mcp ${name} failed to start: ${err.message}`);
        await client.close().catch(() => {});
      }
    }
  }
  ctx.mcp = mcp;
  commands.register({
    name: 'mcp',
    description: 'List connected MCP servers and their tools',
    handler: () => (mcp.size ? [...mcp].map(([n, m]) => `${n} (${m.client.era} ${m.client.protocolVersion}): ${m.tools.join(', ')}`).join('\n') : 'No MCP servers configured.'),
  });

  // Day 24: context — project instructions, skills, a deterministic system prompt, a budget.
  const context = { instructions: [], skills: [] };
  async function loadContext() {
    context.instructions = await loadProjectInstructions(cwd, { globalFile: `${paths.base}/AGENTS.md` });
    context.skills = await discoverSkills(
      [{ dir: paths.skills, source: 'user' }, { dir: projectPaths(cwd).skills, source: 'project' }],
      { onWarn: (m) => ui.printSystem(m) },
    );
    if (context.skills.length && !registry.getTool('load_skill')) registry.registerTool(createLoadSkillTool(() => context.skills));
    const found = [...context.instructions.map((i) => i.path.split('/').pop()), ...(context.skills.length ? [`${context.skills.length} skill(s)`] : [])];
    if (found.length) ui.printSystem(`context: ${found.join(', ')}`);
  }
  const currentSystemPrompt = () => buildSystemPrompt({
    cwd, userPrompt, instructions: context.instructions, skills: context.skills,
    toolNames: registry.toProviderTools().map((t) => t.name),
  });
  loop.systemPrompt = currentSystemPrompt;

  /** The effective window, cached per model (getModelInfo is an HTTP call). */
  const infoCache = new Map();
  async function currentLimit() {
    if (!infoCache.has(provider.model)) infoCache.set(provider.model, await provider.getModelInfo());
    return effectiveContextLimit(infoCache.get(provider.model).contextLimit, contextLimitCap);
  }

  /** Tokens in use right now, and the window they must fit in. */
  async function contextStatus() {
    const limit = await currentLimit();
    const systemPrompt = currentSystemPrompt();
    const specs = registry.toProviderTools();
    const system = estimateTokens(systemPrompt);
    const tools = estimateToolTokens(specs);
    // a measured promptTokens already includes system + tools, so history is what is left over
    const { tokens } = calibratedContextTokens({ systemPrompt, messages: session.getMessages(), tools: specs });
    return computeBudget({ limit, system, tools, history: Math.max(0, tokens - system - tools) });
  }
  ctx.contextStatus = contextStatus;

  // Day 25: compaction — checked before EVERY model call, and on demand with /compact.
  const compaction = { enabled: true, keepMessages: 6, ...compactionOpts };
  async function compactNow({ force = false } = {}) {
    const limit = await currentLimit();
    // the compacted text must be SMALL relative to the window: ~20% of it (4 bytes ≈ 1 token)
    const r = await session.compact({ keepMessages: compaction.keepMessages, maxBytes: Math.floor(limit * 4 * 0.2) });
    if (r) {
      bus.emit(EVENTS.COMPACTION, { dropped: r.dropped, kept: r.kept });
      ui.printSystem(`Compacted ${r.dropped} messages${force ? '' : ' (context was over 80%)'}`);
    }
    return r;
  }
  let warnedFull = false;
  /** @type {NonNullable<import('./agent/agent-schemas.js').AgentOptions['beforeModelCall']>} */
  const manageContext = async ({ history, newMessages, systemPrompt, tools }) => {
    if (!compaction.enabled) return undefined;
    const limit = await currentLimit();
    let effectiveHistory = history;
    const over = () => shouldCompact(calibratedContextTokens({ systemPrompt, messages: [...effectiveHistory, ...newMessages], tools }).tokens, limit);
    if (!over()) return undefined;
    const r = await compactNow();
    if (r) effectiveHistory = session.getMessages();
    // Still over budget? Then THIS run is the weight (one request, many big tool reads). Shorten its older
    // tool results in place: every call/result pair is kept, but bulky old output becomes a re-readable note.
    if (over()) {
      const n = shortenOldToolResults(newMessages);
      if (n > 0) ui.printSystem(`Shortened ${n} earlier tool result${n > 1 ? 's' : ''} to fit the window — read the file(s) again if needed`);
      else if (!warnedFull) { ui.printSystem('context is nearly full and this single run is too large to shrink further'); warnedFull = true; }
    }
    return r ? effectiveHistory : undefined;
  };

  // Day 24: the server's own count also tells you when IT cut the prompt (silently, HTTP 200). Estimate what
  // is about to be sent, compare with promptTokens after the call, and warn once per run. Provider-independent:
  // it covers Ollama's /api/chat and /v1 alike, and a huge paste or attachment that compaction can't touch.
  let sentEstimate = 0;
  let warnedTruncation = false;
  loop.beforeModelCall = async (call) => {
    const replaced = await manageContext(call);
    sentEstimate = estimateTotalContext({ systemPrompt: call.systemPrompt, messages: [...(replaced ?? call.history), ...call.newMessages], tools: call.tools });
    return replaced;
  };
  bus.on(EVENTS.AGENT_START, () => { warnedTruncation = false; });
  bus.on(EVENTS.TURN_END, ({ usage }) => {
    if (warnedTruncation || !truncationSuspected(sentEstimate, usage?.promptTokens)) return;
    warnedTruncation = true;
    ui.printSystem(`the model saw only ~${usage.promptTokens} of ~${sentEstimate} prompt tokens: the server cut the prompt to fit its window. Raise contextWindow (or the server's), send less, or /compact.`);
  });
  commands.register({
    name: 'compact',
    description: 'Compact the conversation now (keeps the most recent messages)',
    idle: true,
    handler: async () => ((await compactNow({ force: true })) ? undefined : 'Nothing to compact yet.'),
  });
  commands.register({
    name: 'context',
    description: 'Show how the context window is being used',
    handler: async () => formatBudget(await contextStatus()),
  });

  // Day 26: a log line for everything worth knowing later (to the log FILE — never stdout).
  if (logger) {
    const log = logger.child('app');
    bus.on(EVENTS.SESSION_START, ({ sessionId }) => log.info(`session ${sessionId} start (model ${provider.model})`));
    bus.on(EVENTS.TOOL_CALL_START, ({ name, arguments: a }) => log.debug(`tool ${name} ${JSON.stringify(a).slice(0, 300)}`));
    bus.on(EVENTS.TOOL_RESULT, ({ name, isError, content }) => { if (isError) log.warn(`tool ${name} error: ${content.slice(0, 300)}`); });
    bus.on(EVENTS.TOOL_APPROVAL_RESULT, ({ id, approved }) => log.info(`approval ${id} ${approved ? 'granted' : 'denied'}`));
    bus.on(EVENTS.COMPACTION, ({ dropped, kept }) => log.info(`compaction dropped=${dropped} kept=${kept}`));
    bus.on(EVENTS.ERROR, ({ message, cause }) => log.error(cause instanceof Error ? cause : message));
  }

  let prepared = false;
  async function prepare() {
    if (prepared) return;
    prepared = true;
    await loadExtensions();
    await connectMcpServers();
    await loadContext();
  }

  const app = {
    bus, registry, provider, loop, ui, bridge, printer, commands, ctx, paths, policy, gate, loader, trustStore, mcp, context, contextStatus, compactNow,
    /**
     * Headless: one prompt, one answer, no readline (Day 26's -p). The session is saved like any other.
     * @param {string} prompt
     * @param {{ resume?: 'new'|'last', signal?: AbortSignal }} [opts]
     */
    async runOnce(prompt, { resume = 'new', signal } = {}) {
      await prepare();
      const last = resume === 'last' ? await lastSessionHere() : null;
      if (last) await ctx.openSession(last.path);
      else bus.emit(EVENTS.SESSION_START, { sessionId: session.id });
      try {
        const result = await loop.run(await attachRefs(prompt), session.getMessages(), { signal });
        // the same rules as the bridge (Day 15): an interrupted run says so; a failed one keeps what it did
        /** @type {import('./shared/message-schemas.js').AgentMessage[]} */
        const kept = [...result.newMessages];
        if (result.aborted) kept.push({ role: 'user', content: INTERRUPTED_NOTE });
        await session.appendMessages(kept);
        return result;
      } catch (err) {
        const partial = /** @type {any} */ (err)?.newMessages;
        if (partial?.length > 1) await session.appendMessages(partial);
        throw err;
      } finally {
        await session.flush();
      }
    },
    get session() { return session; },
    stopped: false,
    exitCode: 0,
    /** @param {{ resume?: 'ask' | 'last' | 'new' | 'pick' }} [opts] */
    async start({ resume = 'ask' } = {}) {
      printer.printSystem(`agent-harness · ${provider.model} · ${cwd}`);
      printer.printSystem(`Ctrl+C aborts a run (twice exits) · /help lists commands · permissions: ${policy.mode}`);
      ui.start({ showPrompt: false });
      await prepare();
      if (resume === 'pick') {
        bus.emit(EVENTS.SESSION_START, { sessionId: session.id });
        const { output: text } = await commands.handle('/resume', ctx);
        if (text) ui.printSystem(text);
        ui.showPrompt();
        return;
      }
      const last = resume === 'new' ? null : await lastSessionHere();
      if (last && (resume === 'last' || (await ui.ask('  resume last session? [y/N] ')).trim().toLowerCase() === 'y')) {
        await ctx.openSession(last.path);
        ui.printSystem(`resumed ${session.id.slice(0, 8)} · ${session.getMessages().length} messages`);
      } else {
        bus.emit(EVENTS.SESSION_START, { sessionId: session.id });
      }
      ui.showPrompt();
    },
    /** @param {number} [code] */
    stop(code = 0) {
      if (app.stopped) return;
      app.stopped = true;
      app.exitCode = code;
      bus.emit(EVENTS.SESSION_SHUTDOWN, { sessionId: session.id });
      loader.unloadAll();
      for (const { client, unregister } of mcp.values()) { unregister(); void client.close(); }
      bridge.abort();
      bridge.dispose();
      ui.stop();
      (onExit ?? ((c) => { process.exitCode = c; }))(code);
    },
  };
  return app;
}

/** /resume — pick a saved session; empty answer cancels. (Day 19) */
function resumeCommand() {
  return {
    name: 'resume',
    usage: '/resume [number]',
    description: 'Resume a session saved in this folder',
    idle: true,
    handler: async ([pick], ctx) => {
      const sessions = (await ctx.listSessions()).filter((s) => s.id !== ctx.getSession().id).slice(0, 15);
      if (!sessions.length) return 'No other saved sessions in this folder.';
      let answer = pick;
      if (!answer) {
        sessions.forEach((s, i) => ctx.ui.printSystem(`${String(i + 1).padStart(2)}. ${s.updatedAt.slice(0, 16).replace('T', ' ')} · ${s.id.slice(0, 8)} · ${s.model}${s.name ? ` · ${s.name}` : ''}`));
        answer = (await ctx.ui.ask('  resume which? (number, empty to cancel) ')).trim();
      }
      if (!answer) return 'cancelled';
      const chosen = sessions[Number(answer) - 1];
      if (!chosen) return `No session number ${answer}.`;
      const s = await ctx.openSession(chosen.path);
      const msgs = s.getMessages();
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user' && m.content !== INTERRUPTED_NOTE);
      return `resumed ${s.id.slice(0, 8)} · ${msgs.length} messages${lastUser ? ` · last: "${lastUser.content.slice(0, 60)}"` : ''}`;
    },
  };
}

/** /permissions — show or change the policy for this session. (Day 20) */
function permissionsCommand() {
  return {
    name: 'permissions',
    aliases: ['perm'],
    usage: '/permissions [mode <m> | allow <rule> | deny <rule>]',
    description: 'Show or change permission mode and rules (this session only)',
    handler: ([action, ...rest], ctx) => {
      const value = rest.join(' ');
      if (action === 'mode' && value) ctx.policy.setMode(value);
      else if (action === 'allow' && value) ctx.policy.addSessionRule(value);
      else if (action === 'deny' && value) ctx.policy.deny.push(value);
      else if (action) return 'usage: /permissions [mode <default|read-only|accept-edits|yolo> | allow <rule> | deny <rule>]';
      return ctx.policy.describe();
    },
  };
}
