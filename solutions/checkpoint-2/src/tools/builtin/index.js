// src/tools/builtin/index.js — the four built-in tools, created for one workspace root.
import { createReadTool } from './read.js';
import { createWriteTool } from './write.js';
import { createEditTool } from './edit.js';
import { createBashTool } from './bash.js';

/** @param {{ root: string }} opts */
export function createBuiltinTools({ root }) {
  return [createReadTool({ root }), createWriteTool({ root }), createEditTool({ root }), createBashTool({ root })];
}
