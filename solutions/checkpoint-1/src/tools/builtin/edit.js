// src/tools/builtin/edit.js — replace ONE exact, unique snippet in a file (Day 11). Needs approval.
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveInWorkspace } from '../workspace-path.js';

/**
 * @param {{ root: string }} opts
 * @returns {import('../../shared/tool-schemas.js').ToolDefinition}
 */
export function createEditTool({ root }) {
  return {
    name: 'edit',
    label: 'Edit file',
    description:
      'Replace one exact snippet of an existing file. `oldString` must appear exactly once in the file ' +
      '(copy it from a read result, including whitespace and indentation); it is replaced by `newString`. ' +
      'If it appears more than once, include more surrounding lines to make it unique. Line endings follow the file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root' },
        oldString: { type: 'string', description: 'Exact text to replace; must be unique in the file' },
        newString: { type: 'string', description: 'Replacement text' },
      },
      required: ['path', 'oldString', 'newString'],
      additionalProperties: false, // invented arguments are refused by name (Day 9)
    },
    needsApproval: true,
    async execute({ path: userPath, oldString, newString }) {
      const p = String(userPath);
      const oldS = String(oldString);
      const newS = String(newString);
      if (oldS === '') return { content: 'oldString must not be empty. Use the write tool to create a file.', isError: true };

      let abs;
      try {
        abs = resolveInWorkspace(root, p);
      } catch (err) {
        return { content: `Cannot edit: ${err.message}`, isError: true };
      }
      let text;
      try {
        text = await fs.readFile(abs, 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') return { content: `File not found: ${p}`, isError: true };
        return { content: `Cannot edit ${p}: ${err.message}`, isError: true };
      }

      // Models write \n. In a file that uses \r\n, match and replace in the file's own line endings:
      // the model can't reproduce the \r it never sees, and the file shouldn't end up with mixed endings.
      const crlf = text.includes('\r\n');
      const fileOld = crlf ? toCrlf(oldS) : oldS;
      const fileNew = crlf ? toCrlf(newS) : newS;

      const count = countOccurrences(text, fileOld);
      if (count === 0) {
        return { content: `oldString not found in ${p}. Read the file and copy the exact text, including whitespace.`, isError: true };
      }
      if (count > 1) {
        return { content: `oldString matches ${count} times in ${p}. Include more surrounding lines so it matches exactly once.`, isError: true };
      }

      const at = text.indexOf(fileOld);
      const updated = text.slice(0, at) + fileNew + text.slice(at + fileOld.length);
      await fs.writeFile(abs, updated, 'utf8');
      // The diff is for the model to read, so show it with plain \n line endings.
      const diff = crlf
        ? unifiedDiff(path.relative(root, abs), toLf(text), toLf(text.slice(0, at)).length, toLf(fileOld), toLf(fileNew))
        : unifiedDiff(path.relative(root, abs), text, at, oldS, newS);
      return { content: `Edited ${p}.\n${diff}`, isError: false, details: { path: path.relative(root, abs), diff } };
    },
  };
}

const toCrlf = (s) => s.replace(/\r?\n/g, '\r\n');
const toLf = (s) => s.replace(/\r\n/g, '\n');

export function countOccurrences(haystack, needle) {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count++;
  return count;
}

/** A small unified diff of the whole lines touched by the replacement. */
export function unifiedDiff(file, text, at, oldS, newS) {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  const endNl = text.indexOf('\n', at + oldS.length);
  const lineEnd = endNl === -1 ? text.length : endNl;
  const before = text.slice(lineStart, lineEnd).split('\n');
  const after = (text.slice(lineStart, at) + newS + text.slice(at + oldS.length, lineEnd)).split('\n');
  const firstLine = text.slice(0, lineStart).split('\n').length;
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${firstLine},${before.length} +${firstLine},${after.length} @@`,
    ...before.map((l) => `-${l}`),
    ...after.map((l) => `+${l}`),
  ].join('\n');
}
