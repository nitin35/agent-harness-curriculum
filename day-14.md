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

Read it from the top. Each line starts with the name of an event the loop emitted, and the payload it carried follows as JSON. One line is not an event: `allow bash …? [y/N]` is the approver asking you, and it sits between `tool_call_start` and `tool_call_end` because that's where the loop waits for your answer. In turn 1 the model asks for a tool. Turn 2 has no tool calls, because the model answers instead. The last line is your Day 6 protocol checker, holding a real run to the rules you wrote down then.

Behind that output, the harness now has **one fixed vocabulary** of events (`src/shared/events.js`), a small and strict bus to carry them, and a printer that writes them to the terminal sensibly.

## Why it matters

Previously, on Day 13, the engine reached Checkpoint 1: it runs, it stops cleanly when you press Ctrl+C, and its tests pass with Ollama switched off. Since Day 12 it has also been announcing what it does, calling `this.emit(name, payload)` at every step. So far only tests have been listening.

Tomorrow a human joins the loop, and the UI needs to know what the loop is doing. So do approvals (Day 20), extensions (Day 22) and logs (Day 26), and from Day 19 the session code puts its own events on the same stream. That's five subsystems sharing one stream of events, written on different days for different reasons, and every one of them is a chance to get a name slightly wrong. Say an extension subscribes to `tool_call`, because that's what another harness calls it, while the loop emits `tool_call_start`. Nothing fails. The extension's listener never runs, and the first sign of trouble is a feature that quietly does nothing. Or say the UI's listener has a bug and throws on an odd payload. If that throw travels back into the loop, the run dies halfway through a turn because of a display bug.

Today fixes both before the listeners arrive. One frozen list of names, one bus that refuses any other name and keeps each listener's failures to itself, and **no aliases**, keep five subsystems speaking one language.

## Concepts

### 1. Canonical names, verbatim

