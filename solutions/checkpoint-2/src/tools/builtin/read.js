// src/tools/builtin/read.js — read a text file, a window of lines at a time (Day 10).
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveInWorkspace } from '../workspace-path.js';
import { truncateText } from '../truncate.js';

const DEFAULT_LIMIT = 2000;          // lines
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * @param {{ root: string }} opts
 * @returns {import('../../shared/tool-schemas.js').ToolDefinition}
 */
export function createReadTool({ root }) {
  return {
    name: 'read',
    label: 'Read file',
    description:
      'Read a UTF-8 text file in the workspace. Returns the file content. For large files, pass ' +
      '`offset` (1-based first line) and `limit` (number of lines) to read a window. Paths are relative ' +
      'to the workspace root. Cannot read binary files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root' },
        offset: { type: 'integer', description: 'First line to return, 1-based (default 1)' },
        limit: { type: 'integer', description: `Maximum number of lines (default ${DEFAULT_LIMIT})` },
      },
      required: ['path'],
      additionalProperties: false, // invented arguments are refused by name (Day 9)
    },
    readOnly: true,
    async execute({ path: userPath, offset = 1, limit = DEFAULT_LIMIT }) {
      let abs;
      try {
        abs = resolveInWorkspace(root, /** @type {string} */ (userPath));
      } catch (err) {
        return { content: `Cannot read: ${err.message}`, isError: true };
      }
      let buf;
      try {
        const stat = await fs.stat(abs);
        if (stat.isDirectory()) return { content: `Cannot read: '${userPath}' is a directory. Use bash \`ls\` to list it.`, isError: true };
        if (stat.size > MAX_FILE_BYTES) {
          return { content: `Cannot read: '${userPath}' is ${stat.size} bytes (limit ${MAX_FILE_BYTES}). Use bash with head, tail or grep.`, isError: true };
        }
        buf = await fs.readFile(abs);
      } catch (err) {
        if (err.code === 'ENOENT') return { content: `File not found: ${userPath}`, isError: true };
        if (err.code === 'EACCES') return { content: `Permission denied: ${userPath}`, isError: true };
        return { content: `Cannot read ${userPath}: ${err.message}`, isError: true };
      }

      const text = decodeText(buf);
      if (text === null) return { content: `Cannot read: '${userPath}' looks like a binary file.`, isError: true };

      // A final newline ends the last line; it doesn't start an empty one ('a\nb\n' is two lines).
      const finalNewline = text.endsWith('\n');
      const lines = text.split('\n');
      if (finalNewline) lines.pop();
      const start = Math.max(1, Math.trunc(Number(offset) || 1));
      const count = Math.max(1, Math.trunc(Number(limit) || DEFAULT_LIMIT));
      const window = lines.slice(start - 1, start - 1 + count);
      const end = start - 1 + window.length;
      let body = window.join('\n');
      if (start > 1 || end < lines.length) {
        body += `\n[showing lines ${start}-${end} of ${lines.length}. Use offset/limit to read more.]`;
      } else if (finalNewline) {
        body += '\n'; // the whole file: give it back exactly as it is on disk
      }
      const t = truncateText(body);
      return {
        content: t.content,
        isError: false,
        details: {
          path: path.relative(root, abs) || '.',
          totalLines: lines.length, startLine: start, endLine: end,
          truncated: t.truncated, byteLength: t.byteLength, shownBytes: t.shownBytes,
        },
      };
    },
  };
}

/** Decode UTF-8, or null for binary content (NUL byte or invalid UTF-8). */
export function decodeText(buf) {
  if (buf.subarray(0, 8192).includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}
