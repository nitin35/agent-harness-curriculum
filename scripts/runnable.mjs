// scripts/runnable.mjs — keep the site's runnable snippets honest.
//
//   node scripts/runnable.mjs --check   every ```js run block must run cleanly (CI)
//   node scripts/runnable.mjs --find    list unmarked ```js blocks that would run cleanly (candidates)
//
// A snippet runs the way the browser runner runs it: instrumented by the same instrument.js (each
// top-level expression echoes its value; a line that throws reports and the next line runs), as an ES
// module, in a context with browser-like globals only. No process, Buffer, require or node: imports.
//
// "Runs cleanly" means: it parses, it imports nothing, it finishes within 2 s, and every error it throws
// is one its own comments announce (a line like `o.a = 2   // TypeError: …`).
// Needs: node --experimental-vm-modules (the npm scripts pass it).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import util from 'node:util';
import { fileURLToPath } from 'node:url';
import { instrument } from '../.vitepress/theme/runner/instrument.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv.includes('--find') ? 'find' : 'check';
const verbose = process.argv.includes('--verbose');

/** Every fenced block in the course pages: { file, line, info, code }. */
function blocks() {
  const pages = fs.readdirSync(ROOT).filter((f) => /^(day-\d+|buffer-\d+|README|self-check-answers)\.md$/.test(f)).sort();
  const out = [];
  for (const file of pages) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const open = /^(\s*)(`{3,})(.*)$/.exec(lines[i]);
      if (!open) continue;
      const [, indent, fence, info] = open;
      const body = [];
      let j = i + 1;
      for (; j < lines.length && !new RegExp(`^\\s*${fence}\\s*$`).test(lines[j]); j++) body.push(lines[j].startsWith(indent) ? lines[j].slice(indent.length) : lines[j]);
      out.push({ file, line: i + 1, info: info.trim(), code: body.join('\n') });
      i = j;
    }
  }
  return out;
}

/** Run one snippet; resolves to { events, status }. */
async function run(source) {
  const events = [];
  const prepared = instrument(source);
  if (prepared.error) return { events: [{ type: 'error', name: 'SyntaxError', text: prepared.error.message }], status: 'syntax-error' };
  const show = (args) => args.map((a) => (typeof a === 'string' ? a : util.inspect(a))).join(' ');
  const timers = new Set();
  // A callback that throws is an uncaught error in the snippet, as in the browser: report it, don't crash.
  const guarded = (fn, args) => { try { fn(...args); } catch (err) { events.push({ type: 'error', name: err?.name, text: `${err?.name}: ${err?.message}` }); } };
  const st = (fn, ms, ...args) => { const id = setTimeout(() => { timers.delete(id); guarded(fn, args); }, ms); timers.add(id); return id; };
  const ct = (id) => { timers.delete(id); clearTimeout(id); };
  const si = (fn, ms, ...args) => { const id = setInterval(() => guarded(fn, args), ms); timers.add(id); return id; };
  const ci = (id) => { timers.delete(id); clearInterval(id); };
  const consoleShim = Object.fromEntries(['log', 'info', 'debug', 'warn', 'error', 'table', 'dir'].map((k) => [k, (...a) => events.push({ type: 'log', text: show(a) })]));
  const context = vm.createContext({
    console: consoleShim,
    setTimeout: st, clearTimeout: ct, setInterval: si, clearInterval: ci,
    queueMicrotask, structuredClone, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, AbortSignal,
    EventTarget, Event, atob, btoa, performance, crypto, Blob, DOMException,
    __show: (line, value) => { if (value !== undefined && !util.types.isPromise(value)) events.push({ type: 'echo', line, text: util.inspect(value) }); },
    __fail: (line, err) => events.push({ type: 'echo-error', line, name: err?.name, text: `${err?.name}: ${err?.message}` }),
  });
  const onRejection = (reason) => events.push({ type: 'error', name: reason?.name, text: `Uncaught (in promise) ${reason?.name}: ${reason?.message}` });
  process.on('unhandledRejection', onRejection);
  let status = 'done';
  try {
    const mod = new vm.SourceTextModule(prepared.code, { context, identifier: 'snippet.mjs' });
    await mod.link(() => { throw new Error('imports are not available in the browser runner'); });
    await mod.evaluate({ timeout: 2000 });
    const deadline = Date.now() + 2000;
    while (timers.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    if (timers.size) status = 'timeout';
    await new Promise((r) => setTimeout(r, 0));
  } catch (err) {
    if (/Script execution timed out/.test(err?.message)) status = 'timeout';
    else events.push({ type: 'error', name: err?.name, text: `${err?.name}: ${err?.message}` });
  } finally {
    for (const id of timers) { clearTimeout(id); clearInterval(id); }
    process.off('unhandledRejection', onRejection);
  }
  return { events, status };
}

/** Problems: errors the snippet's comments don't announce, a timeout, or imports. */
function problems(source, { events, status }) {
  const lines = source.split('\n');
  const announced = (name, line) => {
    const where = line ? [lines[line - 1] ?? ''] : lines;
    return where.some((l) => /\/\/.*\b\w*Error\b/.test(l) && (l.includes(name) || (!name && /Error/.test(l))));
  };
  const found = [];
  if (/^\s*(import|export)\s/m.test(source)) found.push('uses import/export');
  if (status === 'timeout') found.push('did not finish within 2 s');
  for (const e of events) {
    if (e.type === 'echo-error' && !announced(e.name, e.line)) found.push(`line ${e.line}: ${e.text}`);
    if (e.type === 'error' && !announced(e.name)) found.push(e.text);
  }
  return found;
}

const all = blocks();
const isJs = (b) => /^(js|javascript)\b/.test(b.info);
const marked = all.filter((b) => isJs(b) && /\brun\b/.test(b.info));
const targets = mode === 'check' ? marked : all.filter((b) => isJs(b) && !/\brun\b/.test(b.info));
let failures = 0;
const candidates = [];
for (const b of targets) {
  const result = await run(b.code);
  const found = problems(b.code, result);
  if (mode === 'check') {
    if (found.length) { failures++; console.log(`✗ ${b.file}:${b.line}\n    ${found.join('\n    ')}`); }
    else if (verbose) console.log(`✓ ${b.file}:${b.line}`);
  } else if (!found.length) {
    candidates.push(b);
    console.log(`${b.file}:${b.line}  ${result.events.length} result(s)  ${b.code.split('\n')[0].slice(0, 70)}`);
  } else if (verbose) {
    console.log(`  skip ${b.file}:${b.line}: ${found[0]}`);
  }
}
if (mode === 'check') {
  console.log(`${marked.length - failures} of ${marked.length} runnable blocks run cleanly.`);
  process.exitCode = failures ? 1 : 0;
} else {
  console.log(`\n${candidates.length} candidate block(s) of ${targets.length} unmarked js blocks.`);
}