Start with the names. "Canonical" means *the* name: the one official name for each thing that happens, which everybody uses. Since Day 12 the loop has emitted names like `turn_start` and `tool_result` as plain strings, and today those names get a home. Copy the [README's event list](README.md#canonical-event-list) into `src/shared/events.js` as frozen constants, plus a payload `@typedef` for each event. There are 16 core events and 3 UI events.

You designed the loop's part of this list on Day 6. Not every name fires yet, though. Some start later in the course: `text_delta` and `thinking_delta` (Day 16), `command_run` (Day 18), `session_start`/`session_shutdown` (Day 19), the approval pair (Day 20) and `compaction` (Day 25). Putting them on the list today means every subsystem is written against the whole vocabulary from the start. And the list has **no** `tool_call` and no `done`.

The file is mostly a frozen object of names:

```js
export const EVENTS = Object.freeze({
  AGENT_START: 'agent_start',
  TURN_START: 'turn_start',
  TOOL_RESULT: 'tool_result',
  // … one entry per event, 19 in all
});
```

`Object.freeze` (Day 2) means no module can add, rename or remove a name while the program runs. Writing the constant `EVENTS.TOOL_RESULT` instead of the string `'tool_result'` also gets you help from the editor, which autocompletes the names and can find every place one is used.

Now the aliases. Pi has a hook event called `tool_call` (Day 6), so a second, "convenient" name for `tool_call_start` sounds harmless. It isn't, for the reason in *Why it matters*: if the loop emits `tool_call_start` and an extension subscribes to `tool_call`, the extension's listener never runs, and nothing tells anyone. Two names for one thing guarantee that sooner or later someone subscribes to the wrong one.

A list of names only helps, though, if something enforces it.

### 2. A strict bus

That's the bus's first job. The `EventBus` throws when you call `on()` or `emit()` with a name that isn't canonical, so a typo like `bus.on('tool_call', …)` fails *loudly* the first time that line runs, instead of silently never firing. (Pass `{ events: null }` when you want a general-purpose bus that accepts any name.)

```js
bus.on('tool_call', () => {});
// TypeError: unknown event 'tool_call' — use a name from src/shared/events.js

bus.emit(EVENTS.TOOL_RESLT, {});        // a typo in the constant's name gives undefined…
// TypeError: unknown event 'undefined' — use a name from src/shared/events.js
```

The second case is worth a closer look. `EVENTS.TOOL_RESLT` is a misspelt property, and reading a property that doesn't exist gives `undefined`, not an error (Day 2). So the bus receives `undefined` as the event name, and refuses it.

Compare Node's own `EventEmitter`, which accepts any name at all. Subscribe to `tool_result`, emit `tool_reslt`, and the listener never runs. There's no error and no warning. `emit` returns `false`, which means only "nobody was listening", and almost no code checks it. That's the bug a strict bus exists to catch.

Names are the easy half. The harder half is what the bus does when a listener misbehaves.

### 3. Bus semantics, decided and tested

A bus is a list of callbacks per name. `bus.on(name, listener)` adds a function to the list for that name, and `bus.emit(name, payload)` calls each function on the list, passing it the payload. A *listener* is any function you hand to `on`. The interesting decisions are all about what happens when things go wrong:
- Listeners run in **registration order**.
- A listener that throws is reported through an injected `onError`. **The others still run, and `emit()` never throws.**
- `emit()` is **synchronous** and does not await async listeners. A rejected promise goes to `onError`.

The first rule makes the output predictable: whoever subscribed first hears the event first. The second is the protection from *Why it matters*, and Node's `EventEmitter` doesn't give it. When one of its listeners throws, the error comes straight out of `emit()`, and the listeners after it never run. Give it three listeners on `turn_start`, with the middle one throwing, and it runs the first, then throws `listener bug` at whoever called `emit`, which for us would be the loop. The third never runs. The reference bus, given the same three listeners, runs the other two and reports the error instead:

```js
bus.on('turn_start', () => order.push('first'));
bus.on('turn_start', () => { throw new Error('listener bug'); });
bus.on('turn_start', () => order.push('third'));
bus.emit('turn_start', { turn: 1 });    // returns normally
order                                   // → ['first', 'third']
// onError received: turn_start: listener bug
```

The third rule needs more care, because it's about time. An `async` function runs synchronously until its first `await`, and at that point it returns a pending promise to its caller (Day 3). So when `emit` calls an async listener, the listener runs its first part, pauses, and hands `emit` a promise. `emit` does not wait for that promise. It goes on to the next listener, then returns to its own caller, and the rest of the listener runs later, as a microtask, once the code that called `emit` has finished. That is what *fire-and-forget* means: `emit` starts every listener and waits for none of them.

Here's the order of events in a general example, a shop where the kitchen listens for new orders and its oven happens to be off:

```js run
const listeners = [];
const on = (fn) => listeners.push(fn);
function emit(order) {
  for (const fn of listeners) {
    try {
      const ret = fn(order);
      if (ret && typeof ret.then === 'function') {
        ret.then(undefined, (err) => console.log(`5. reported: ${err.message}`));
      }
    } catch (err) {
      console.log(`reported at once: ${err.message}`);
    }
  }
}
on(async (order) => {
  console.log(`2. kitchen starts order ${order.id}`);
  await null;
  console.log('4. kitchen resumes');
  throw new Error('the oven is off');
});
console.log('1. emit');
emit({ id: 7 });
console.log('3. emit has returned');
// → 1. emit
// → 2. kitchen starts order 7
// → 3. emit has returned
// → 4. kitchen resumes
// → 5. reported: the oven is off
```

Follow the numbers. `emit` calls the kitchen listener, which prints 2 and pauses at `await null`. The listener hands `emit` a pending promise, `emit` attaches a rejection handler to it and returns, and so 3 prints while the kitchen is still paused. Only when the code that called `emit` has finished does the event loop run the microtask that resumes the kitchen (4). Its throw rejects the promise, and the handler that `emit` attached reports the error (5).

Notice what the `try/catch` around `fn(order)` caught: nothing. It couldn't, because the error happened after `emit` had returned. Even an async listener that throws on its very first line doesn't throw to its caller. The `async` function catches the error itself and returns a rejected promise instead. That's why the bus has to look at what each listener returns and attach a handler to any promise. Leave the handler out, and the rejection has no handler at all, so Day 3's rule applies: Node prints the error and exits with code 1. Run this in a file:

```js
function emit(listeners, payload) {
  for (const fn of listeners) { try { fn(payload); } catch { /* catches nothing here */ } }
}
emit([async () => { throw new Error('the oven is off'); }], {});
console.log('emit returned');
setTimeout(() => console.log('still running'), 50);
```

```
emit returned
file:///…/emit.mjs:4
emit([async () => { throw new Error('the oven is off'); }], {});
                          ^

Error: the oven is off
```

`emit returned` prints, and `still running` never does. One async listener with a bug, on a bus without that handler, takes the whole harness down as soon as the current microtasks have run, with a stack trace that points at the listener and not at the bus. With the handler, the same bug becomes one line from `onError`. The course test checks exactly this timing. Right after `emit` returns, `onError` hasn't been called. After one `setImmediate`, a macrotask, which means every microtask has run by then, it has.

Why fire-and-forget, rather than having `emit` await each listener? Day 6 ran both versions with a save that takes 50 ms. Awaiting gives you order (the session is on disk before the next turn starts), but it makes the loop as slow as its slowest listener, and a listener that never settles stops the agent for good. It would also make `emit` a hidden async API that every caller must remember to await, and hidden waits are where deadlocks come from: a `turn_end` listener that waits for the run to finish would wait forever, because the run would be waiting for it. So `emit` never waits. Anything that needs an *answer*, like an approval, is built as request/response **on top of** the bus (Day 20).

The last rule is about `once()`: it removes its listener **before** running it, so a listener that throws or re-emits can't fire twice. Picture a `once` listener on `turn_start` that emits `turn_start` itself. If the wrapper ran the listener first and removed it afterwards, the inner `emit` would find the listener still registered and run it again, from inside its own first run, and again from inside that. With the order swapped in the reference bus, that listener ran 1,943 times before JavaScript ran out of stack. Removed first, it runs exactly one time, and afterwards `listenerCount` is 0.

Python contrast: this is the observer pattern, the same idea as a list of callbacks you loop over. The async part is where Python differs. Calling an `async def` function in Python runs none of its body: it only creates a coroutine object, and if nothing awaits it or schedules it as a task, it never runs at all (Python warns `coroutine 'listener' was never awaited`). A JavaScript async listener always starts running the moment it's called, whether anyone awaits it or not. C++ contrast: the bus is close to Qt's signals and slots, minus the type checking.

With the rules settled, the data structure behind them is small.

### 4. A listener registry

The bus has many subscribers, each listening by name: the UI, sessions, the logger, extensions. For any name it has to find that name's listeners, and `Map<string, Set<listener>>` is the whole data structure, a `Map` from each event name to a `Set` of functions:

```
'turn_start'  → Set { printTurn, logTurn }
'tool_result' → Set { printResult, saveToSession, extensionHook }
```

A `Set` keeps insertion order, which gives you the registration-order rule for free, and it makes `off` cheap. It also holds each value once, so registering the same function twice has no effect. And because `on()` returns an unsubscribe function (a closure, like the one Day 9's `registerTool` returns), the caller doesn't have to keep the name and the function around to remove the listener later.

There's one trap in looping over a `Set`, and it has nothing to do with events. A `for…of` loop over a `Set` also visits items that are added *during* the loop. Here a host greets party guests, and Cleo arrives while Ben is being greeted:

```js run
const guests = new Set(['Ana', 'Ben']);
for (const guest of guests) {
  console.log(`hello, ${guest}`);
  if (guest === 'Ben') guests.add('Cleo');     // arrives during the loop
}
// → hello, Ana
// → hello, Ben
// → hello, Cleo         greeted in the same loop

const party = new Set(['Ana', 'Ben']);
for (const guest of [...party]) {             // a copy, taken before the loop starts
  console.log(`hello, ${guest}`);
  if (guest === 'Ben') party.add('Cleo');
}
// → hello, Ana
// → hello, Ben          Cleo is in the set now, but waits for the next round
```

The bus meets the same trap when a listener subscribes another listener during `emit`. Loop over the live `Set` and the newcomer runs at once, for an event that happened before it subscribed. Loop over a copy and it waits for the next `emit`:

```js
for (const listener of set) listener(payload);        // ✗ a listener added during emit runs now
for (const listener of [...set]) listener(payload);   // ✓ it waits for the next emit
```

Pi also fans out to many listeners (`Agent.subscribe()`, Day 6), but there every listener gets every event, and Pi *awaits* them. Ours subscribe by name, and `emit` never waits (concept 3).

That's everything the bus does. The last piece decides what the user actually sees.

### 5. A boring printer

"Boring" is a compliment here. The terminal is where the user reads the agent, but tests and pipes read the same output, so it should be plain, predictable lines. One small class, `Printer`, decides how each kind of line looks. It writes role-prefixed lines to a stream: `you> `, `agent> `, `  ⚙ ` (tool), `  · ` (system), `error> `. It also has `write()` for streamed chunks, which arrive without a newline. With colour off, a few calls produce exactly:

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

The gate exists because colour isn't part of the text. It's made of escape sequences (Day 4), bytes that a terminal reads as commands. With colour on, `printTool('bash', 'ls')` writes `\x1b[36m  ⚙ bash ls\x1b[39m`: cyan on, the text, cyan off. A terminal turns that into cyan text. A file, a pipe or a test receives the raw bytes instead, and `assert.equal(output, '  ⚙ bash ls\n')` fails on them. `isTTY` tells you which kind of output you have: `process.stdout.isTTY` is `true` when output goes to a terminal, and `undefined` when it goes to a pipe or a file. `NO_COLOR` is a convention users set in their shell to say "no colour anywhere, please".

There's no raw mode and no cursor movement either, so tests and pipes stay clean. Tomorrow's UI writes everything through this printer.

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

Build `CORE_EVENTS` and `UI_EVENTS` from the `EVENTS` values (`EVENTS.AGENT_START`, …), so each name is written exactly once. That's the no-aliases rule applied to your own file: if `'tool_result'` were typed in two places, one typo would leave you with two lists that disagree. `isCanonicalEvent` is a lookup in a `Set` made from `ALL_EVENTS`. This file comes first because the bus, the tests and, later, every subsystem import their names from it.

### 14.2 `src/events/event-bus.js` — Core

`class EventBus` with `constructor({ onError, events = ALL_EVENTS })`, plus `on(event, listener)` (returning an unsubscribe function), `once`, `off` (which also removes a `once` wrapper by its original function), `emit(event, payload)` and `listenerCount(event)`. Iterate over a **copy** of the set in `emit`, so listeners added during an emit wait for the next one.

This is concepts 2 to 4 in code. Each hint below covers a place where a small slip breaks one of the rules:
- **`once`** registers a small *wrapper* function that calls `off` and then the real listener. Store the real listener on the wrapper (`wrapper.original = listener`), so `off(event, listener)` can find it.
- **`emit`** calls each listener inside `try/catch`. If a listener returns a promise (it has a `.then`), attach a rejection handler that reports to `onError`, and don't await it.
- **`onError`** is your code too, so call it inside its own `try/catch`: a broken error handler must not take the bus down with it.

The `try/catch` handles listeners that throw straight away, and the rejection handler handles the async ones that fail later. As the kitchen example showed, you need both, because neither catches what the other does.

### 14.3 `src/ui/printer.js` — Core

`class Printer` with `constructor({ out = process.stdout, color = 'auto', env = process.env })`, plus `style(text, name)`, `print(role, text)`, `write(text, style?)`, and the helpers `printUser`, `printAssistant`, `printTool(name, text)`, `printSystem` and `printError`.

A small table of roles keeps it short: `{ user: { prefix: 'you> ', style: 'bold' }, tool: { prefix: '  ⚙ ', style: 'cyan' }, … }`. Decide whether colour is on once, in the constructor. Then `style` either wraps the text in its escape codes or returns it unchanged. `out` and `env` are injected (Day 5), so a test can pass a fake stream and a fake environment.

Deciding once means every line of a run agrees: you never get half a session in colour because something changed `NO_COLOR` along the way. And because `out` is injected, the course tests can hand the printer a fake stream that records what was written, with `isTTY` set to whatever the test needs.

### 14.4 Wire the loop to the bus, plus the course tests — Core

`new AgentLoop({ …, emit: (e, p) => bus.emit(e, p) })`. That's it: the loop has been emitting canonical names since Day 12. Copy `course-tests/day-14/` and make it pass. It checks:
- the exact event list, with no aliases;
- ordering, isolation and async rejection;
- `off`, `once` and strict mode;
- printer prefixes and the colour gate.

The loop needs no other change, because Day 12 gave it an `emit` option for exactly this. From now on, anything that subscribes to the bus hears every run.

### 14.5 Trace script — Core

`scripts/trace.js` prints every event of one live run. Build it in four steps:
1. Wire `OllamaProvider` + registry + loop + bus, subscribe to **every** name in `ALL_EVENTS`, and print `name.padEnd(16) + JSON.stringify(payload)` (truncate long payloads).
2. Give it an approver that **asks you** `allow bash …? [y/N]` with Day 3's `rl.question`. Don't write a pattern that decides a command is safe: `ls; rm -rf ~` starts with `ls`, and `find . -delete` is a `find`. Pre-approving commands is a policy decision, and it gets its own day (Day 20).
3. Also collect the event names, and at the end print whether they pass your Day 6 checker, `checkTrace(names)` from `tests/helpers/event-protocol.js`.
4. Run it once and keep the output in `notes/day-14.md`. It's your map of what the UI will need to show.

`padEnd(16)` pads each name with spaces to 16 characters, which lines the payloads up in a column, as in *By tonight*. Step 1 subscribes to every name, including the ones that don't fire yet, so the trace will pick them up on the days they start.

### 14.6 Real traces against your Day 6 protocol — Core

On Day 6 you wrote down which event orders a correct loop may produce. Now hold the real loop to it. In `tests/event-protocol-loop.test.js`, run `AgentLoop` on a `ScriptedProvider` with `emit: (event) => events.push(event)`, and assert `checkTrace(events).ok` for:
- a text-only answer;
- a tool turn, then the answer;
- an abort during the first of two tool calls (a test tool that calls `controller.abort()`);
- `maxTurns` running out;
- a provider that throws (`{ error: new Error('boom') }`): `run()` rejects, and the trace still ends with `agent_end`.

Between them, these cover every way a run can end in Day 13's table: an answer, `maxTurns`, an abort and a thrown error. Each test has the same shape. The last one, for example:

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

The harness now has one vocabulary of 19 events, written once and frozen, and a bus that enforces it. A misspelt name fails the first time it runs, a broken listener becomes a line from `onError` instead of a dead run, and `emit` never waits for anyone. You've seen exactly when an async listener's code runs, and why the promise it returns needs a handler straight away. And the real loop, traced live and on five scripted runs, follows the protocol you designed on Day 6.

Tomorrow, [Day 15](day-15.md) puts a person on the other end: a prompt you type into, with tool calls you approve and Ctrl+C that stops a run without stopping the program, all drawn through this bus and this printer.

Before you move on, check:

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

- "Convenient" aliases (`tool_call`, `done`) that extensions later subscribe to and never hear. They creep in because names get borrowed from other harnesses or written from memory, and with a lenient bus nothing fails when a name is wrong.
- An auto-approver that checks how a command *starts*. Chaining (`;`, `&&`, `|`) puts anything after it. A prefix check looks safe because the commands you test it with are honest ones.
- An empty `catch {}` around listeners: errors vanish and nobody ever sees them. It's usually written with the right goal, keeping one listener from breaking the others, but the fix is to report through `onError`, not to stay silent.
- Trusting the `try/catch` to catch async listeners. It only sees errors thrown before the listener returns, and an async listener never throws to its caller, so without a rejection handler its errors become unhandled rejections and Node exits.
- Iterating the live `Set` in `emit`, so a listener added mid-emit runs at once. It goes unnoticed because tests rarely subscribe a listener from inside another one.
- ANSI escapes in piped output or tests. It happens when colour depends on a flag alone and not on `isTTY`, because the output looks fine in the terminal where you wrote it.

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
