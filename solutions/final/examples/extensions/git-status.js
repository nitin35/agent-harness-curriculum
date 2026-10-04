// examples/extensions/git-status.js — a real extension: read-only git_status, approval-gated git_commit.
// Install: copy into ~/.config/agent-harness/extensions/ (or --extension examples/extensions/git-status.js).
import { execFile } from 'node:child_process';

export const meta = { name: 'git-status', description: 'git status and git commit as tools' };

/** Run git with an ARGUMENT ARRAY — a commit message can never become shell syntax. */
function git(args, cwd, signal) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, signal, timeout: 30_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve({ content: `git ${args[0]} failed: ${(stderr || err.message).trim()}`, isError: true });
      else resolve({ content: stdout.trim() || '(clean — nothing to report)', isError: false });
    });
  });
}

/** @param {import('../../src/shared/extension.js').ExtensionAPI} api */
export default function (api) {
  api.registerTool({
    name: 'git_status',
    description: 'Show `git status --short` for the workspace: which files are modified, added or untracked.',
    parameters: { type: 'object', additionalProperties: false },
    readOnly: true,
    execute: (args, { signal } = {}) => git(['status', '--short'], api.cwd, signal),
  });

  api.registerTool({
    name: 'git_commit',
    description: 'Commit all STAGED changes with a message. Stage files first (git add) — this tool does not stage.',
    parameters: { type: 'object', properties: { message: { type: 'string', description: 'The commit message' } }, required: ['message'] },
    needsApproval: true, // goes through the approval gate like every risky tool — no private confirm prompt
    execute: ({ message }, { signal } = {}) => git(['commit', '-m', String(message)], api.cwd, signal),
  });

  api.registerCommand({
    name: 'git-status',
    description: 'Print git status (git-status extension)',
    handler: async () => (await git(['status', '--short'], api.cwd)).content,
  });
}
