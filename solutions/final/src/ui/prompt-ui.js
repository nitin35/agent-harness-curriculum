// src/ui/prompt-ui.js — the ONLY owner of stdin (Day 15; ask() Days 19–20; completer + multi-line Day 28).
import * as readline from 'node:readline/promises';
import { EVENTS } from '../shared/events.js';
import { sanitizeForTerminal } from './printer.js';

/**
 * A command is '/' and a name that ends at whitespace or the end of the line: '/help', '/model 2'.
 * '/Users/me/app.js why?' is a MESSAGE that starts with a path (dragging a file into a terminal types one).
 * Day 18's command parser uses the same rule.
 */
const COMMAND_LINE = /^\/[A-Za-z][\w-]*(?:\s|$)/;

/**
 * Policies (decided Day 15):
 *  - Ctrl+C while busy → emit `abort` (first press), exit on the second press. Ctrl+C while idle → exit 130.
 *  - Input typed while busy is still emitted; the bridge QUEUES it (rejection is the acceptable floor).
 *  - One line per Enter. Multi-line input: a line that is exactly <<< starts a block; the next <<< sends it.
 *    (Shift+Enter is not possible without raw mode — and raw mode is out of scope.)
 */
export class PromptUI {
  /**
   * @param {{
   *   input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream,
   *   printer: import('./printer.js').Printer, bus: import('../events/event-bus.js').EventBus,
   *   prompt?: string, terminal?: boolean,
   *   onExit?: (code: number) => void,
   *   completer?: (line: string) => Promise<[string[], string]> | [string[], string],
   * }} opts
   */
  constructor({ input = process.stdin, output = process.stdout, printer, bus, prompt = '> ', terminal, onExit, completer }) {
    this.input = input;
    this.output = output;
    this.printer = printer;
    this.bus = bus;
    this.promptText = prompt;
    this.terminal = terminal ?? Boolean(/** @type {any} */ (output).isTTY);
    this.onExit = onExit ?? ((code) => { this.stop(); process.exit(code); });
    this.completer = completer;
    this.busy = false;
    this.rl = null;
    this.#interrupts = 0;
    this.#midLine = false;
  }

  #interrupts;
  #midLine; // true while a streamed chunk left the cursor mid-line
  #streamKind = null; // 'text' | 'thinking' while a streamed block is open
  #multiline = null; // string[] while collecting a <<< … <<< block

  /** @param {{ showPrompt?: boolean }} [opts] pass false when you will ask() something first */
  start({ showPrompt = true } = {}) {
    if (this.rl) return;
    this.rl = readline.createInterface({
      input: this.input, output: this.output, terminal: this.terminal,
      ...(this.completer ? { completer: this.completer } : {}),
    });
    this.rl.setPrompt(this.promptText);
    this.rl.on('line', (line) => this.#onLine(line));
    this.rl.on('SIGINT', () => this.handleInterrupt());
    this.rl.on('close', () => { this.rl = null; this.onExit(0); });
    if (showPrompt) this.showPrompt();
  }

  /** Release stdin so the process can exit. Safe to call twice. */
  stop() {
    const rl = this.rl;
    this.rl = null;
    if (rl) { rl.removeAllListeners('close'); rl.close(); }
  }

  setBusy(busy) {
    this.busy = busy;
    this.#interrupts = 0;
  }

  /** Re-pose the prompt (after output, or when a run ends). */
  showPrompt() {
    if (!this.rl || this.busy) return;
    this.#endLine();
    this.rl.prompt(true);
  }

  /**
   * Ask one question through the SAME readline (single owner). Used by /resume, the trust prompt and approvals.
   * @param {string} question
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<string>} the answer ('' if aborted or the UI is stopped)
   */
  ask(question, { signal } = {}) {
    if (!this.rl) return Promise.resolve('');
    this.#endLine();
    // the question can carry untrusted text (file names in a trust prompt, tool arguments): sanitize at the sink
    return this.rl.question(sanitizeForTerminal(question), { signal }).catch(() => '');
  }

  /** Ctrl+C. Public so tests can call it without a TTY. */
  handleInterrupt() {
    if (this.busy && this.#interrupts === 0) {
      this.#interrupts++;
      this.bus.emit(EVENTS.ABORT, {});
      this.printSystem('aborting — press Ctrl+C again to exit');
      return;
    }
    this.onExit(130); // 130 = 128 + SIGINT, the conventional exit code
  }

  // ---- output helpers (all output goes through the Printer) ----
  printAssistant(text) { this.#endLine(); this.printer.printAssistant(text); }
  printTool(name, text) { this.#endLine(); this.printer.printTool(name, text); }
  printSystem(text) { this.#endLine(); this.printer.printSystem(text); }
  printError(text) { this.#endLine(); this.printer.printError(text); }

  /** Streamed chunk (no newline). `kind` 'text' or 'thinking'. Switching kind starts a new line. */
  writeChunk(text, kind = 'text') {
    if (this.#streamKind !== kind) {
      this.#endLine();
      this.printer.write(kind === 'text' ? 'agent> ' : '  ', kind === 'thinking' ? 'dim' : undefined);
      this.#streamKind = kind;
    }
    this.printer.write(text, kind === 'thinking' ? 'dim' : undefined);
    this.#midLine = !text.endsWith('\n');
  }

  /** Finish a streamed line, if one is open. */
  endStream() { this.#endLine(); }

  #endLine() {
    if (this.#midLine) { this.printer.write('\n'); this.#midLine = false; }
    this.#streamKind = null;
  }

  #onLine(raw) {
    if (raw.trim() === '<<<') {
      if (this.#multiline === null) {
        this.#multiline = [];
        this.printSystem('multi-line mode — finish with a line containing only <<<');
        return;
      }
      const text = this.#multiline.join('\n');
      this.#multiline = null;
      if (text.trim()) this.bus.emit(EVENTS.USER_MESSAGE, { content: text });
      else this.showPrompt();
      return;
    }
    if (this.#multiline !== null) { this.#multiline.push(raw); return; }

    const line = raw.trim();
    if (!line) { this.showPrompt(); return; }
    // The bridge re-poses the prompt when the run or command finishes.
    if (COMMAND_LINE.test(line)) this.bus.emit(EVENTS.COMMAND, { line });
    else this.bus.emit(EVENTS.USER_MESSAGE, { content: line });
  }
}
