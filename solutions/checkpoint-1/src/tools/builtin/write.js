// src/tools/builtin/write.js — create or overwrite a file (Day 10). Needs approval.
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveInWorkspace } from '../workspace-path.js';

/**
 * Parent-directory policy: missing parent directories are created (inside the jail only).
 * @param {{ root: string }} opts
 * @returns {import('../../shared/tool-schemas.js').ToolDefinition}
 */
export function createWriteTool({ root }) {
  return {
    name: 'write',
    label: 'Write file',
    description:
      'Create a file or overwrite it completely with `content`. Creates missing parent directories. ' +
      'Paths are relative to the workspace root. To change part of an existing file, prefer the edit tool.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root' },
        content: { type: 'string', description: 'The complete new file content' },
      },
      required: ['path', 'content'],
      additionalProperties: false, // invented arguments are refused by name (Day 9)
    },
    needsApproval: true,
    async execute({ path: userPath, content }) {
      let abs;
      try {
        abs = resolveInWorkspace(root, /** @type {string} */ (userPath));
      } catch (err) {
        return { content: `Cannot write: ${err.message}`, isError: true };
      }
      try {
        const existed = await fs.stat(abs).then(() => true, () => false);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, /** @type {string} */ (content), 'utf8');
        const byteLength = Buffer.byteLength(/** @type {string} */ (content), 'utf8');
        return {
          content: `${existed ? 'Overwrote' : 'Created'} ${userPath} (${byteLength} bytes).`,
          isError: false,
          details: { path: path.relative(root, abs), byteLength, created: !existed },
        };
      } catch (err) {
        if (err.code === 'EACCES') return { content: `Permission denied: ${userPath}`, isError: true };
        if (err.code === 'EISDIR') return { content: `Cannot write: '${userPath}' is a directory`, isError: true };
        return { content: `Cannot write ${userPath}: ${err.message}`, isError: true };
      }
    },
  };
}
