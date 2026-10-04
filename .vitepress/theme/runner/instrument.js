// .vitepress/theme/runner/instrument.js — make a snippet echo its results, REPL-style.
//
// The course's snippets are mostly lists of expressions with `// → value` comments, written for a Node
// REPL. Run as a module, they would print nothing. So every top-level expression statement becomes
//
//     try { __show(LINE, (EXPRESSION)); } catch (__e) { __fail(LINE, __e); }
//
// which keeps the code's own semantics: still a module (strict, top-level `await` allowed, `this` is
// undefined), no extra awaits (so event-loop ordering is unchanged), and a line that throws reports its
// error and lets the next line run, as the REPL does. Declarations are left alone: if one throws, the
// snippet stops, as a file would.
//
// Shared by the browser runner and by scripts/runnable.mjs, so CI checks exactly what readers run.
import { parse } from 'acorn';

/** Calls whose return value is noise (a timer id, undefined): run them, don't echo them. */
const QUIET_CALLS = new Set(['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask']);
const isQuiet = (expr) => expr.type === 'CallExpression' && expr.callee.type === 'Identifier' && QUIET_CALLS.has(expr.callee.name);

/**
 * @param {string} source
 * @returns {{ code: string, error: null } | { code: null, error: { name: 'SyntaxError', message: string, line: number } }}
 */
export function instrument(source) {
  let ast;
  try {
    ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true });
  } catch (err) {
    return { code: null, error: { name: 'SyntaxError', message: err.message, line: err.loc?.line ?? 0 } };
  }
  let out = '';
  let pos = 0;
  for (const node of ast.body) {
    if (node.type !== 'ExpressionStatement' || node.directive || isQuiet(node.expression)) continue;
    const line = node.loc.start.line;
    const expr = source.slice(node.expression.start, node.expression.end);
    out += source.slice(pos, node.start);
    out += `try { __show(${line}, (${expr})); } catch (__e) { __fail(${line}, __e); }`;
    pos = node.end;
  }
  out += source.slice(pos);
  return { code: out, error: null };
}
