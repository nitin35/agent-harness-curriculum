# Day 14 — Canonical Events, the Event Bus and the Printer

**Phase:** Week 3 — Interactive harness

## By tonight

```
$ node scripts/trace.js "How many files are in toy/?"
agent_start      {"userMessage":"How many files are in toy/?"}
turn_start       {"turn":1}
tool_call_start  {"id":"call_k2…","name":"bash","arguments":{"command":"ls toy | wc -l"}}
  allow bash {"command":"ls toy | wc -l"}? [y/N] y
tool_call_end    {"id":"call_k2…","name":"bash"}
tool_result      {"id":"call_k2…","name":"bash","content":"5","isError":false}
turn_end         {"turn":1,"usage":{"promptTokens":945,"completionTokens":164}}
turn_start       {"turn":2}
turn_end         {"turn":2,"usage":{"promptTokens":1125,"completionTokens":44}}
agent_end        {"response":"There are 5 files in toy/.","turns":2,"aborted":false}
✔ the trace follows the Day 6 event protocol
```

The harness now has **one fixed vocabulary** of events (`src/shared/events.js`), a small and strict bus to carry them, and a printer that writes them to the terminal sensibly.

## Why it matters

Tomorrow a human joins the loop. The UI needs to know what the loop is doing, and so do session saving (Day 19), approvals (Day 20), extensions (Day 22) and logs (Day 26). If each of them invents its own names, they drift apart. One frozen list, one bus, and **no aliases** keeps five subsystems speaking one language.

## Concepts

### 1. Canonical names, verbatim

