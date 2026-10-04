// src/config/paths.js — where the harness keeps things (Day 17). Computed, never a literal '~/'.
import os from 'node:os';
import path from 'node:path';

/**
 * The global config directory: ~/.config/agent-harness on every OS (deliberate XDG-style layout).
 * AGENT_HARNESS_HOME overrides it — tests point it at a temp dir so they never touch your real files.
 * @param {Record<string, string|undefined>} [env]
 */
export function configDir(env = process.env) {
  return env.AGENT_HARNESS_HOME ? path.resolve(env.AGENT_HARNESS_HOME) : path.join(os.homedir(), '.config', 'agent-harness');
}

/** Every global path, derived from one base. */
export function globalPaths(base = configDir()) {
  return {
    base,
    settings: path.join(base, 'settings.json'),
    sessions: path.join(base, 'sessions'),
    logs: path.join(base, 'logs'),
    extensions: path.join(base, 'extensions'),
    skills: path.join(base, 'skills'),
    trustedProjects: path.join(base, 'trusted-projects.json'),
  };
}

/** Project-local paths (repo-controlled — see the README's trust boundaries). */
export function projectPaths(cwd) {
  const base = path.join(cwd, '.agent-harness');
  return {
    base,
    settings: path.join(base, 'settings.json'),
    extensions: path.join(base, 'extensions'),
    skills: path.join(base, 'skills'),
  };
}
