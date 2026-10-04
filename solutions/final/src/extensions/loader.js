// src/extensions/loader.js — discover, import, isolate, and unload extensions (Day 22).
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createExtensionApi } from '../shared/extension.js';
import { fingerprintDir } from './trust.js';

/**
 * Extensions run IN-PROCESS WITH YOUR PRIVILEGES. This loader isolates FAILURES (one broken
 * extension never stops the others), not MALICE — there is no sandbox. Trust is the gate.
 */
export class ExtensionLoader {
  /** @type {Map<string, { file: string, source: string, undo: () => void }>} */
  #loaded = new Map();
  #importCounter = 0;

  /**
   * @param {Omit<Parameters<typeof createExtensionApi>[0], 'name'> & { onWarn?: (m: string) => void }} deps
   */
  constructor(deps) {
    this.deps = deps;
    this.onWarn = deps.onWarn ?? ((m) => console.warn(m));
  }

  /**
   * Import one file and run its factory. Returns the extension name, or null if it failed.
   * @param {string} file
   * @param {{ source?: 'global'|'project'|'cli', reload?: boolean }} [opts]
   */
  async loadFile(file, { source = 'cli', reload = false } = {}) {
    const abs = path.resolve(file);
    let mod;
    try {
      // import() caches by URL: the same URL returns the same module instance. A query string busts the cache.
      const url = pathToFileURL(abs).href + (reload ? `?v=${++this.#importCounter}` : '');
      mod = await import(url);
    } catch (err) {
      this.onWarn(`extension ${path.basename(abs)} failed to import: ${err.message}`);
      return null;
    }
    const name = String(mod.meta?.name ?? path.basename(abs).replace(/\.m?js$/, ''));
    if (this.#loaded.has(name)) { this.onWarn(`extension ${name} is already loaded — skipped ${abs}`); return null; }
    if (typeof mod.default !== 'function') { this.onWarn(`extension ${name} has no default-export factory — skipped`); return null; }
    const { api, undo } = createExtensionApi({ ...this.deps, name });
    try {
      await mod.default(api);
    } catch (err) {
      undo(); // roll back whatever it registered before failing
      this.onWarn(`extension ${name} failed to start: ${err.message}`);
      return null;
    }
    this.#loaded.set(name, { file: abs, source, undo });
    return name;
  }

  /** Load every *.js / *.mjs file in a directory (missing directory = nothing to do). */
  /** @param {string} dir @param {{ source?: 'global'|'project'|'cli' }} [opts] */
  async loadDir(dir, { source = 'global' } = {}) {
    const names = await listExtensionFiles(dir);
    const loaded = [];
    for (const n of names) {
      const name = await this.loadFile(path.join(dir, n), { source });
      if (name) loaded.push(name);
    }
    return loaded;
  }

  /** Remove exactly what one extension registered: tools, commands, listeners. */
  unloadExtension(name) {
    const ext = this.#loaded.get(name);
    if (!ext) return false;
    ext.undo();
    this.#loaded.delete(name);
    return true;
  }

  unloadAll() { for (const name of [...this.#loaded.keys()]) this.unloadExtension(name); }

  list() { return [...this.#loaded.entries()].map(([name, e]) => ({ name, file: e.file, source: e.source })); }
}

export async function listExtensionFiles(dir) {
  try {
    return (await fs.readdir(dir)).filter((n) => n.endsWith('.js') || n.endsWith('.mjs')).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * The trust gate for PROJECT extensions (repo-controlled code).
 *   --allow-project-extensions → load (for CI; not recorded)
 *   trusted with identical file hashes → load
 *   interactive → ask; "y" records trust in YOUR config and loads; anything else skips
 *   non-interactive → skip with a warning
 * @param {{
 *   dir: string, projectRoot: string, loader: ExtensionLoader,
 *   trustStore: import('./trust.js').TrustStore,
 *   ask?: (q: string) => Promise<string>, interactive?: boolean,
 *   allowProjectExtensions?: boolean, notify?: (m: string) => void,
 * }} opts
 * @returns {Promise<{ loaded: string[], skipped: boolean, reason?: string }>}
 */
export async function loadProjectExtensions({ dir, projectRoot, loader, trustStore, ask, interactive = true, allowProjectExtensions = false, notify = () => {} }) {
  const files = await listExtensionFiles(dir);
  if (!files.length) return { loaded: [], skipped: false };
  if (allowProjectExtensions) return { loaded: await loader.loadDir(dir, { source: 'project' }), skipped: false, reason: 'allowed by flag' };

  const fingerprint = await fingerprintDir(dir);
  if (await trustStore.isTrusted(projectRoot, fingerprint)) {
    return { loaded: await loader.loadDir(dir, { source: 'project' }), skipped: false, reason: 'trusted' };
  }
  if (!interactive || !ask) {
    notify(`project extensions NOT loaded (${files.join(', ')}): not trusted — run interactively or pass --allow-project-extensions`);
    return { loaded: [], skipped: true, reason: 'not trusted (non-interactive)' };
  }
  const answer = (await ask(`  This project contains ${files.length} extension(s) that would run code with YOUR privileges: ${files.join(', ')}\n  Trust and load them? [y/N] `)).trim().toLowerCase();
  if (answer !== 'y' && answer !== 'yes') {
    notify('project extensions skipped');
    return { loaded: [], skipped: true, reason: 'declined' };
  }
  await trustStore.trust(projectRoot, fingerprint);
  return { loaded: await loader.loadDir(dir, { source: 'project' }), skipped: false, reason: 'trusted now' };
}
