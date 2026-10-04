// src/ui/file-finder.js — find workspace files for Tab completion (Day 28). Pure: root + token in, list out.
import fs from 'node:fs/promises';
import path from 'node:path';

const IGNORED = new Set(['node_modules', '.git', '.agent-harness']);

/**
 * Up to `limit` workspace-relative paths matching `partial`: prefix matches first, then substring matches.
 * Never DESCENDS into node_modules / .git / .agent-harness (skipping them afterwards would still walk
 * thousands of files on every Tab). Stops early once enough prefix matches are found.
 * @param {string} root
 * @param {string} partial
 * @param {{ limit?: number, maxScan?: number }} [opts]
 * @returns {Promise<string[]>}
 */
export async function findCandidates(root, partial, { limit = 8, maxScan = 20_000 } = {}) {
  const needle = partial.toLowerCase();
  const prefix = [];
  const contains = [];
  let scanned = 0;
  const queue = [''];
  while (queue.length && scanned < maxScan && prefix.length < limit) {
    const rel = queue.shift();
    let entries;
    try { entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (IGNORED.has(e.name)) continue;
      scanned++;
      const p = rel ? `${rel}/${e.name}` : e.name;
      const shown = e.isDirectory() ? `${p}/` : p;
      const lower = shown.toLowerCase();
      if (lower.startsWith(needle)) prefix.push(shown);
      else if (needle && lower.includes(needle)) contains.push(shown);
      if (e.isDirectory()) queue.push(p);
    }
  }
  return [...prefix, ...contains].slice(0, limit);
}

/** Longest common prefix of candidates (what Tab can safely complete to). */
export function commonPrefix(items) {
  if (!items.length) return '';
  let p = items[0];
  for (const s of items.slice(1)) while (!s.startsWith(p)) p = p.slice(0, -1);
  return p;
}
