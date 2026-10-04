// src/config/logger.js — one line per event, to a file, never to stdout (Day 26).
import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_BYTES = 1024 * 1024; // rotate at 1 MiB, keep one old generation

/**
 * Line format (grep-able, one per event):  [2026-10-01T09:12:44.123Z] [info] [agent-loop] turn 2 finished
 * Writes are SYNCHRONOUS: the error handler and exit paths log right before the process ends, and an async
 * write scheduled there would never happen. At this volume, sync appends cost nothing.
 * @param {{ file: string, level?: keyof typeof LEVELS, now?: () => Date }} opts
 */
export function createLogger({ file, level = 'info', now = () => new Date() }) {
  let threshold = LEVELS[level] ?? LEVELS.info;
  let ready = false;

  function write(lvl, module, msg) {
    if (LEVELS[lvl] < threshold) return;
    try {
      if (!ready) { fs.mkdirSync(path.dirname(file), { recursive: true }); ready = true; }
      try { if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`); } catch { /* no file yet */ }
      const text = (msg instanceof Error ? (msg.stack ?? msg.message) : String(msg)).replace(/\r?\n/g, ' ⏎ ');
      fs.appendFileSync(file, `[${now().toISOString()}] [${lvl}] [${module}] ${text}\n`);
    } catch { /* logging must never crash the harness */ }
  }

  return {
    file,
    setLevel(l) { threshold = LEVELS[l] ?? threshold; },
    /** @param {string} module */
    child(module) {
      return {
        debug: (m) => write('debug', module, m),
        info: (m) => write('info', module, m),
        warn: (m) => write('warn', module, m),
        error: (m) => write('error', module, m),
      };
    },
  };
}
