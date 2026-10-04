// src/agent/permissions.js — who may run what, decided BEFORE anyone is asked (Day 20).
import path from 'node:path';
//
// Rule syntax:   "read"                 the whole tool
//                "bash(git status)"     exact main argument
//                "bash(npm test*)"      * matches anything (including '/' and spaces)
//                "mcp__notes__*"        * also works in tool names
// The "main argument" is bash's command, read/write/edit's path, or the JSON of the arguments otherwise.
// A path argument is normalized against the workspace root first, so './x', 'a/../x' and an absolute
// path all match the same rule — a rule can't be dodged by respelling the path.
// A WILDCARD bash allow rule does not match a command containing shell operators (; && | ` $( > < or a
// newline): 'bash(npm test*)' pre-approves `npm test -- --watch`, never `npm test; curl … | sh`. Exact
// rules still match exactly. Deny rules are not narrowed this way (a deny should match as much as it can).
//
// Order of decision (first match wins):
//   1. a deny rule matches                     → deny   (deny ALWAYS wins, even in yolo mode)
//   2. mode 'read-only' and tool not readOnly  → deny
//   3. tool doesn't need approval              → allow
//   4. an allow rule / session rule matches    → allow
//   5. mode 'yolo'                             → allow
//   6. mode 'accept-edits' and write/edit      → allow
//   7. otherwise                               → ask

export const PERMISSION_MODES = Object.freeze(['default', 'read-only', 'accept-edits', 'yolo']);

/** @typedef {{ decision: 'allow'|'deny'|'ask', reason?: string }} Decision */

export class PermissionPolicy {
  /** @param {{ mode?: string, allow?: string[], deny?: string[], root?: string }} [opts] */
  constructor({ mode = 'default', allow = [], deny = [], root = process.cwd() } = {}) {
    this.setMode(mode);
    this.root = root;             // path rules are matched relative to this (the workspace)
    this.allow = [...allow];
    this.deny = [...deny];
    /** rules added by answering "always" at the prompt — this session only, never written to disk */
    this.sessionAllow = [];
    for (const r of [...this.allow, ...this.deny]) parseRule(r); // validate early
  }

  setMode(mode) {
    if (!PERMISSION_MODES.includes(mode)) throw new TypeError(`unknown permission mode '${mode}' (use ${PERMISSION_MODES.join(', ')})`);
    this.mode = mode;
  }

  addSessionRule(rule) { parseRule(rule); this.sessionAllow.push(rule); }

  /**
   * @param {import('../shared/message-schemas.js').ToolCall} call
   * @param {{ needsApproval?: boolean, readOnly?: boolean }} tool
   * @returns {Decision}
   */
  decide(call, tool) {
    const denied = this.deny.find((r) => ruleMatches(r, call, this.root));
    if (denied) return { decision: 'deny', reason: `blocked by deny rule "${denied}"` };
    if (this.mode === 'read-only' && !tool.readOnly) return { decision: 'deny', reason: 'read-only mode' };
    if (!tool.needsApproval) return { decision: 'allow' };
    const allowed = [...this.allow, ...this.sessionAllow].find((r) => ruleMatches(r, call, this.root) && !unsafeBashWildcard(r, call));
    if (allowed) return { decision: 'allow', reason: `allow rule "${allowed}"` };
    if (this.mode === 'yolo') return { decision: 'allow', reason: 'yolo mode' };
    if (this.mode === 'accept-edits' && (call.name === 'write' || call.name === 'edit')) return { decision: 'allow', reason: 'accept-edits mode' };
    return { decision: 'ask' };
  }

  describe() {
    return [
      `mode ${this.mode}`,
      `allow ${this.allow.length ? this.allow.join(', ') : '(none)'}`,
      `deny ${this.deny.length ? this.deny.join(', ') : '(none)'}`,
      `session allow ${this.sessionAllow.length ? this.sessionAllow.join(', ') : '(none)'}`,
    ].join('\n');
  }
}

/** "bash(git *)" → { tool: 'bash', pattern: 'git *' }; "read" → { tool: 'read', pattern: null } */
export function parseRule(rule) {
  const m = /^([A-Za-z0-9_.*-]+)(?:\((.*)\))?$/s.exec(String(rule).trim());
  if (!m) throw new TypeError(`invalid permission rule: ${rule}`);
  return { tool: m[1], pattern: m[2] ?? null };
}

/**
 * The argument a rule's pattern matches against: bash's command verbatim, a file tool's path NORMALIZED
 * relative to the workspace (so respelling can't dodge a rule), or the JSON of the arguments otherwise.
 * @param {import('../shared/message-schemas.js').ToolCall} call
 * @param {string} [root]
 */
export function primaryArgument(call, root = process.cwd()) {
  const a = call.arguments ?? {};
  if (call.name === 'bash' && typeof a.command === 'string') return a.command;
  if (typeof a.path === 'string') return path.relative(root, path.resolve(root, a.path)).split(path.sep).join('/');
  return JSON.stringify(a);
}

/** Shell operators that chain or redirect a command: ; && || | ` $( ) > < and newlines. */
const SHELL_CONTROL = /[;&|<>\n`]|\$\(/;
/** @param {string} command */
export function hasShellControl(command) { return SHELL_CONTROL.test(String(command)); }

/** A wildcard bash allow rule must not pre-approve a chained/redirected command. Deny rules are exempt.
 * @param {string} rule @param {import('../shared/message-schemas.js').ToolCall} call */
function unsafeBashWildcard(rule, call) {
  const { tool, pattern } = parseRule(rule);
  return tool === 'bash' && (pattern?.includes('*') ?? false) && hasShellControl(primaryArgument(call));
}

export function ruleMatches(rule, call, root = process.cwd()) {
  const { tool, pattern } = parseRule(rule);
  if (!globToRegExp(tool).test(call.name)) return false;
  return pattern === null || globToRegExp(pattern).test(primaryArgument(call, root));
}

/** '*' → any run of characters; everything else literal; anchored at both ends. */
export function globToRegExp(glob) {
  const body = glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}$`, 's');
}

/**
 * The rule "always allow" should add for this call: the exact command for bash, the exact path for
 * write/edit (so "always" means "this file", not "every file"), the tool name for anything else.
 * @param {import('../shared/message-schemas.js').ToolCall} call
 * @param {string} [root]
 */
export function suggestRule(call, root = process.cwd()) {
  if (call.name === 'bash') return `bash(${primaryArgument(call, root)})`;
  if ((call.name === 'write' || call.name === 'edit') && typeof call.arguments?.path === 'string') return `${call.name}(${primaryArgument(call, root)})`;
  return call.name;
}

/** A short, human description of the rule "always" will add — for the prompt, so you know its scope. */
export function describeSessionRule(call, root = process.cwd()) {
  const rule = suggestRule(call, root);
  if (call.name === 'bash') return `this exact command`;
  if (rule.includes('(')) return `${call.name} to this path`;
  return `every ${call.name} call`;
}
