// src/ui/completer.js — Tab completion for /commands and @paths (Day 28).
import { findCandidates } from './file-finder.js';

/**
 * readline calls completer(line) on Tab and expects [candidates, substringBeingCompleted].
 * It completes the common prefix itself and lists the candidates on a second Tab — no TUI needed.
 * @param {{ commands: import('../commands/registry.js').CommandRegistry, root: string, limit?: number }} opts
 * @returns {(line: string) => Promise<[string[], string]>}
 */
export function createCompleter({ commands, root, limit = 8 }) {
  return async (line) => {
    if (/^\/\S*$/.test(line)) {
      const names = commands.list().flatMap((c) => [c.name, ...(c.aliases ?? [])]).map((n) => `/${n}`);
      const hits = names.filter((n) => n.startsWith(line));
      return [hits.length ? hits : names, line];
    }
    const m = /(?:^|\s)@(\S*)$/.exec(line);
    if (m) {
      const token = `@${m[1]}`;
      const files = await findCandidates(root, m[1], { limit });
      return [files.map((f) => `@${f}`), token];
    }
    return [[], line];
  };
}
