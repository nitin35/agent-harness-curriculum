// src/config/error-handler.js — every failure ends in a sentence a human can act on (Day 26).
import { HarnessError } from '../shared/errors.js';
import { sanitizeForTerminal } from '../ui/printer.js';

/**
 * 'user'     — bad flag / bad setting: say what is wrong, show usage, no stack
 * 'provider' — server down, model missing: give the fix ("is Ollama running? (`ollama serve`)")
 * 'internal' — a bug: full stack to the log file, one apologetic line on stderr
 * @returns {'user'|'provider'|'internal'}
 */
export function categorizeError(err) {
  if (err instanceof HarnessError || typeof err?.category === 'string') return err.category;
  const code = err?.cause?.code ?? err?.code;
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') return 'provider';
  return 'internal';
}

/** The one line printed on stderr. @param {unknown} err @param {{ logFile?: string }} [opts] */
export function formatError(err, { logFile } = {}) {
  // error text can carry a server's words or a repo-chosen name: sanitize it, it goes to your terminal (Day 27)
  return sanitizeForTerminal(describeError(err, { logFile }));
}

/** @param {any} err @param {{ logFile?: string }} [opts] */
function describeError(err, { logFile } = {}) {
  const category = categorizeError(err);
  if (category === 'internal') return `internal error: ${err?.message ?? err}${logFile ? ` (details in ${logFile})` : ''}`;
  if (category === 'provider' && !(err instanceof HarnessError)) return `${err?.message ?? err} — is Ollama running? (\`ollama serve\`)`;
  return `${err?.message ?? err}${err?.hint ? ` — ${err.hint}` : ''}`;
}

/**
 * Route uncaught exceptions and unhandled rejections through one path:
 * log the stack, print one line, run the shutdown helper (restores the terminal), set exitCode = 1.
 * @param {{ logger: { error: (m: unknown) => void }, logFile?: string, shutdown: (code: number) => void, stderr?: { write: (s: string) => unknown } }} opts
 * @returns {() => void} uninstall
 */
export function installErrorHandler({ logger, logFile, shutdown, stderr = process.stderr }) {
  const handleFatal = (err) => {
    logger.error(err instanceof Error ? err : new Error(String(err)));
    stderr.write(`${formatError(err, { logFile })}\n`);
    shutdown(1);
  };
  process.on('uncaughtException', handleFatal);
  process.on('unhandledRejection', handleFatal);
  return () => {
    process.off('uncaughtException', handleFatal);
    process.off('unhandledRejection', handleFatal);
  };
}
