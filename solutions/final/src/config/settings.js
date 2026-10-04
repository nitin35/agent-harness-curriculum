// src/config/settings.js — layered settings with a SECURE project layer (Day 26).
//
//   built-in defaults ← global (~/.config/agent-harness/settings.json, YOURS) ← project (.agent-harness/settings.json,
//   REPO-CONTROLLED) ← CLI flags (YOU, right now)
//
// The project layer is an ALLOW-LIST. A repository may set a few harmless preferences and may make security
// STRICTER (add deny rules, switch to read-only, shrink the window, drop tools). It can never loosen anything:
// no autoApprove, no provider URLs, no allow rules, no MCP servers, no system prompt (use AGENTS.md).
// Every ignored key is reported by name — silently ignoring would hide an attack.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TURNS, DEFAULT_MODEL, DEFAULT_OLLAMA_URL } from '../shared/constants.js';
import { ValidationError } from '../shared/errors.js';
import { PERMISSION_MODES } from '../agent/permissions.js';
import { globalPaths, projectPaths } from './paths.js';

export const DEFAULT_SETTINGS = deepFreeze({
  provider: 'ollama',                 // 'ollama' | 'openai-compatible' | 'scripted'
  ollamaUrl: DEFAULT_OLLAMA_URL,
  openai: { baseUrl: 'http://localhost:11434/v1', apiKeyEnv: 'OPENAI_API_KEY' },  // the key itself lives in that env var
  defaultModel: DEFAULT_MODEL,
  contextWindow: DEFAULT_CONTEXT_WINDOW,  // sent as num_ctx
  think: true,
  maxTurns: DEFAULT_MAX_TURNS,
  streaming: true,
  autoApprove: false,                 // true = permission mode 'yolo' (deny rules still apply)
  tools: { enabled: null },           // null = every registered tool; an array = only these names
  permissions: { mode: 'default', allow: [], deny: [] },
  compaction: { enabled: true, contextLimit: null, keepMessages: 6 },
  mcpServers: {},
  systemPrompt: '',
});

/** Type checks: key path → (value) => boolean, plus a description for error messages. */
const SCHEMA = {
  provider: [(v) => ['ollama', 'openai-compatible', 'scripted'].includes(v), "'ollama', 'openai-compatible' or 'scripted'"],
  ollamaUrl: [(v) => typeof v === 'string' && /^https?:\/\//.test(v), 'an http(s) URL'],
  'openai.baseUrl': [(v) => typeof v === 'string' && /^https?:\/\//.test(v), 'an http(s) URL'],
  'openai.apiKeyEnv': [(v) => typeof v === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(v), 'an environment variable NAME (not the key itself)'],
  defaultModel: [(v) => typeof v === 'string' && v.length > 0, 'a model name'],
  contextWindow: [(v) => Number.isInteger(v) && v >= 1024, 'an integer ≥ 1024'],
  think: [(v) => typeof v === 'boolean' || ['low', 'medium', 'high'].includes(v), "true, false, 'low', 'medium' or 'high'"],
  maxTurns: [(v) => Number.isInteger(v) && v > 0, 'a positive integer'],
  streaming: [(v) => typeof v === 'boolean', 'true or false'],
  autoApprove: [(v) => typeof v === 'boolean', 'true or false'],
  'tools.enabled': [(v) => v === null || (Array.isArray(v) && v.every((x) => typeof x === 'string')), 'null or a list of tool names'],
  'permissions.mode': [(v) => PERMISSION_MODES.includes(v), PERMISSION_MODES.join(', ')],
  'permissions.allow': [(v) => Array.isArray(v) && v.every((x) => typeof x === 'string'), 'a list of rules'],
  'permissions.deny': [(v) => Array.isArray(v) && v.every((x) => typeof x === 'string'), 'a list of rules'],
  'compaction.enabled': [(v) => typeof v === 'boolean', 'true or false'],
  'compaction.contextLimit': [(v) => v === null || (Number.isInteger(v) && v >= 1024), 'null or an integer ≥ 1024'],
  'compaction.keepMessages': [(v) => Number.isInteger(v) && v >= 1, 'a positive integer'],
  mcpServers: [(v) => v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((s) => s && typeof s.command === 'string'), 'an object of { command, args?, env? }'],
  systemPrompt: [(v) => typeof v === 'string', 'a string'],
};

/** What a PROJECT file may set, and how. Anything else is ignored with a warning. */
const PROJECT_RULES = {
  defaultModel: 'set',
  think: 'set',
  streaming: 'set',
  contextWindow: 'lower',                // num_ctx = memory Ollama allocates on YOUR machine: a repo may only shrink it
  maxTurns: 'lower',                     // a repo may shorten runs, never lengthen them
  'compaction.enabled': 'set',
  'compaction.keepMessages': 'set',
  'compaction.contextLimit': 'lower',     // only ever smaller
  'tools.enabled': 'intersect',           // only ever fewer tools
  'permissions.deny': 'union',            // only ever more deny rules
  'permissions.mode': 'stricter',         // only 'read-only'
};

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * @param {{ cwd: string, home?: string, flags?: Record<string, unknown>, onWarn?: (m: string) => void, env?: Record<string,string|undefined> }} opts
 * @returns {{ settings: typeof DEFAULT_SETTINGS, files: { global: string, project: string } }}
 */
export function loadSettings({ cwd, home, flags = {}, onWarn = (m) => console.warn(m) }) {
  const files = { global: globalPaths(home).settings, project: projectPaths(cwd).settings };
  const settings = structuredClone(DEFAULT_SETTINGS);

  const global = readJsonFile(files.global);
  if (global) applyGlobal(settings, global, files.global, onWarn);

  const project = readJsonFile(files.project);
  if (project) applyProject(settings, project, files.project, onWarn);

  applyFlags(settings, flags);
  return { settings, files };
}

function readJsonFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('top level must be an object');
    return value;
  } catch (err) {
    throw new ValidationError(`${file}: invalid JSON (${err.message})`, { field: file });
  }
}

