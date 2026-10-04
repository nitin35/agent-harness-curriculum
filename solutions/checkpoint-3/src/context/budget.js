// src/context/budget.js — where the window goes, and when to compact (Day 24; used by Day 25).

/**
 * The window that budgets use: the SMALLEST of what the provider will really give us
 * (getModelInfo().contextLimit — already min(num_ctx, model max) on Day 8) and an optional
 * settings cap. A settings number can only LOWER the limit, never raise it.
 * @param {number} providerLimit
 * @param {number|null|undefined} settingsCap
 */
export function effectiveContextLimit(providerLimit, settingsCap) {
  return typeof settingsCap === 'number' && settingsCap > 0 ? Math.min(providerLimit, settingsCap) : providerLimit;
}

/**
 * Reply reserve: generation happens AFTER the prompt. If the prompt fills the window there is no room
 * to answer — "fits" is not "answers". Reserve max(1024, 15%) of the window.
 */
export function replyReserve(limit) {
  return Math.max(1024, Math.floor(limit * 0.15));
}

/**
 * @param {{ limit: number, system: number, tools: number, history: number }} p  token counts
 * @returns {{ limit: number, reserve: number, usable: number, system: number, tools: number, history: number, used: number, free: number, overBy: number }}
 */
export function computeBudget({ limit, system, tools, history }) {
  const reserve = replyReserve(limit);
  const usable = limit - reserve;
  const used = system + tools + history;
  return { limit, reserve, usable, system, tools, history, used, free: Math.max(0, usable - used), overBy: Math.max(0, used - usable) };
}

/**
 * Did the SERVER cut the prompt? Ollama (native and /v1) silently drops the start of a prompt that doesn't
 * fit — HTTP 200, no error — and then reports how many tokens it actually processed. Far fewer than we
 * sent means it was cut. The estimate is rough (±30%), so only a big gap counts.
 * @param {number} sentEstimate          our estimate of the prompt we sent
 * @param {number|undefined} measured    the server's promptTokens for that call
 */
export function truncationSuspected(sentEstimate, measured) {
  return Number.isFinite(measured) && measured > 0 && measured < 0.6 * sentEstimate;
}

/** Compact when the prompt passes 80% of the effective window. */
export function shouldCompact(usedTokens, limit, threshold = 0.8) {
  return usedTokens > threshold * limit;
}

/** A small table for /context. */
export function formatBudget(b) {
  const pct = (n) => `${Math.round((100 * n) / b.limit)}%`.padStart(4);
  const row = (label, n) => `${label.padEnd(14)} ${String(n).padStart(7)} ${pct(n)}`;
  return [
    row('system prompt', b.system), row('tool schemas', b.tools), row('history', b.history),
    row('reply reserve', b.reserve), row('free', b.free), `${'window'.padEnd(14)} ${String(b.limit).padStart(7)}`,
    ...(b.overBy ? [`OVER BUDGET by ${b.overBy} tokens — compaction needed`] : []),
  ].join('\n');
}
