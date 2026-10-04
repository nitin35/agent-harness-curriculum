// src/session/session-manager.js — one conversation, one append-only JSONL file (Day 17; tree ops + compaction Day 25).
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { globalPaths } from '../config/paths.js';
import { appendJsonl, readJsonl, writeJsonlAtomic, readFirstLine } from './jsonl-utils.js';
import { planCompaction, compactionText } from '../context/compaction.js';

/** @typedef {import('../shared/session.js').SessionHeader} SessionHeader */
/** @typedef {import('../shared/session.js').SessionEntry} SessionEntry */
/** @typedef {import('../shared/message-schemas.js').AgentMessage} AgentMessage */

export function defaultSessionDir() {
  return globalPaths().sessions;
}

export class SessionManager {
  /** @type {SessionHeader} */ header;
  /** @type {string} */ path;
  /** @type {SessionEntry[]} file order */ #entries = [];
  /** @type {Map<string, SessionEntry>} */ #byId = new Map();
  /** @type {string|null} */ #leafId = null;
  #written = false; // has the header reached the disk yet?
  #tornTail = false; // a crash tore the last line: the next append starts with '\n'
  #queue = Promise.resolve(); // serializes writes so lines never interleave

  /**
   * A new, empty session. Nothing touches the disk until the first append (no empty files).
   * @param {{ cwd: string, model: string, dir?: string, name?: string }} opts
   */
  static create({ cwd, model, dir = defaultSessionDir(), name }) {
    const s = new SessionManager();
    const id = randomUUID();
    s.header = { type: 'header', version: 1, id, createdAt: new Date().toISOString(), cwd, model, ...(name ? { name } : {}) };
    const stamp = s.header.createdAt.replace(/[:.]/g, '-');
    s.path = path.join(dir, `${stamp}_${id.slice(0, 8)}.jsonl`);
    return s;
  }

  /**
   * Load a session file. Corrupt lines are skipped with a warning. Content is DATA: nothing in it is executed.
   * @param {string} filePath
   * @param {{ onWarn?: (msg: string) => void }} [opts]
   */
  static async open(filePath, { onWarn = (m) => console.warn(m) } = {}) {
    const { records, tornTail } = await readJsonl(filePath, { onWarn });
    const [header, ...rest] = records;
    if (header?.type !== 'header') throw new Error(`not a session file (no header on line 1): ${filePath}`);
    const s = new SessionManager();
    s.header = header;
    s.path = filePath;
    s.#written = true;
    s.#tornTail = tornTail;
    for (const rec of rest) s.#ingest(rec);
    // A skipped line in the MIDDLE of the file cuts the parent chain: everything before it drops off the path.
    if (s.#entries.some((e) => e.parentId && !s.#byId.has(e.parentId))) {
      onWarn(`session: an entry's parent is missing (a corrupt line?); the conversation before it can't be reached`);
    }
    return s;
  }

  get id() { return this.header.id; }

  /**
   * Append one message as a child of the current leaf; it becomes the new leaf. Written immediately.
   * @param {AgentMessage} message
   * @returns {Promise<SessionEntry>}
   */
  async appendMessage(message) {
    return this.appendEntry({ type: 'message', message });
  }

  /** @param {AgentMessage[]} messages */
  async appendMessages(messages) {
    for (const m of messages) await this.appendMessage(m);
  }

  /**
   * Append any entry (message or compaction). Assigns id, parentId (current leaf) and timestamp.
   * @param {Omit<SessionEntry, 'id'|'parentId'|'timestamp'> & Partial<SessionEntry>} partial
   */
  async appendEntry(partial) {
    const entry = /** @type {SessionEntry} */ ({
      ...partial,
      id: partial.id ?? randomUUID(),
      parentId: partial.parentId === undefined ? this.#leafId : partial.parentId,
      timestamp: partial.timestamp ?? new Date().toISOString(),
    });
    this.#ingest(entry);
    await this.#append(entry);
    return entry;
  }

