// src/commands/registry.js — slash commands as a dispatch table (Day 18).
//
// Parser rules (deliberately boring):
//   - a line is a command if it starts with '/' and a NAME that ends at whitespace or the end of the line:
//     '/help', '/model 2'. A bare '/' is not a command, and neither is '/Users/me/app.js why?' — that's a
//     message (dragging a file into a terminal types its path). PromptUI routes lines by the same rule.
//   - a NAME is a letter, then letters, digits, '_' or '-'. Names AND aliases must be NAMEs, so every
//     command /help advertises can actually be typed.
//   - arguments split on whitespace; "double quotes" group words into one argument
//   - no escape sequences, no nesting, no single quotes; an unclosed quote runs to end of line

const NAME = /^[A-Za-z][\w-]*$/;

/** @typedef {import('../shared/commands.js').CommandDefinition} CommandDefinition */

export class CommandRegistry {
  /** @type {Map<string, CommandDefinition>} name → definition */
  #byName = new Map();
  /** @type {Map<string, string>} alias → name */
  #aliases = new Map();

  /**
   * @param {CommandDefinition} def
   * @returns {() => void} unregister (Day 22's extensions use it)
   */
  register(def) {
    if (!def || typeof def.name !== 'string' || !NAME.test(def.name)) throw new TypeError(`invalid command name: ${def?.name}`);
    for (const a of def.aliases ?? []) if (!NAME.test(a)) throw new TypeError(`invalid alias /${a} for /${def.name}: it could never be typed`);
    if (typeof def.handler !== 'function') throw new TypeError(`command /${def.name} needs a handler`);
    for (const n of [def.name, ...(def.aliases ?? [])]) {
      if (this.#byName.has(n) || this.#aliases.has(n)) throw new Error(`a command named /${n} is already registered`);
    }
    this.#byName.set(def.name, def);
    for (const a of def.aliases ?? []) this.#aliases.set(a, def.name);
    return () => this.unregister(def.name);
  }

  unregister(name) {
    const def = this.#byName.get(name);
    if (!def) return false;
    this.#byName.delete(name);
    for (const a of def.aliases ?? []) this.#aliases.delete(a);
    return true;
  }

  /** Look up by name or alias. */
  get(name) {
    return this.#byName.get(name) ?? this.#byName.get(this.#aliases.get(name) ?? '');
  }

  /** In registration order (for /help). */
  list() { return [...this.#byName.values()]; }

  /**
   * @param {string} line
   * @returns {{ name: string, args: string[] } | null} null if the line is not a command
   */
  parse(line) {
    const m = /^\/([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/.exec(line.trim());
    if (!m) return null;
    return { name: m[1], args: splitArgs(m[2] ?? '') };
  }

  /**
   * Parse, look up, run. Never throws: unknown commands and handler errors come back as text.
   * @param {string} line
   * @param {import('../shared/commands.js').CommandContext} ctx
   * @returns {Promise<{ ok: boolean, output?: string }>}
   */
  async handle(line, ctx) {
    const parsed = this.parse(line);
    if (!parsed) return { ok: false, output: `Not a command: ${line}` };
    const def = this.get(parsed.name);
    if (!def) return { ok: false, output: `Unknown command: /${parsed.name}. Try /help.` };
    // Commands run immediately, even mid-run (so /quit always works). Ones that swap or rewrite the session
    // must not: the running conversation would land in the wrong place.
    if (def.idle && ctx.isBusy?.()) return { ok: false, output: `/${def.name} works between runs: wait for the answer, or press Ctrl+C first.` };
    try {
      const output = await def.handler(parsed.args, ctx);
      ctx.bus?.emit('command_run', { name: def.name, args: parsed.args });
      return { ok: true, output: typeof output === 'string' ? output : undefined };
    } catch (err) {
      return { ok: false, output: `/${def.name} failed: ${err?.message ?? err}` };
    }
  }
}

/** Whitespace split with "double quotes" grouping. */
export function splitArgs(text) {
  const args = [];
  let current = '';
  let inQuotes = false;
  let hasToken = false;
  for (const ch of text) {
    if (ch === '"') { inQuotes = !inQuotes; hasToken = true; continue; }
    if (!inQuotes && /\s/.test(ch)) {
      if (hasToken) { args.push(current); current = ''; hasToken = false; }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) args.push(current);
  return args;
}