/** Your own file: every known key is allowed. Nested objects merge; arrays replace. */
function applyGlobal(settings, layer, file, onWarn) {
  for (const [key, value] of flatten(layer)) {
    if (!(key in SCHEMA) && !isMcpServerKey(key)) { onWarn(`unknown setting '${key}' in ${file} — ignored`); continue; }
    if (isMcpServerKey(key)) continue; // handled as a whole object below
    validate(key, value, file);
    setPath(settings, key, value);
  }
  if (layer.mcpServers !== undefined) { validate('mcpServers', layer.mcpServers, file); settings.mcpServers = structuredClone(layer.mcpServers); }
}

/** The repository's file: allow-list only (see PROJECT_RULES). */
function applyProject(settings, layer, file, onWarn) {
  for (const [key, value] of flatten(layer)) {
    const rule = PROJECT_RULES[key];
    if (!rule) {
      const top = key.split('.')[0];
      onWarn(`${file}: '${key}' cannot be set by a project file (security) — ignored${top === 'mcpServers' || key === 'autoApprove' || key === 'permissions.allow' ? '; put it in your global settings if you really want it' : ''}`);
      continue;
    }
    validate(key, value, file);
    const current = getPath(settings, key);
    // The model is a harmless preference, but YOU should know a repo picked it (and which one).
    if (key === 'defaultModel' && value !== current) onWarn(`${file}: this project selects the model '${value}' (yours: '${current}')`);
    if (rule === 'set') setPath(settings, key, value);
    else if (rule === 'lower') setPath(settings, key, current === null ? value : Math.min(current, value));
    else if (rule === 'intersect') setPath(settings, key, current === null ? value : current.filter((n) => value.includes(n)));
    else if (rule === 'union') setPath(settings, key, [...new Set([...current, ...value])]);
    else if (rule === 'stricter') {
      if (value === 'read-only') setPath(settings, key, value);
      else onWarn(`${file}: permissions.mode '${value}' is not stricter than your own setting — ignored (a project may only choose 'read-only')`);
    }
  }
}

/** CLI flags: you, right now — highest precedence. */
function applyFlags(settings, flags) {
  if (flags.model) settings.defaultModel = String(flags.model);
  if (flags.provider) { validate('provider', flags.provider, '--provider'); settings.provider = flags.provider; }
  if (flags['system-prompt']) settings.systemPrompt = String(flags['system-prompt']);
  if (flags['no-tools']) settings.tools.enabled = [];
  if (flags.tools) settings.tools.enabled = String(flags.tools).split(',').map((s) => s.trim()).filter(Boolean);
  if (flags['permission-mode']) { validate('permissions.mode', flags['permission-mode'], '--permission-mode'); settings.permissions.mode = flags['permission-mode']; }
  if (flags['auto-approve']) { settings.autoApprove = true; settings.permissions.mode = 'yolo'; }
  if (settings.autoApprove && settings.permissions.mode === 'default') settings.permissions.mode = 'yolo';
}

/** Write one key into YOUR global settings (used by /model). @param {string} key @param {unknown} value @param {{ home?: string }} [opts] */
export function saveGlobalSetting(key, value, { home } = {}) {
  const file = globalPaths(home).settings;
  validate(key, value, file);
  const current = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } })();
  setPath(current, key, value);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
}

/** Keys whose wrong value is often a secret pasted into the wrong place: never echo it to the terminal or a CI log. */
const NEVER_ECHO = new Set(['openai.apiKeyEnv']);

function validate(key, value, file) {
  const [check, expected] = SCHEMA[key] ?? [() => true, ''];
  if (check(value)) return;
  const got = NEVER_ECHO.has(key) ? "; the value isn't shown, in case it is the key itself" : ` (got ${JSON.stringify(value)})`;
  throw new ValidationError(`${file}: '${key}' must be ${expected}${got}`, { field: key });
}

/** {a:{b:1}, c:[1]} → [['a.b',1], ['c',[1]]] — objects flatten, arrays/null are leaves. Skips prototype-polluting keys. */
function flatten(obj, prefix = '') {
  const out = [];
  for (const key of Object.keys(obj)) {
    if (BLOCKED_KEYS.has(key)) continue;
    const value = obj[key];
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value) && full !== 'mcpServers' && !full.startsWith('mcpServers.')) out.push(...flatten(value, full));
    else out.push([full, value]);
  }
  return out;
}
const isMcpServerKey = (k) => k === 'mcpServers' || k.startsWith('mcpServers.');

function getPath(obj, key) { return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
function setPath(obj, key, value) {
  const parts = key.split('.');
  let o = obj;
  for (const p of parts.slice(0, -1)) {
    if (BLOCKED_KEYS.has(p)) return;
    if (!Object.hasOwn(o, p) || typeof o[p] !== 'object' || o[p] === null) o[p] = {};
    o = o[p];
  }
  const last = parts.at(-1);
  if (!BLOCKED_KEYS.has(last)) o[last] = Array.isArray(value) ? [...value] : value;
}
function deepFreeze(o) { for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v); return Object.freeze(o); }
