// src/context/token-estimator.js — how big is the prompt? (Day 24)
//
// Two sources of truth, used together:
//   1. ESTIMATE: ~4 characters per token. Real tokenizers differ by 10–30% (code and non-English text
//      cost more). Fine for budgeting, never for billing.
//   2. MEASUREMENT: every response reports usage.promptTokens — what the server actually counted for the
//      prompt that produced it. The best estimate of "now" is that number + the reply + an estimate of
//      only what was added since. That is calibration: the estimator only covers the small, recent part.

const PER_MESSAGE_OVERHEAD = 4; // role markers / separators

/** @param {string} text */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

/** @param {import('../shared/message-schemas.js').AgentMessage} m */
export function estimateMessageTokens(m) {
  let n = PER_MESSAGE_OVERHEAD + estimateTokens(m.content);
  if (m.thinking) n += estimateTokens(m.thinking);
  if (m.toolCalls?.length) n += estimateTokens(JSON.stringify(m.toolCalls));
  return n;
}

/** Tool schemas are sent on every call and cost real tokens before the first message. */
export function estimateToolTokens(tools) {
  return tools?.length ? estimateTokens(JSON.stringify(tools)) : 0;
}

/**
 * Pure estimate of a whole prompt.
 * @param {{ systemPrompt?: string, messages: import('../shared/message-schemas.js').AgentMessage[], tools?: object[] }} p
 */
export function estimateTotalContext({ systemPrompt = '', messages, tools = [] }) {
  return estimateTokens(systemPrompt) + PER_MESSAGE_OVERHEAD + estimateToolTokens(tools) + messages.reduce((s, m) => s + estimateMessageTokens(m), 0);
}

/**
 * Calibrated estimate: find the LAST assistant message that carries usage. Everything up to it was
 * measured by the server (promptTokens + completionTokens); estimate only the messages after it.
 * Falls back to the pure estimate when no usage is known.
 * @param {{ systemPrompt?: string, messages: import('../shared/message-schemas.js').AgentMessage[], tools?: object[] }} p
 * @returns {{ tokens: number, measured: number, estimated: number }}
 */
export function calibratedContextTokens({ systemPrompt = '', messages, tools = [] }) {
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].usage?.promptTokens) { idx = i; break; }
  }
  if (idx === -1) {
    const t = estimateTotalContext({ systemPrompt, messages, tools });
    return { tokens: t, measured: 0, estimated: t };
  }
  const u = messages[idx].usage;
  const measured = (u.promptTokens ?? 0) + (u.completionTokens ?? 0);
  const estimated = messages.slice(idx + 1).reduce((s, m) => s + estimateMessageTokens(m), 0);
  return { tokens: measured + estimated, measured, estimated };
}
