// src/context/project-instructions.js — find AGENTS.md / CLAUDE.md (Day 24).
//
// AGENTS.md is the de-facto standard way a repository tells coding agents how to work in it:
// build/test commands, conventions, layout. Harnesses FOLLOW it. What it can NOT do is grant
// permissions: the approval gate, permission rules and the jail decide what runs — not prompt text.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { truncateText } from '../tools/truncate.js';

const NAMES = ['AGENTS.md', 'CLAUDE.md'];
// Cap each file well under the window (~2k tokens). A whole 32 KiB file would be ~8k tokens — the entire
// default window — spent before the conversation starts. See Day 25 for the same "size it to the window" rule.
const DEFAULT_MAX_BYTES = 8 * 1024;

/** @param {string} p */
async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

/** The repository root: the nearest ancestor (inclusive) that contains a `.git` entry, or null.
 * @param {string} start */
export async function repoRoot(start) {
  let dir = path.resolve(start);
  while (true) {
    if (await exists(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** @param {string} child @param {string} parent */
function isUnder(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Walk from `cwd` up to a boundary, collecting at most one instruction file per directory (AGENTS.md
 * preferred over CLAUDE.md). Returned OUTERMOST first, so the closest file comes last and reads as most
 * specific. The boundary stops the walk from wandering out of the project: the repository root (nearest
 * `.git`), else `$HOME`, else `cwd` itself. Without it the walk climbs to `/` and reads ~/AGENTS.md or
 * /tmp/AGENTS.md — files that are not this project's instructions.
 * @param {string} cwd
 * @param {{ stopAt?: string, globalFile?: string, maxBytes?: number }} [opts]
 * @returns {Promise<Array<{ path: string, source: 'user'|'project', content: string, truncated: boolean }>>}
 */
export async function loadProjectInstructions(cwd, { stopAt, globalFile, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const start = path.resolve(cwd);
  const home = os.homedir();
  const stop = stopAt ? path.resolve(stopAt) : (await repoRoot(start)) ?? (isUnder(start, home) ? home : start);

  /** @type {Array<{ path: string, source: 'user'|'project', content: string, truncated: boolean }>} */
  const found = [];
  let dir = start;
  while (true) {
    for (const name of NAMES) {
      const file = path.join(dir, name);
      const text = await fs.readFile(file, 'utf8').catch(() => null);
      if (text !== null) {
        const t = truncateText(text, maxBytes);
        found.push({ path: file, source: 'project', content: t.content, truncated: t.truncated });
        break;
      }
    }
    const parent = path.dirname(dir);
    if (dir === stop || parent === dir) break;
    dir = parent;
  }
  found.reverse();
  if (globalFile) {
    const text = await fs.readFile(globalFile, 'utf8').catch(() => null);
    if (text !== null) {
      const t = truncateText(text, maxBytes);
      found.unshift({ path: globalFile, source: 'user', content: t.content, truncated: t.truncated });
    }
  }
  return found;
}
