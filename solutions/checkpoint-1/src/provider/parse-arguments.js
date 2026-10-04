// src/provider/parse-arguments.js — wire arguments → plain object, at the boundary (Day 8).

/**
 * Wire arguments → plain object. Objects pass through; strings are parsed once.
 * Invalid JSON never throws: it becomes { arguments: {}, parseError } for the loop to report.
 * @param {unknown} raw
 * @returns {{ arguments: Record<string, unknown>, parseError?: string }}
 */
export function parseArguments(raw) {
  if (raw === undefined || raw === null || raw === '') return { arguments: {} };
  if (typeof raw === 'object' && !Array.isArray(raw)) return { arguments: /** @type {any} */ (raw) };
  if (typeof raw === 'string') {
    try {
      const value = JSON.parse(raw);
      if (value && typeof value === 'object' && !Array.isArray(value)) return { arguments: value };
      return { arguments: {}, parseError: `arguments must be a JSON object, got ${JSON.stringify(raw).slice(0, 200)}` };
    } catch (err) {
      return { arguments: {}, parseError: `arguments are not valid JSON (${err.message}): ${raw.slice(0, 200)}` };
    }
  }
  return { arguments: {}, parseError: `arguments must be a JSON object, got ${typeof raw}` };
}
