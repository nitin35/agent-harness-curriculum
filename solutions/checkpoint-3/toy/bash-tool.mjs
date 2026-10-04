// toy/bash-tool.mjs — the toy's only tool (Day 2 module, Day 3 async + abort, Day 4 safe decoding + truncation).
import { spawn } from 'node:child_process';
import { truncateText } from '../src/tools/truncate.js';

export const bashToolSpec = {
  type: 'function',
  function: {
    name: 'bash',
    description: 'Run a shell command in the current directory and return its output.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The command to run' } },
      required: ['command'],
    },
  },
};

/**
 * Run a command without blocking the event loop. Abort (Ctrl+C) or the timeout kills it.
 * Never rejects: a failed or stopped command is still a result the model should see.
 * @param {string} command
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [opts]
 * @returns {Promise<string>}
 */
export function runBash(command, { signal, timeoutMs = 30_000 } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout, // Ctrl+C or too slow, whichever comes first
    });
    let out = '';
    // One streaming decoder per stream, so a character split across two chunks is joined, not turned into � (Day 4).
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (s) => { out += s; });
    child.stderr.on('data', (s) => { out += s; });
    // Abort and timeout both arrive as an AbortError; ask the timeout signal which one fired.
    child.on('error', (err) => resolve(
      timeout.aborted ? `(command timed out after ${timeoutMs / 1000} s)`
      : err.name === 'AbortError' ? '(command stopped: run aborted)'
      : `(command failed to start: ${err.message})`));
    // The toy has no `read` tool, so the truncation marker must not suggest one.
    child.on('close', (code) => resolve(truncateText(out || `(exit code ${code}, no output)`, 4000,
      { hint: 'Run a narrower command to see more.' }).content));
  });
}
