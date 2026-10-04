// src/extensions/trust.js — remember which projects' extensions YOU trusted (Day 22).
//
// The record lives in YOUR config (~/.config/agent-harness/trusted-projects.json), never in the repo:
// a file inside the repository is controlled by whoever wrote the repository, so it can't vouch for itself.
// Trust is per project root AND per exact file contents (sha256) of EVERY file in the extensions tree —
// entry points and the helpers they import — so changing imported code re-asks too. (Code imported from
// OUTSIDE the extensions directory is not covered; document that.)
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export class TrustStore {
  /** @param {string} file  usually globalPaths().trustedProjects */
  constructor(file) { this.file = file; }

  async #read() {
    try { return JSON.parse(await fs.readFile(this.file, 'utf8')); } catch { return { projects: {} }; }
  }

  /**
   * @param {string} projectRoot
   * @param {Record<string, string>} fingerprint  file name → sha256
   */
  async isTrusted(projectRoot, fingerprint) {
    const entry = (await this.#read()).projects?.[await realRoot(projectRoot)];
    return Boolean(entry) && sameFingerprint(entry.files, fingerprint);
  }

  async trust(projectRoot, fingerprint) {
    const data = await this.#read();
    data.projects ??= {};
    data.projects[await realRoot(projectRoot)] = { trustedAt: new Date().toISOString(), files: fingerprint };
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(data, null, 2));
  }
}

/**
 * sha256 of EVERY file under a directory (recursively), keyed by path relative to it: the exact code you
 * are agreeing to run, including helpers the entry points import. A new or changed file anywhere in the
 * tree changes the fingerprint, so `git pull` can't swap trusted code for something else without re-asking.
 */
export async function fingerprintDir(dir) {
  /** @type {Record<string, string>} */
  const out = {};
  async function walk(current, prefix) {
    const entries = (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const full = path.join(current, e.name);
      if (e.isDirectory()) await walk(full, rel);
      else if (e.isFile()) out[rel] = crypto.createHash('sha256').update(await fs.readFile(full)).digest('hex');
    }
  }
  await walk(dir, '');
  return out;
}

function sameFingerprint(a = {}, b = {}) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

async function realRoot(p) {
  try { return await fs.realpath(p); } catch { return path.resolve(p); }
}
