// src/events/event-bus.js — a small, strict, failure-isolated event bus (Day 14).
import { ALL_EVENTS } from '../shared/events.js';

/**
 * Policies (decided, documented, tested):
 *  - Listeners run in registration order.
 *  - A throwing listener is reported through `onError`; the others still run; emit() never throws.
 *  - emit() is SYNCHRONOUS and does not await async listeners (fire-and-forget). A returned promise
 *    that rejects is reported through `onError`. Anything that needs an ANSWER (approvals, Day 20)
 *    is built as request/response on top of the bus, never by awaiting emit().
 *  - Strict by default: on()/emit() with a name outside the canonical list throws, so a typo like
 *    'tool_call' fails loudly instead of silently never firing. Pass `events: null` to allow any name.
 */
export class EventBus {
  /** @type {Map<string, Set<Function>>} */
  #listeners = new Map();
  #known;
  #onError;

  /**
   * @param {{ onError?: (err: unknown, info: { event: string }) => void, events?: readonly string[] | null }} [opts]
   */
  constructor({ onError = (err, { event }) => console.error(`[event-bus] listener for '${event}' failed:`, err), events = ALL_EVENTS } = {}) {
    this.#onError = onError;
    this.#known = events ? new Set(events) : null;
  }

  /**
   * @param {string} event
   * @param {(payload: any) => unknown} listener
   * @returns {() => void} unsubscribe
   */
  on(event, listener) {
    this.#check(event);
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    let set = this.#listeners.get(event);
    if (!set) this.#listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => this.off(event, listener);
  }

  /** Fire once, then remove itself — removed BEFORE it runs, so a throw or re-emit can't double-fire it. */
  once(event, listener) {
    const wrapper = (payload) => {
      this.off(event, wrapper);
      return listener(payload);
    };
    wrapper.original = listener;
    return this.on(event, wrapper);
  }

  /** Remove exactly this listener (also finds a once() wrapper by its original function). */
  off(event, listener) {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const l of set) {
      if (l === listener || /** @type {any} */ (l).original === listener) { set.delete(l); break; }
    }
    if (set.size === 0) this.#listeners.delete(event);
  }

  /** @param {string} event @param {object} [payload] */
  emit(event, payload = {}) {
    this.#check(event);
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) { // snapshot: listeners added during emit wait for the next one
      try {
        const ret = listener(payload);
        if (ret && typeof ret.then === 'function') ret.then(undefined, (err) => this.#report(err, event));
      } catch (err) {
        this.#report(err, event);
      }
    }
  }

  /** @param {string} event */
  listenerCount(event) { return this.#listeners.get(event)?.size ?? 0; }

  #check(event) {
    if (this.#known && !this.#known.has(event)) {
      throw new TypeError(`unknown event '${event}' — use a name from src/shared/events.js`);
    }
  }

  #report(err, event) {
    try { this.#onError(err, { event }); } catch { /* an error handler must never take the bus down */ }
  }
}