**One official name for each thing that happens.** "Canonical" means *the* name, the one everybody uses. Since Day 12, the loop has been calling `this.emit(name, payload)` with names like `turn_start` and `tool_result`. Today those names get a home. Copy the [README's event list](README.md#canonical-event-list) into `src/shared/events.js`: frozen constants plus a payload `@typedef` for each. There are 16 core events and 3 UI events. You put the loop's events into your Day 6 design; some of them only start firing later: `thinking_delta` (Day 16), `command_run` (Day 18), `session_start`/`session_shutdown` (Day 19), the approval pair (Day 20) and `compaction` (Day 25). There is **no** `tool_call` and no `done`.

The file is mostly a frozen object of names:

```js
export const EVENTS = Object.freeze({
  AGENT_START: 'agent_start',
  TURN_START: 'turn_start',
  TOOL_RESULT: 'tool_result',
  // … one entry per event, 19 in all
});
```

`Object.freeze` (Day 2) means no module can add, rename or remove a name at run time. Code that uses `EVENTS.TOOL_RESULT` instead of the string `'tool_result'` also gets help from the editor: it autocompletes the names and can find every use.

**Why no aliases?** Pi calls a similar event `tool_call` (Day 6), and a "convenient" second name sounds harmless. But if the loop emits `tool_call_start` and an extension subscribes to `tool_call`, the extension's listener never runs, and nothing tells anyone. Two names for one thing guarantees that someone subscribes to the wrong one.

### 2. A strict bus

**The bus refuses names it doesn't know.** The `EventBus` throws when you `on()` or `emit()` a name that isn't canonical. A typo like `bus.on('tool_call', …)` then fails *loudly* the first time it runs, instead of silently never firing. (Pass `{ events: null }` for a general-purpose bus.)

```js
bus.on('tool_call', () => {});
// TypeError: unknown event 'tool_call' — use a name from src/shared/events.js

bus.emit(EVENTS.TOOL_RESLT, {});        // a typo in the constant's name gives undefined…
// TypeError: unknown event 'undefined' — use a name from src/shared/events.js
```

Compare Node's own `EventEmitter`, which accepts any name: subscribe to `tool_result`, emit `tool_reslt`, and the listener simply never runs. No error, no warning. That's the bug a strict bus exists to catch.

### 3. Bus semantics, decided and tested

**A bus is a list of callbacks per name.** `bus.on(name, listener)` adds a function to the list, and `bus.emit(name, payload)` calls each function on that list with the payload. The interesting decisions are about what happens when things go wrong:
- Listeners run in **registration order**.
- A listener that throws is reported through an injected `onError`. **The others still run, and `emit()` never throws.**
- `emit()` is **synchronous** and does not await async listeners. A rejected promise goes to `onError`.

From the reference bus, with three listeners on `turn_start`, the middle one throwing:

```js
bus.on('turn_start', () => order.push('first'));
bus.on('turn_start', () => { throw new Error('listener bug'); });
bus.on('turn_start', () => order.push('third'));
bus.emit('turn_start', { turn: 1 });    // returns normally
order                                   // → ['first', 'third']
// onError received: turn_start: listener bug
```

An async listener's rejection arrives later. Right after `emit` returns, `onError` hasn't been called yet. One tick later, it has. `emit` started the listener but never waited for it.

Why fire-and-forget? If `emit` awaited its listeners, it would become a hidden async API that callers could deadlock on. Anything that needs an *answer*, like an approval, is built as request/response **on top of** the bus (Day 20).

- `once()` removes its listener **before** running it, so a listener that throws or re-emits can't fire twice.

In the reference bus, a `once` listener that re-emits its own event runs exactly one time, and afterwards `listenerCount` is 0.

Python contrast: this is the observer pattern, the same idea as a list of callbacks you loop over. C++ contrast: like Qt's signals and slots, minus the type checking.

### 4. A listener registry

**Many subscribers, each listening by name.** Our bus has many subscribers, each listening by name: the UI, sessions, the logger, extensions. `Map<string, Set<listener>>` is the whole data structure. A `Set` keeps insertion order and makes `off` cheap.

```
'turn_start'  → Set { printTurn, logTurn }
'tool_result' → Set { printResult, saveToSession, extensionHook }
```

A `Set` holds each function once, so registering the same function twice has no effect. And because `on()` returns an unsubscribe function (a closure, like Day 9's `registerTool`), the caller doesn't have to remember the name and the function to remove it later.

**Iterate over a copy.** A `Set` that gains an item while you loop over it visits the new item in the same loop. So if a listener subscribes another listener during `emit`, iterating the live `Set` runs the newcomer immediately:

```js
for (const listener of set) listener(payload);        // ✗ a listener added during emit runs now
for (const listener of [...set]) listener(payload);   // ✓ it waits for the next emit
```

Pi also fans out to many listeners (`Agent.subscribe()`, Day 6), but every listener gets every event, and Pi *awaits* them. Ours are called by name, and `emit` never waits (concept 3).

### 5. A boring printer

**One small class decides how each kind of line looks.** `Printer` writes role-prefixed lines to a stream: `you> `, `agent> `, `  ⚙ ` (tool), `  · ` (system), `error> `. It also has `write()` for streamed chunks. With colour off, a few calls produce exactly:

```
you> hi
agent> hello
  ⚙ bash {"command":"ls"}
  · queued (1 waiting)
error> Cannot reach Ollama
```

Colour is **gated**:
- `'auto'` means colour only when `out.isTTY` is true and `NO_COLOR` is unset;
- `'always'` and `'never'` override.

**Why gate colour?** Colour comes from escape sequences (Day 4): `printTool('bash', 'ls')` with colour on writes `\x1b[36m  ⚙ bash ls\x1b[39m`, cyan on and cyan off. A terminal turns those into colour. A file, a pipe or a test receives the raw bytes, and `assert.equal(output, '  ⚙ bash ls\n')` fails on them. `isTTY` tells you which you have: `process.stdout.isTTY` is `true` when output goes to a terminal, and `undefined` when it goes to a pipe or a file. `NO_COLOR` is a convention users set to say "no colour anywhere, please".

No raw mode, no cursor movement: tests and pipes stay clean.

## Build

### 14.1 `src/shared/events.js` — Core

```js
export const EVENTS = Object.freeze({
  SESSION_START: 'session_start',
  /* … all 19 … */
  COMMAND: 'command',
});
export const CORE_EVENTS = Object.freeze([...]);   // 16
export const UI_EVENTS = Object.freeze([...]);     // 3
export const ALL_EVENTS = Object.freeze([...CORE_EVENTS, ...UI_EVENTS]);
export function isCanonicalEvent(name) { … }
/** @typedef {{ id: string, name: string, content: string, isError: boolean }} ToolResultPayload */
// … one typedef per event
```

Build `CORE_EVENTS` and `UI_EVENTS` from the `EVENTS` values (`EVENTS.AGENT_START`, …), so each name is written exactly once. `isCanonicalEvent` is a lookup in a `Set` made from `ALL_EVENTS`.

### 14.2 `src/events/event-bus.js` — Core

`class EventBus` with `constructor({ onError, events = ALL_EVENTS })`, plus `on(event, listener)` (returning an unsubscribe function), `once`, `off` (which also removes a `once` wrapper by its original function), `emit(event, payload)` and `listenerCount(event)`. Iterate over a **copy** of the set in `emit`, so listeners added during an emit wait for the next one.

Some hints:
- **`once`** registers a small *wrapper* function that calls `off` and then the real listener. Store the real listener on the wrapper (`wrapper.original = listener`), so `off(event, listener)` can find it.
- **`emit`** calls each listener inside `try/catch`. If a listener returns a promise (it has a `.then`), attach a rejection handler that reports to `onError`, and don't await it.
- **`onError`** is your code too, so call it inside its own `try/catch`: a broken error handler must not take the bus down with it.

### 14.3 `src/ui/printer.js` — Core

`class Printer` with `constructor({ out = process.stdout, color = 'auto', env = process.env })`, plus `style(text, name)`, `print(role, text)`, `write(text, style?)`, and the helpers `printUser`, `printAssistant`, `printTool(name, text)`, `printSystem` and `printError`.

A small table of roles keeps it short: `{ user: { prefix: 'you> ', style: 'bold' }, tool: { prefix: '  ⚙ ', style: 'cyan' }, … }`. Decide whether colour is on once, in the constructor. Then `style` either wraps the text in its escape codes or returns it unchanged. `out` and `env` are injected (Day 5), so a test can pass a fake stream and a fake environment.

### 14.4 Wire the loop to the bus, plus the course tests — Core

`new AgentLoop({ …, emit: (e, p) => bus.emit(e, p) })`. That's it: the loop has been emitting canonical names since Day 12. Copy `course-tests/day-14/` and make it pass. It checks:
- the exact event list, with no aliases;
- ordering, isolation and async rejection;
- `off`, `once` and strict mode;
- printer prefixes and the colour gate.

### 14.5 Trace script — Core

`scripts/trace.js` prints every event of one live run. Build it in four steps:
1. Wire `OllamaProvider` + registry + loop + bus, subscribe to **every** name in `ALL_EVENTS`, and print `name.padEnd(16) + JSON.stringify(payload)` (truncate long payloads).
2. Give it an approver that **asks you** `allow bash …? [y/N]` with Day 3's `rl.question`. Don't write a pattern that decides a command is safe: `ls; rm -rf ~` starts with `ls`, and `find . -delete` is a `find`. Pre-approving commands is a policy decision, and it gets its own day (Day 20).
3. Also collect the event names, and at the end print whether they pass your Day 6 checker, `checkTrace(names)` from `tests/helpers/event-protocol.js`.
4. Run it once and keep the output in `notes/day-14.md`. It's your map of what the UI will need to show.

`padEnd(16)` pads each name with spaces to 16 characters, which lines the payloads up in a column.

### 14.6 Real traces against your Day 6 protocol — Core

On Day 6 you wrote down which event orders a correct loop may produce. Now hold the real loop to it. In `tests/event-protocol-loop.test.js`, run `AgentLoop` on a `ScriptedProvider` with `emit: (event) => events.push(event)`, and assert `checkTrace(events).ok` for:
- a text-only answer;
- a tool turn, then the answer;
- an abort during the first of two tool calls (a test tool that calls `controller.abort()`);
- `maxTurns` running out;
- a provider that throws (`{ error: new Error('boom') }`): `run()` rejects, and the trace still ends with `agent_end`.

Each test has the same shape. The last one, for example:

```js
const events = [];
const provider = new ScriptedProvider([{ error: new Error('boom') }]);
const loop = new AgentLoop({
  provider,
  registry: new ToolRegistry(),
  emit: (event) => events.push(event),
});
await assert.rejects(loop.run('hi'), /boom/);
const r = checkTrace(events);            // events: agent_start → turn_start → agent_end
assert.equal(r.ok, true, r.error);
```

If a trace fails, decide which one is wrong, the loop or the design, and fix that one. Commit `day-14: events + bus + printer`.

### 14.7 Colour taste — Stretch

Force `color: 'always'`, print all roles, and look at the escape codes with `| cat -v`. Pick your palette. Add a `printThinking` that dims.

## Check

- [ ] `node --test tests/course/day14-*` green (12 tests)
- [ ] `scripts/trace.js` output saved in `notes/day-14.md`, and it passes `checkTrace`
- [ ] `node --test tests/event-protocol-loop.test.js` green: five real traces follow your Day 6 protocol
- [ ] `grep -rn "'tool_call'" src` finds nothing
- [ ] Commit `day-14: events + bus + printer`

Solution: `src/shared/events.js`, `src/events/event-bus.js`, `src/ui/printer.js` and `tests/event-protocol-loop.test.js` in [`solutions/checkpoint-2/`](solutions/checkpoint-2/).

## Stuck?

<details><summary>The <code>once</code> test fires twice</summary>

Inside the wrapper, call `this.off(event, wrapper)` **first**, then the listener. If the listener re-emits the same event before you've removed the wrapper, it runs again.
</details>

<details><summary>The async-rejection test sees the error too early, or never</summary>

In `emit`, if the listener's return value has a `.then`, attach `ret.then(undefined, (err) => onError(err, …))`. Don't `await` it. The test checks that nothing is reported until the next tick.
</details>

<details><summary><code>TypeError: unknown event 'undefined'</code></summary>

A constant name is misspelled: `EVENTS.TOOL_RESLT` doesn't exist, so it's `undefined`, and the strict bus refuses it. Check the spelling against `src/shared/events.js`; your editor's autocomplete helps here.
</details>

<details><summary>Colour codes show up in my test output, or colour never appears in my terminal</summary>

Check the gate. In tests, pass `color: 'never'` or a fake `out` without `isTTY`. In a terminal, check that `out` is `process.stdout` itself (not a wrapper that loses `isTTY`), and that `NO_COLOR` isn't set in your shell.
</details>

<details><summary>My trace has no <code>text_delta</code> lines</summary>

That's expected today. The loop calls the provider without streaming, so the answer arrives in one piece. Streaming, and the deltas, arrive on Day 16.
</details>

## Common mistakes

- "Convenient" aliases (`tool_call`, `done`) that extensions later subscribe to and never hear.
- An auto-approver that checks how a command *starts*. Chaining (`;`, `&&`, `|`) puts anything after it.
- An empty `catch {}` around listeners: errors vanish and nobody ever sees them.
- Iterating the live `Set` in `emit`, so a listener added mid-emit runs at once.
- ANSI escapes in piped output or tests.

## Self-check

1. Why refuse a `tool_call` alias even though Pi uses that name?
2. A listener throws mid-emit. What happens to the other listeners and to `emit`'s caller?
3. Why is `emit` fire-and-forget, and what does that rule out?
4. Who needs multiple subscribers by Day 22?

Answers: [self-check-answers.md](self-check-answers.md#day-14).

## Further reading

- Node.js, [`EventEmitter`](https://nodejs.org/api/events.html): compare its error semantics with yours (`'error'` events throw if unhandled!) · [`writeStream.isTTY`](https://nodejs.org/api/tty.html#writestreamistty)
- Wikipedia, [Observer pattern](https://en.wikipedia.org/wiki/Observer_pattern)
- [no-color.org](https://no-color.org/) · MDN, [`Set`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Set)

---
← [Buffer 1](buffer-1.md) · [Curriculum home](README.md) · Next: [Day 15 — Talk to your harness](day-15.md) →
