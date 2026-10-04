// src/tools/workspace-path.js — the workspace jail (Day 10; reused by bash cwd, edit, @file refs).
import fs from 'node:fs';
import path from 'node:path';

export class PathEscapeError extends Error {
  /** @param {string} message @param {string} userPath */
  constructor(message, userPath) {
    super(message);
    this.name = 'PathEscapeError';
    this.userPath = userPath;
  }
}

/**
 * Resolve a model-supplied path to an absolute path guaranteed to be inside `workspaceRoot`.
 *
 * Two checks:
 *  1. Lexical: `..` segments and absolute paths cannot leave the root.
 *  2. Physical: if the path (or its nearest existing ancestor) exists, its realpath must also be
 *     inside the root's realpath — so a symlink inside the workspace cannot point outside it.
 *     A *dangling* symlink (its target doesn't exist yet) is followed too: writing to it would
 *     create the target, wherever that is.
 *
 * Honest limit: check-then-use is two steps. A process that swaps a file for a symlink between
 * our check and the tool's open (a TOCTOU race) can still escape. Day 11's threat model says so.
 *
 * @param {string} workspaceRoot
 * @param {string} userPath
 * @returns {string} absolute path
 * @throws {PathEscapeError}
 */
export function resolveInWorkspace(workspaceRoot, userPath) {
  if (typeof userPath !== 'string' || userPath.trim() === '') throw new PathEscapeError('path must be a non-empty string', String(userPath));
  if (userPath.includes('\0')) throw new PathEscapeError('path must not contain NUL bytes', userPath);

  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, userPath);
  if (!isInside(root, resolved)) {
    throw new PathEscapeError(`path '${userPath}' is outside the workspace (${root})`, userPath);
  }

  const realRoot = fs.realpathSync(root);
  const realTarget = realpathOfNearestExisting(resolved);
  if (!isInside(realRoot, realTarget)) {
    throw new PathEscapeError(`path '${userPath}' resolves through a symlink to outside the workspace`, userPath);
  }
  return resolved;
}

/** True if `target` is `root` itself or somewhere below it. Uses path.relative — never startsWith. */
export function isInside(root, target) {
  const rel = path.relative(root, target);
  if (rel === '') return true;
  // `..` and `../x` leave the root. A name that merely starts with two dots (`..data`) does not.
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

const MAX_LINK_HOPS = 40; // the same order of limit the OS uses before ELOOP

/** realpath of the path if it exists, else realpath of its nearest existing ancestor + the rest. */
function realpathOfNearestExisting(p, hops = 0) {
  if (hops > MAX_LINK_HOPS) throw Object.assign(new Error(`too many symlinks resolving '${p}'`), { code: 'ELOOP' });
  let current = p;
  const rest = [];
  while (true) {
    try {
      return path.join(fs.realpathSync(current), ...rest);
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      // realpath fails on a dangling symlink, because its target doesn't exist. But the link does,
      // and opening it for writing would create that target. Follow it by hand, from the link's
      // real directory, and keep resolving from wherever it points.
      if (isSymlink(current)) {
        const target = path.resolve(fs.realpathSync(path.dirname(current)), fs.readlinkSync(current));
        return realpathOfNearestExisting(path.join(target, ...rest), hops + 1);
      }
      const parent = path.dirname(current);
      if (parent === current) return p;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
