// toy/loop.mjs — the agent loop, now a module (Day 2) that can be aborted (Day 3) and streams (Day 4).
import { bashToolSpec, runBash } from './bash-tool.mjs';

const DENIED = 'The user denied this command.';
const SKIPPED = 'Skipped: run aborted';

/**
 * Run turns until the model answers without tools, maxTurns is hit, or the signal aborts.
 * Appends the assistant and tool messages to `messages`: the history array is the loop's to grow,
 * but a message object is never changed once it has been pushed.
 *
 * @param {{
 *   client: { chat: Function },
 *   messages: object[],
 *   confirm: (command: string, opts: { signal?: AbortSignal }) => Promise<boolean>,
 *   runTool?: (command: string, opts: { signal?: AbortSignal }) => Promise<string>,
 *   signal?: AbortSignal,
 *   maxTurns?: number,
 *   onText?: (s: string) => void,
 *   onThinking?: (s: string) => void,
 * }} opts
 * @returns {Promise<{ text: string, turns: number, aborted: boolean }>}
 */
export async function runTurns({ client, messages, confirm, runTool = runBash, signal, maxTurns = 10, onText, onThinking }) {
  for (let turn = 1; turn <= maxTurns; turn++) {
    let reply;
    try {
      reply = await client.chat(messages, [bashToolSpec], { signal, onText, onThinking });
    } catch (err) {
      if (err.name === 'AbortError') return { text: '', turns: turn, aborted: true }; // Ctrl+C is a choice, not an error
      throw err;
    }
    messages.push(reply);
    if (!reply.tool_calls?.length) return { text: reply.content, turns: turn, aborted: false };

    for (const call of reply.tool_calls) {
      const content = await answerToolCall(call.function.arguments.command, { confirm, runTool, signal });
      // Every tool call gets a result, even a skipped one, so the history stays valid (the tool-pair invariant).
      messages.push({ role: 'tool', tool_name: call.function.name, tool_call_id: call.id, content });
    }
    if (signal?.aborted) return { text: '', turns: turn, aborted: true };
  }
  return { text: '(stopped: too many turns)', turns: maxTurns, aborted: false };
}

/** Ask, then run. An abort, even one that lands while the [y/N] question is open, makes the call "skipped". */
async function answerToolCall(command, { confirm, runTool, signal }) {
  if (signal?.aborted) return SKIPPED;
  try {
    const approved = await confirm(command, { signal });
    if (signal?.aborted) return SKIPPED;
    return approved ? await runTool(command, { signal }) : DENIED;
  } catch (err) {
    if (err.name === 'AbortError') return SKIPPED; // rl.question(…, { signal }) rejects like this on Ctrl+C
    throw err;
  }
}