  /** Every entry in the file, branches and all. */
  getEntries() { return [...this.#entries]; }

  getLeafId() { return this.#leafId; }

  /** The active path: walk parentId from the leaf to the root, then reverse. What the model sees. */
  getPath() {
    const out = [];
    const seen = new Set();
    for (let id = this.#leafId; id; id = this.#byId.get(id)?.parentId ?? null) {
      if (seen.has(id)) throw new Error(`cycle in session tree at ${id}`);
      seen.add(id);
      const entry = this.#byId.get(id);
      if (!entry) break;
      out.push(entry);
    }
    return out.reverse();
  }

  /**
   * The active path as AgentMessages — feed this to loop.run(…, history).
   * Usage numbers measured BEFORE the latest compaction described a longer prompt than the one the model
   * sees now, so they are dropped from the returned copies (Day 24's calibration must not trust them).
   * @returns {AgentMessage[]}
   */
  getMessages() {
    const path = this.getPath();
    const lastCompaction = path.filter((e) => e.type === 'compaction').at(-1);
    return path.map((e) => {
      if (e.type === 'compaction') return compactionToMessage(e);
      if (lastCompaction && e.message.usage && e.timestamp <= lastCompaction.timestamp) {
        const { usage, ...rest } = e.message;
        return rest;
      }
      return e.message;
    });
  }

  /** Entries whose parent is `id` (Day 25). */
  getChildren(id) { return this.#entries.filter((e) => e.parentId === id); }

  /**
   * Move the leaf to an existing entry: the next append becomes its child, forking the tree (Day 25).
   * Persisted as a small `leaf` marker line — the file stays append-only.
   */
  async branch(entryId) {
    if (!this.#byId.has(entryId)) throw new Error(`no such entry: ${entryId}`);
    const marker = { type: 'leaf', leafId: entryId, timestamp: new Date().toISOString() };
    this.#leafId = entryId;
    await this.#append(marker);
  }

  /**
   * Compact the ACTIVE PATH (Day 25). Replaces the oldest part with one compaction entry C:
   *   C.parentId = parent of the first summarized entry;  kept[0].parentId = C.id  (one pointer rewritten)
   * The summarized entries stay in the file as an abandoned branch; other branches are untouched.
   * Because one existing line changes, the file is rewritten atomically (Day 17's writeJsonlAtomic).
   * @param {{ keepMessages?: number, maxBytes?: number }} [opts]
   * @returns {Promise<{ dropped: number, kept: number, entry: object } | null>} null = nothing to compact
   */
  async compact({ keepMessages = 6, maxBytes = 8 * 1024 } = {}) {
    const plan = planCompaction(this.getPath(), { keepMessages });
    if (!plan) return null;
    const { summarized, kept } = plan;
    /** @type {import('../shared/session.js').CompactionEntry} */
    const entry = {
      type: 'compaction',
      id: randomUUID(),
      parentId: summarized[0].parentId ?? null,
      timestamp: new Date().toISOString(),
      summarizedIds: summarized.map((e) => e.id),
      content: compactionText(summarized, maxBytes),
    };
    // Insert C just before kept[0] in FILE order, so the last entry in the file is still the leaf.
    const at = this.#entries.indexOf(kept[0]);
    this.#entries.splice(at, 0, entry);
    this.#byId.set(entry.id, entry);
    kept[0].parentId = entry.id;
    await this.save();
    return { dropped: summarized.length, kept: kept.length, entry };
  }

  /** Update the model recorded in the header (Day 18's /model). Persisted by save(). */
  setModel(model) { this.header.model = model; }

  /** Atomic full rewrite: header + every entry. Needed when the header changes (and on Day 25). */
  async save() {
    await this.#enqueue(async () => {
      // the leaf is the last line that names it: keep markers only if the leaf isn't simply the last entry
      const tail = this.#entries.at(-1)?.id === this.#leafId ? [] : [{ type: 'leaf', leafId: this.#leafId, timestamp: new Date().toISOString() }];
      await writeJsonlAtomic(this.path, [this.header, ...this.#entries, ...tail]);
      this.#written = true;
      this.#tornTail = false;
    });
  }

  /** Wait for pending writes (tests, shutdown). */
  async flush() { await this.#queue; }

  #ingest(rec) {
    if (rec?.type === 'message' || rec?.type === 'compaction') {
      this.#entries.push(rec);
      this.#byId.set(rec.id, rec);
      this.#leafId = rec.id;
    } else if (rec?.type === 'leaf' && this.#byId.has(rec.leafId)) {
      this.#leafId = rec.leafId; // a branch() happened here
    }
  }

  /**
   * Append one record: after the header if it isn't on disk yet, and after a '\n' if a crash tore the
   * last line. Without that newline the record would be glued onto the torn line and skipped with it,
   * and the next entry would point at a parent that no longer exists, cutting off the whole conversation.
   * @param {object} record
   */
  async #append(record) {
    await this.#enqueue(async () => {
      if (!this.#written) { await appendJsonl(this.path, this.header); this.#written = true; }
      if (this.#tornTail) { await fs.appendFile(this.path, '\n'); this.#tornTail = false; }
      await appendJsonl(this.path, record);
    });
  }

  #enqueue(fn) {
    const next = this.#queue.then(fn);
    this.#queue = next.catch(() => {}); // keep the chain alive after a failure
    return next;
  }
}

/** Day 25: what the model sees in place of compacted entries. @param {{ content: string }} entry @returns {AgentMessage} */
export function compactionToMessage(entry) {
  return { role: 'user', content: `[Earlier conversation, compacted — older details may be missing]\n${entry.content}` };
}

/**
 * List sessions, newest first. Reads only line 1 of each file; unreadable files are skipped.
 * With `cwd`, only the sessions started in that folder (Day 19): a conversation about another project
 * would talk about files the tools here can't reach.
 * @param {string} [dir]
 * @param {{ onWarn?: (msg: string) => void, cwd?: string }} [opts]
 * @returns {Promise<Array<SessionHeader & { path: string, updatedAt: string }>>}
 */
export async function listSessions(dir = defaultSessionDir(), { onWarn = (m) => console.warn(m), cwd } = {}) {
  let names;
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith('.jsonl'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const first = await readFirstLine(file);
      const header = first && JSON.parse(first);
      if (header?.type !== 'header') throw new Error('no header');
      if (cwd && path.resolve(String(header.cwd)) !== path.resolve(cwd)) continue;
      const { mtime } = await fs.stat(file);
      out.push({ ...header, path: file, updatedAt: mtime.toISOString() });
    } catch (err) {
      onWarn(`sessions: skipped ${name} (${err.message})`);
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt));
}
