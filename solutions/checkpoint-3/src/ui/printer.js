// src/ui/printer.js — boring, testable terminal output (Day 14). No raw mode, no cursor tricks.

const STYLES = { dim: [2, 22], bold: [1, 22], red: [31, 39], green: [32, 39], yellow: [33, 39], cyan: [36, 39] };

const ROLES = {
  user: { prefix: 'you> ', style: 'bold' },
  assistant: { prefix: 'agent> ', style: null },
  thinking: { prefix: '', style: 'dim' },
  tool: { prefix: '  ⚙ ', style: 'cyan' },
  system: { prefix: '  · ', style: 'dim' },
  error: { prefix: 'error> ', style: 'red' },
};

export class Printer {
  /**
   * @param {{ out?: NodeJS.WritableStream & { isTTY?: boolean }, color?: 'auto'|'always'|'never', env?: Record<string, string|undefined> }} [opts]
   */
  constructor({ out = process.stdout, color = 'auto', env = process.env } = {}) {
    this.out = out;
    // auto: colour only on a real terminal, and never when NO_COLOR is set (https://no-color.org)
    this.colorEnabled = color === 'always' || (color === 'auto' && Boolean(out.isTTY) && !env.NO_COLOR);
  }

  /** Wrap text in an ANSI style — or return it untouched when colour is off. */
  style(text, name) {
    if (!this.colorEnabled || !name || !STYLES[name]) return text;
    const [on, off] = STYLES[name];
    return `\x1b[${on}m${text}\x1b[${off}m`;
  }

  /** One complete line with a role prefix. */
  print(role, text) {
    const r = ROLES[role] ?? { prefix: `${role}> `, style: null };
    this.out.write(`${this.style(`${r.prefix}${text}`, r.style)}\n`);
  }

  /** Raw text without a newline — for streamed deltas. */
  write(text, styleName) {
    this.out.write(this.style(text, styleName));
  }

  printUser(text) { this.print('user', text); }
  printAssistant(text) { this.print('assistant', text); }
  printTool(name, text) { this.print('tool', `${name} ${text}`); }
  printSystem(text) { this.print('system', text); }
  printError(text) { this.print('error', text); }
}
