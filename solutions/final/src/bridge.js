// src/bridge.js — UIBridge: wires bus ↔ loop ↔ UI (Day 15; commands Day 18; sessions Day 19).
import { EVENTS } from './shared/events.js';
import { sanitizeForTerminal } from './ui/printer.js';

/**
 * The bridge holds exactly one piece of state — busy (plus the queue that implies) — and translates:
 *   UI events   (user_message, abort, command) → loop.run / controller.abort / command handler
 *   core events (text_delta, tool_result, …)   → UI output
 * Every way a run can end (answer, abort, error) goes through ONE teardown that restores the prompt
 * and drains the queue.
 */
/**
 * Added to history after an interrupted run (Day 15). Without it the model sees an unfinished task and tends
 * to pick it up again on your next message; Claude Code uses the same words.
 */
export const INTERRUPTED_NOTE = '[Request interrupted by user]';

/** @typedef {import('./shared/message-schemas.js').AgentMessage} AgentMessage */

export class UIBridge {
  /**
   * @param {{
   *   bus: import('./events/event-bus.js').EventBus,
   *   loop: import('./agent/agent-loop.js').AgentLoop,
   *   ui: import('./ui/prompt-ui.js').PromptUI,
   *   getHistory?: () => import('./shared/message-schemas.js').AgentMessage[],
   *   onRunComplete?: (run: { newMessages: import('./shared/message-schemas.js').AgentMessage[], aborted?: boolean, failed?: boolean }) => void | Promise<void>,
   *   onCommand?: (line: string) => void | Promise<void>,
   *   transformInput?: (content: string) => Promise<string>,
   * }} opts
   */
  constructor({ bus, loop, ui, getHistory, onRunComplete, onCommand, transformInput }) {
    this.bus = bus;
    this.loop = loop;
    this.ui = ui;
    /** in-memory history until Day 19 swaps in the session */
    this.history = [];
    this.getHistory = getHistory ?? (() => this.history);
    this.onRunComplete = onRunComplete ?? ((result) => { this.history.push(...result.newMessages); });
    this.onCommand = onCommand ?? ((line) => this.ui.printSystem(`unknown command ${line} (slash commands arrive on Day 18)`));
    this.transformInput = transformInput ?? (async (c) => c);
    /** @type {string[]} */
    this.queue = [];
    this.busy = false;
    this.controller = null;
    this.streamedThisTurn = false;
    this.#idleWaiters = [];
    this.#unsubscribe = this.#subscribe();
  }

  #idleWaiters;
  #unsubscribe;

  /** Submit a user message: run now, or queue if a run is in flight. */
  submit(content) {
    if (this.busy) {
      this.queue.push(content);
      this.ui.printSystem(`queued (${this.queue.length} waiting)`);
      return;
    }
    void this.#run(content);
  }

  /** Ctrl+C: abort the run AND drop anything queued, so a second Ctrl+C really exits (Day 15). */
  abort() {
    if (this.queue.length) {
      const dropped = this.queue.splice(0);
      this.ui.printSystem(`not sent (${dropped.length} queued): ${dropped.map((m) => `"${oneLine(m, 40)}"`).join(', ')}`);
    }
    this.controller?.abort();
  }

  /** Resolves when no run is in flight and the queue is empty (handy in tests and for /quit). */
  whenIdle() {
    if (!this.busy && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  dispose() { this.#unsubscribe(); }

  async #run(content) {
    this.busy = true;
    this.ui.setBusy(true);
    this.controller = new AbortController();
    this.streamedThisTurn = false;
    try {
      const input = await this.transformInput(content);
      const result = await this.loop.run(input, this.getHistory(), { signal: this.controller.signal });
      /** @type {AgentMessage[]} */
      const newMessages = [...result.newMessages];
      if (result.aborted) newMessages.push({ role: 'user', content: INTERRUPTED_NOTE });
      await this.onRunComplete({ ...result, newMessages });
      this.ui.endStream();
      if (!this.streamedThisTurn && result.response) this.ui.printAssistant(result.response); // the Printer sanitizes
      if (result.aborted) this.ui.printSystem('aborted');
      if (result.warning) this.ui.printSystem(result.warning);
    } catch (err) {
      this.ui.endStream();
      const message = err?.message ?? String(err);
      this.bus.emit(EVENTS.ERROR, { message, cause: err });
      this.ui.printError(message);
      // A run that failed partway keeps what it did (a tool that ran!), so the model knows next time.
      // A lone user message is dropped: the error is on screen, and you can send it again.
      const partial = /** @type {any} */ (err)?.newMessages;
      if (partial?.length > 1) await this.#keepFailedRun(partial);
    } finally {
      this.#teardown();
    }
  }

  /** @param {AgentMessage[]} newMessages */
  async #keepFailedRun(newMessages) {
    try {
      await this.onRunComplete({ newMessages, failed: true });
    } catch (err) {
      this.ui.printError(`could not save the failed run: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Slash commands run immediately (even mid-run, so /quit works); the prompt returns afterwards. */
  async #command(line) {
    try {
      await this.onCommand(line);
    } catch (err) {
      this.ui.printError(err?.message ?? String(err));
    }
    if (!this.busy) this.ui.showPrompt();
  }

  /** The single exit path for every run. */
  #teardown() {
    this.busy = false;
    this.controller = null;
    this.ui.setBusy(false);
    const next = this.queue.shift();
    if (next !== undefined) {
      setImmediate(() => this.#run(next)); // next turn of the event loop: no deep recursion
      return;
    }
    this.ui.showPrompt();
    for (const resolve of this.#idleWaiters.splice(0)) resolve();
  }

  #subscribe() {
    const { bus, ui } = this;
    const offs = [
      bus.on(EVENTS.USER_MESSAGE, ({ content }) => this.submit(content)),
      bus.on(EVENTS.ABORT, () => this.abort()),
      bus.on(EVENTS.COMMAND, ({ line }) => this.#command(line)),
      bus.on(EVENTS.THINKING_DELTA, ({ content }) => { ui.writeChunk(content, 'thinking'); }),
      bus.on(EVENTS.TEXT_DELTA, ({ content }) => { this.streamedThisTurn = true; ui.writeChunk(content, 'text'); }),
      bus.on(EVENTS.TOOL_CALL_START, ({ name, arguments: args }) => ui.printTool(name, oneLine(JSON.stringify(args)))),
      bus.on(EVENTS.TOOL_RESULT, ({ content, isError }) => ui.printSystem(`${isError ? '✗ ' : '✓ '}${oneLine(content)}`)),
      bus.on(EVENTS.TURN_END, () => ui.endStream()),
    ];
    return () => offs.forEach((off) => off());
  }
}

/** First line, at most 120 characters, terminal-safe — for one-line status output of UNTRUSTED text. */
export function oneLine(text, max = 120) {
  const first = sanitizeForTerminal(String(text).split('\n')[0]);
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}
