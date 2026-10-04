// src/context/compaction.js — WHERE to cut the active path, and WHAT replaces the cut part (Day 25). Pure functions.
import { truncateText } from '../tools/truncate.js';

/**
 * Invariants (README "Tool-pair history invariant"):
 *   1. keep the last `keepMessages` entries (a starting point, then adjusted)
 *   2. NEVER summarize the latest user message: the boundary may not pass it
 *   3. NEVER split a tool pair: an assistant message with toolCalls and ALL its tool_result messages
 *      are kept together or folded together. If the boundary lands inside a pair it moves FORWARD past
 *      the pair. (Because rule 2 clamped the boundary first, moving forward always stops at or before
 *      the latest user message: a pair's results are followed by a non-result entry, at the latest by it.)
 *   4. folding a single existing compaction entry into a new one is pointless churn → nothing to do
 *
 * @param {import('../shared/session.js').SessionEntry[]} path  the ACTIVE path (getPath()), never getEntries()
 * @param {{ keepMessages?: number }} [opts]
 * @returns {{ boundary: number, summarized: any[], kept: any[] } | null}
 */
export function planCompaction(path, { keepMessages = 6 } = {}) {
  if (path.length === 0) return null;
  let b = path.length - keepMessages;
  if (b <= 0) return null;

  const lastUser = findLastIndex(path, (e) => e.type === 'message' && e.message.role === 'user');
  if (lastUser !== -1 && b > lastUser) b = lastUser;

  while (b < path.length && isToolResult(path[b])) b++; // inside a pair → move past its last result

  if (b <= 0 || b >= path.length) return null; // nothing to summarize, or nothing would be kept
  const summarized = path.slice(0, b);
  if (summarized.length === 1 && summarized[0].type === 'compaction') return null;
  return { boundary: b, summarized, kept: path.slice(b) };
}

/** A tool result as the first KEPT entry would be cut off from its call — that is "inside a pair". */
const isToolResult = (e) => e?.type === 'message' && e.message.role === 'tool_result';
function findLastIndex(arr, pred) { for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i; return -1; }

/**
 * The text that replaces the summarized entries (Core: a truncated transcript, NOT an LLM summary).
 * It keeps the FRONT of the dropped conversation — usually the original task — up to maxBytes, with the
 * standard truncation marker. The Stretch replaces it with an LLM-written summary.
 * @param {any[]} summarized
 * @param {number} maxBytes  pick relative to the window: a 32 KiB cap is ~8k tokens — a whole 8k window!
 */
// In the summary, a tool result is the one thing that can be recovered later (read the file again), and
// it is usually the bulkiest line. Keep only a taste of each, so the user/assistant turns — the task,
// decisions, the newest context — are what fills the cap.
const TOOL_RESULT_TASTE = 160;

export function compactionText(summarized, maxBytes) {
  const lines = summarized.map((e) => {
    if (e.type === 'compaction') return `[earlier summary]\n${e.content}`;
    const m = e.message;
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const calls = m.toolCalls.map((c) => `${c.name} ${JSON.stringify(c.arguments)}`).join('; ');
      return `assistant: ${m.content ? `${m.content} ` : ''}[called ${calls}]`;
    }
    if (m.role === 'tool_result') {
      const taste = m.content.length > TOOL_RESULT_TASTE
        ? `${m.content.slice(0, TOOL_RESULT_TASTE)}… [${Buffer.byteLength(m.content)} bytes; re-read if needed]`
        : m.content;
      return `tool ${m.toolName ?? ''}${m.isError ? ' (error)' : ''}: ${taste}`;
    }
    return `${m.role}: ${m.content}`;
  });
  // Cut head AND tail (Day 11): the task is at the start, the newest summarized context at the end.
  return truncateText(lines.join('\n'), maxBytes, { keep: 'head+tail' }).content;
}

/**
 * Shorten the OLDER tool results of the CURRENT run in place, when the run itself is too big to fit
 * (one request, many large tool reads). Every call/result pair is kept — the protocol stays valid —
 * but bulky old output is replaced by a short, re-readable note. The most recent `keepLast` results are
 * left whole, because the model just asked for them. Returns how many were shortened.
 * @param {import('../shared/message-schemas.js').AgentMessage[]} messages  mutated in place
 * @param {{ keepLast?: number, perResultBytes?: number }} [opts]
 */
export function shortenOldToolResults(messages, { keepLast = 1, perResultBytes = 200 } = {}) {
  const idx = messages.map((m, i) => (m.role === 'tool_result' ? i : -1)).filter((i) => i >= 0);
  const protect = new Set(idx.slice(-keepLast));
  let count = 0;
  for (const i of idx) {
    if (protect.has(i)) continue;
    const m = messages[i];
    if (m.content.startsWith('[cleared:') || Buffer.byteLength(m.content) <= perResultBytes) continue;
    messages[i] = { ...m, content: `[cleared: ${Buffer.byteLength(m.content)} bytes of earlier tool output — read the file again if you still need it]` };
    count++;
  }
  return count;
}
