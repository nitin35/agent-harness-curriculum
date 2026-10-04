// src/cli/args-parser.js — a small, dependency-free argv parser (Day 5, wired Day 26).
import { UsageError } from '../shared/errors.js';

export { UsageError };

/**
 * @typedef {object} FlagDef
 * @property {string} name          key in `values` (e.g. 'version')
 * @property {string} long          long form including dashes (e.g. '--version')
 * @property {string} [short]       short form including dash (e.g. '-v')
 * @property {'boolean'|'string'} type
 * @property {boolean} [repeatable] string flags only: collect every occurrence into an array
 * @property {string} [description] shown by getUsage()
 * @property {string} [valueName]   placeholder shown by getUsage() (default 'value')
 */

/**
 * Parse argv (already sliced: no `node` / script path).
 * Supports `--flag`, `-f`, `--flag=value`, `--flag value`, repeatable flags,
 * positionals, and `--` (everything after it is positional).
 *
 * @param {string[]} argv
 * @param {FlagDef[]} flags
 * @returns {{ values: Record<string, string|boolean|string[]>, positionals: string[] }}
 */
export function parseArgs(argv, flags) {
  const byForm = new Map();
  for (const def of flags) {
    byForm.set(def.long, def);
    if (def.short) byForm.set(def.short, def);
  }

  /** @type {Record<string, string|boolean|string[]>} */
  const values = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (!token.startsWith('-') || token === '-') { positionals.push(token); continue; }

    const eq = token.startsWith('--') ? token.indexOf('=') : -1;
    const form = eq === -1 ? token : token.slice(0, eq);
    const def = byForm.get(form);
    if (!def) throw new UsageError(`Unknown option: ${token}`, { token });

    if (def.type === 'boolean') {
      if (eq !== -1) throw new UsageError(`Option ${def.long} does not take a value: ${token}`, { token });
      values[def.name] = true;
      continue;
    }

    let value;
    if (eq !== -1) value = token.slice(eq + 1);
    else {
      value = argv[i + 1];
      if (value === undefined) throw new UsageError(`Option ${def.long} needs a value`, { token });
      i++;
    }

    if (def.repeatable) {
      const list = /** @type {string[]} */ (values[def.name] ?? []);
      list.push(value);
      values[def.name] = list;
    } else {
      values[def.name] = value;
    }
  }
  return { values, positionals };
}

/**
 * Render a help screen that lists every form of every flag.
 * @param {FlagDef[]} flags
 * @param {{ name: string, description?: string, usage?: string }} info
 * @returns {string}
 */
export function getUsage(flags, info) {
  const rows = flags.map((def) => {
    const forms = [def.short, def.long].filter(Boolean).join(', ');
    const arg = def.type === 'string' ? ` <${def.valueName ?? 'value'}>` : '';
    const repeat = def.repeatable ? ' (repeatable)' : '';
    return { left: `${forms}${arg}`, right: `${def.description ?? ''}${repeat}` };
  });
  const width = Math.max(...rows.map((r) => r.left.length));
  const lines = [
    `Usage: ${info.usage ?? `${info.name} [options]`}`,
    ...(info.description ? ['', info.description] : []),
    '',
    'Options:',
    ...rows.map((r) => `  ${r.left.padEnd(width)}  ${r.right}`.trimEnd()),
  ];
  return lines.join('\n');
}
