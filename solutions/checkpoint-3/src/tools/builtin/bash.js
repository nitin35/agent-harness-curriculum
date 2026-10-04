// src/tools/builtin/bash.js — run a shell command (Day 11). Needs approval.
import { spawn } from 'node:child_process';
import { resolveInWorkspace } from '../workspace-path.js';
import { truncateText } from '../truncate.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;       // the model picks `timeout`, so the harness caps it
const KILL_GRACE_MS = 2_000;
const LEFTOVER_GRACE_MS = 500;        // after the shell exits, how long its output may take to close
const MAX_COLLECT_BYTES = 1024 * 1024; // per stream: keep the first 1 MiB and the last 1 MiB in memory
const BASH_HINT = 'Use a narrower command (grep, head, tail) to see more.';

/**
 * Which shell runs the command. Explicit binary + flag — never `shell: true` with interpolation.
 * POSIX: `sh -c <command>`. Windows: `cmd.exe /d /s /c <command>` (the course itself runs in WSL).
 */
export function defaultShell() {
  return process.platform === 'win32' ? { file: 'cmd.exe', args: ['/d', '/s', '/c'] } : { file: 'sh', args: ['-c'] };
}

/** One kill function per command still running, so nothing a command starts outlives the harness. */
const running = new Set();
let exitHookInstalled = false;

/**
 * Kill every command still running. Runs on process 'exit'; the app's shutdown path calls it too (Day 26),
 * because SIGTERM and SIGHUP end Node without an 'exit' event unless someone handles them.
 */
export function killAllCommands() {
  for (const kill of running) kill('SIGKILL');
  running.clear();
}

/**
 * @param {{ root: string, defaultTimeoutMs?: number, maxTimeoutMs?: number, shell?: { file: string, args: string[] } }} opts
 * @returns {import('../../shared/tool-schemas.js').ToolDefinition}
 */
export function createBashTool({ root, defaultTimeoutMs = DEFAULT_TIMEOUT_MS, maxTimeoutMs = MAX_TIMEOUT_MS, shell = defaultShell() }) {
  return {
    name: 'bash',
    label: 'Shell',
    description:
      'Run a shell command and return its stdout, stderr and exit code. The working directory is the ' +
      'workspace root unless `cwd` (relative to the root) is given. Commands are killed after `timeout` ms ' +
      `(default ${defaultTimeoutMs}, at most ${maxTimeoutMs}). Nothing keeps running after the command ` +
      'finishes: background processes (`&`, `nohup`) are stopped. Prefer narrow commands (grep, head) over huge output.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to run' },
        cwd: { type: 'string', description: 'Working directory relative to the workspace root' },
        timeout: { type: 'integer', description: `Timeout in milliseconds (at most ${maxTimeoutMs})` },
      },
      required: ['command'],
      additionalProperties: false, // invented arguments are refused by name (Day 9)
    },
    needsApproval: true,
    async execute({ command, cwd = '.', timeout }, { signal } = {}) {
      let dir;
      try {
        dir = resolveInWorkspace(root, /** @type {string} */ (cwd));
      } catch (err) {
        return { content: `Cannot run: ${err.message}`, isError: true };
      }
      if (signal?.aborted) return { content: 'Command not started: run aborted', isError: true };
      const timeoutMs = clampTimeout(timeout, defaultTimeoutMs, maxTimeoutMs);
      const r = await runCommand(shell, /** @type {string} */ (command), { cwd: dir, timeoutMs, signal });
      return formatResult(r);
    },
  };
}

/**
 * The model chooses the timeout, so the harness bounds it: a missing or nonsense value means the default,
 * and anything above the cap is capped. (setTimeout also overflows past 2^31-1 ms and fires after 1 ms.)
 */
export function clampTimeout(timeout, defaultTimeoutMs = DEFAULT_TIMEOUT_MS, maxTimeoutMs = MAX_TIMEOUT_MS) {
  const t = Number(timeout);
  if (!Number.isFinite(t) || t <= 0) return defaultTimeoutMs;
  return Math.min(t, maxTimeoutMs);
}

/**
 * Spawn the command in its own process group so timeout/abort can kill the whole tree
 * (`sh -c 'sleep 30'` would otherwise leave `sleep` running after `sh` dies).
 * @returns {Promise<{ stdout: string, stderr: string, code: number|null, killedBy: null|'timeout'|'abort'|'leftover', stdoutBytes: number, stderrBytes: number }>}
 */
