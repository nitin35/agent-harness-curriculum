// .vitepress/theme/runner/sandbox.js — run a snippet where it can't touch the page.
//
// Each run gets a fresh, hidden <iframe sandbox="allow-scripts">. Without allow-same-origin its origin is
// opaque: code in it can't read the site's storage (your notes), cookies or DOM. The iframe starts a
// Worker, so a runaway loop blocks only the worker, and removing the iframe ends everything.
// The snippet runs as an ES module (strict mode, top-level await), like *run this in a file*.
import { instrument } from './instrument.js';
import inspectSource from './inspect.js?raw';

/** Runs inside the worker: console capture, REPL-style echo, timer tracking, then the snippet. */
const PRELUDE = `
${inspectSource.replace(/^export /gm, '')}
const post = (m) => postMessage(m);
const show = (args) => args.map((a) => (typeof a === 'string' ? a : inspect(a))).join(' ');
for (const level of ['log', 'info', 'debug', 'warn', 'error', 'table', 'dir']) {
  console[level] = (...args) => post({ type: 'log', level, text: show(args) });
}
// A pending promise has nothing to show yet (its result arrives through .then or await): skip it.
globalThis.__show = (line, value) => { if (value !== undefined && !(value instanceof Promise)) post({ type: 'echo', line, text: inspect(value) }); };
globalThis.__fail = (line, err) => post({ type: 'echo-error', line, text: describeError(err) });

// The run is over when the module has finished and no timers are left.
const timers = new Set();
let evaluated = false;
// Bound to the global: called as native.setTimeout(...), they would throw "Illegal invocation".
const native = { setTimeout: setTimeout.bind(globalThis), clearTimeout: clearTimeout.bind(globalThis), setInterval: setInterval.bind(globalThis), clearInterval: clearInterval.bind(globalThis) };
const settle = () => native.setTimeout(() => { if (evaluated && timers.size === 0) post({ type: 'done' }); }, 0);
globalThis.setTimeout = (fn, ms, ...args) => {
  const id = native.setTimeout(() => { timers.delete(id); try { typeof fn === 'function' ? fn(...args) : null; } finally { settle(); } }, ms);
  timers.add(id);
  return id;
};
globalThis.clearTimeout = (id) => { timers.delete(id); native.clearTimeout(id); settle(); };
globalThis.setInterval = (fn, ms, ...args) => { const id = native.setInterval(fn, ms, ...args); timers.add(id); return id; };
globalThis.clearInterval = (id) => { timers.delete(id); native.clearInterval(id); settle(); };

addEventListener('error', (e) => { e.preventDefault(); post({ type: 'error', text: describeError(e.error ?? e.message) }); });
addEventListener('unhandledrejection', (e) => { e.preventDefault(); post({ type: 'error', text: 'Uncaught (in promise) ' + describeError(e.reason) }); });

onmessage = async ({ data }) => {
  const url = URL.createObjectURL(new Blob([data.code], { type: 'text/javascript' }));
  try { await import(url); } catch (err) { post({ type: 'error', text: describeError(err) }); }
  evaluated = true;
  settle();
};
`;

const FRAME = `<!doctype html><meta charset="utf-8"><script>
addEventListener('message', (e) => {
  if (e.source !== parent || e.data?.type !== 'run') return;
  // A classic worker: browsers refuse module workers from blob: URLs in an opaque origin. The snippet
  // itself is still loaded with import(), so it runs as a real ES module.
  const worker = new Worker(URL.createObjectURL(new Blob([e.data.prelude], { type: 'text/javascript' })));
  worker.onmessage = (m) => parent.postMessage(m.data, '*');
  worker.onerror = (err) => { err.preventDefault(); parent.postMessage({ type: 'error', text: err.message || 'the sandbox could not start' }, '*'); };
  worker.postMessage({ code: e.data.code });
});
parent.postMessage({ type: 'ready' }, '*');
<\/script>`;

/**
 * @param {string} source  the snippet as written
 * @param {{ onEvent: (e: { type: string, text?: string, line?: number, level?: string }) => void, timeoutMs?: number }} opts
 * @returns {Promise<{ status: 'done' | 'timeout' | 'syntax-error', ms: number }>}
 */
export function runSnippet(source, { onEvent, timeoutMs = 5000 }) {
  const started = performance.now();
  const prepared = instrument(source);
  if (prepared.error) {
    onEvent({ type: 'error', text: `SyntaxError: ${prepared.error.message}` });
    return Promise.resolve({ status: 'syntax-error', ms: 0 });
  }
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.display = 'none';
    frame.srcdoc = FRAME;
    let timer;
    const finish = (status) => {
      clearTimeout(timer);
      removeEventListener('message', onMessage);
      frame.remove(); // ends the worker too
      resolve({ status, ms: Math.round(performance.now() - started) });
    };
    const onMessage = (e) => {
      if (e.source !== frame.contentWindow) return; // only this run's sandbox
      const data = e.data ?? {};
      if (data.type === 'ready') {
        frame.contentWindow.postMessage({ type: 'run', prelude: PRELUDE, code: prepared.code }, '*');
        timer = setTimeout(() => finish('timeout'), timeoutMs);
      } else if (data.type === 'done') {
        finish('done');
      } else {
        onEvent(data);
      }
    };
    addEventListener('message', onMessage);
    document.body.appendChild(frame);
  });
}
