// src/shared/session.js — session file shapes (Day 17; compaction entries Day 25).
//
// A session is ONE append-only JSONL file:
//   line 1      SessionHeader
//   lines 2…    SessionEntry records, in the order they happened
// Entries link to their parent with `parentId`, so the file is a tree. The model sees one root→leaf
// path through it. The current leaf is the last message/compaction entry in the file, unless a later
// `leaf` marker line moves it (Day 25's branch()).

/**
 * @typedef {object} SessionHeader
 * @property {'header'} type
 * @property {1} version
 * @property {string} id
 * @property {string} createdAt   ISO timestamp
 * @property {string} cwd
 * @property {string} model
 * @property {string} [name]
 */

/**
 * @typedef {object} MessageEntry
 * @property {'message'} type
 * @property {string} id
 * @property {string|null} parentId
 * @property {string} timestamp
 * @property {import('./message-schemas.js').AgentMessage} message
 */

/**
 * Day 25. Stands in for the entries it replaced on the active path.
 * @typedef {object} CompactionEntry
 * @property {'compaction'} type
 * @property {string} id
 * @property {string|null} parentId
 * @property {string} timestamp
 * @property {string[]} summarizedIds   ids of the entries folded into this one
 * @property {string} content           what the model sees instead of them
 */

/**
 * Moves the leaf without adding a message (Day 25's branch()).
 * @typedef {{ type: 'leaf', leafId: string, timestamp: string }} LeafMarker
 */

/** @typedef {MessageEntry | CompactionEntry} SessionEntry */

export {};