export function runCommand(shell, command, { cwd, timeoutMs, signal }) {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const child = spawn(shell.file, [...shell.args, command], { cwd, detached: !isWindows, windowsHide: true });
    const out = collector();
    const err = collector();
    let killedBy = null;
    let graceTimer;
    let leftoverTimer;

    /** Signal the whole group. It works even after `sh` itself has exited, while anything it started lives on. */
    const signalTree = (sig) => {
      try {
        if (isWindows) child.kill(sig);
        else process.kill(-child.pid, sig); // negative pid = the whole process group
      } catch { /* the group is already gone */ }
    };
    const killTree = (reason) => {
      if (killedBy) return;
      killedBy = reason;
      signalTree('SIGTERM');
      graceTimer = setTimeout(() => signalTree('SIGKILL'), KILL_GRACE_MS);
      graceTimer.unref();
    };
    if (child.pid !== undefined) {
      running.add(signalTree);
      installExitHook();
    }

    const timer = setTimeout(() => killTree('timeout'), timeoutMs);
    const onAbort = () => killTree('abort');
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', out.push);
    child.stderr.on('data', err.push);
    child.on('error', (e) => err.push(Buffer.from(`failed to start: ${e.message}\n`)));
    // The shell has exited. Its output normally closes at once; if it doesn't, something it started in
    // the background still holds the pipes, and 'close' would wait for it forever. Stop the leftovers.
    child.on('exit', () => {
      leftoverTimer = setTimeout(() => killTree('leftover'), LEFTOVER_GRACE_MS);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(graceTimer);
      clearTimeout(leftoverTimer);
      signal?.removeEventListener('abort', onAbort);
      // Background processes that redirected their output (`nohup x > log &`) don't hold the pipes,
      // so 'close' came anyway. Nothing a command starts may outlive the call: stop them too.
      if (!isWindows && !killedBy && groupAlive(child.pid)) {
        killedBy = 'leftover';
        signalTree('SIGKILL');
      }
      running.delete(signalTree);
      resolve({ stdout: out.text(), stderr: err.text(), code, killedBy, stdoutBytes: out.total(), stderrBytes: err.total() });
    });
  });
}

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', killAllCommands);
}

/** Does any process in this group still exist? (Signal 0 checks without sending anything.) */
function groupAlive(pid) {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Keep the first and the last MAX_COLLECT_BYTES of a stream, so a huge output can't fill memory. */
function collector() {
  const head = [];
  let headBytes = 0;
  const tail = [];
  let tailBytes = 0;
  let total = 0;
  return {
    push: (chunk) => {
      total += chunk.length;
      if (headBytes < MAX_COLLECT_BYTES) {
        const take = chunk.subarray(0, MAX_COLLECT_BYTES - headBytes);
        head.push(take);
        headBytes += take.length;
        chunk = chunk.subarray(take.length);
      }
      if (chunk.length === 0) return;
      tail.push(chunk);
      tailBytes += chunk.length;
      while (tailBytes - tail[0].length >= MAX_COLLECT_BYTES) tailBytes -= tail.shift().length;
    },
    text: () => Buffer.concat([...head, ...tail]).toString('utf8'),
    total: () => total,
  };
}

/** Build the ToolResult. A non-zero exit is a result with isError, never an exception. */
export function formatResult({ stdout, stderr, code, killedBy, stdoutBytes, stderrBytes }) {
  // Command output puts errors and summaries last (test runners, compilers), so keep the head AND the tail.
  const show = (text, totalBytes) => truncateText(text, undefined, { keep: 'head+tail', hint: BASH_HINT, totalBytes });
  const so = show(stdout, stdoutBytes);
  const se = show(stderr, stderrBytes);
  const parts = [];
  // Put this one first: models weigh the start of a result most, and "&" makes them assume the process lives on.
  if (killedBy === 'leftover') parts.push('[NOTE: the background processes this command started (&, nohup) have been KILLED and are no longer running. Nothing keeps running after a command finishes.]');
  if (stdout) parts.push(so.content);
  if (stderr) parts.push(`[stderr]\n${se.content}`);
  if (killedBy === 'timeout') parts.push('[killed: timed out]');
  else if (killedBy === 'abort') parts.push('[killed: run aborted]');
  else if (code !== 0) parts.push(`[exit code ${code}]`);
  if (!stdout && !stderr && !killedBy && code === 0) parts.push('(no output)');
  return {
    content: parts.join('\n'),
    isError: killedBy !== null || code !== 0,
    details: { exitCode: code, killedBy, truncated: so.truncated || se.truncated, stdoutBytes, stderrBytes },
  };
}
