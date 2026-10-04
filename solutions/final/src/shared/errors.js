// src/shared/errors.js — one error vocabulary for the whole harness (Day 5).
//
// category tells the top-level handler (Day 26) how to talk to the user:
//   'user'     — bad flag, bad setting: print the message + usage hint, no stack
//   'provider' — network / model problems: print an actionable hint
//   'internal' — bugs: stack to the log file, short apology on stderr

export class HarnessError extends Error {
  /**
   * @param {string} message
   * @param {{ category?: 'user'|'provider'|'internal', cause?: unknown, hint?: string }} [opts]
   */
  constructor(message, { category = 'internal', cause, hint } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'HarnessError';
    this.category = category;
    if (hint) this.hint = hint;
  }
}

/** A bad command-line argument. `token` is the offending argv element. */
export class UsageError extends HarnessError {
  /** @param {string} message @param {{ token?: string, cause?: unknown }} [opts] */
  constructor(message, { token, cause } = {}) {
    super(message, { category: 'user', cause });
    this.name = 'UsageError';
    this.token = token;
  }
}

/** Input that failed a shape check. `field` names what was wrong. */
export class ValidationError extends HarnessError {
  /** @param {string} message @param {{ field?: string, category?: 'user'|'internal', cause?: unknown }} [opts] */
  constructor(message, { field, category = 'user', cause } = {}) {
    super(message, { category, cause });
    this.name = 'ValidationError';
    this.field = field;
  }
}

/**
 * A provider failure the user can act on.
 * kind: 'unreachable' | 'model_not_found' | 'bad_response' | 'http'
 */
export class ProviderError extends HarnessError {
  /** @param {string} message @param {{ kind: string, status?: number, cause?: unknown, hint?: string }} opts */
  constructor(message, { kind, status, cause, hint }) {
    super(message, { category: 'provider', cause, hint });
    this.name = 'ProviderError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

/** True for both kinds of cancellation `fetch` and friends produce. */
export function isAbortError(err) {
  return err?.name === 'AbortError' || err?.name === 'TimeoutError';
}
