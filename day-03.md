# Day 3 — Async JavaScript: Make Ctrl+C Work

**Phase:** Week 1 — Hello, agent

## By tonight

```
you> write me a 2000-word essay about the ocean
^C
(aborting…)          ← no need to wait for 2000 words
(aborted)
you> run `sleep 20` with bash
  run `sleep 20`? [y/N] y
^C
(aborting…)          ← the sleep dies at once, not after 20 seconds
(aborted)
you> list the files here
  run `ls`? [y/N] ^C
(aborting…)          ← even an open question is cancelled
(aborted)
you>
```

Ctrl+C stops the *work*, not the program. The toy stays alive and ready for your next question. You also run your first **course tests**, which prove that every tool call is still answered after an abort.

## Why it matters

On Day 1, `spawnSync` froze everything while a command ran, and Ctrl+C ended the whole session. A real harness must let you stop a runaway answer or command without losing the conversation. That takes three ideas you'll learn today:
- the **event loop**, which explains why nothing else can run while your code is busy;
- **promises**, which let you wait without being busy;
- **`AbortController`**, the one cancellation mechanism that `fetch`, child processes, readline and your own code all share.

Day 13 builds the real harness's abort on exactly this.

## Concepts

**How to read this section.** Run the examples in concepts 1 and 2 *in a file* (for example `node scratch/try.mjs`), not in the REPL. The REPL runs each line as you enter it, so callbacks queued by one line run before you type the next, and the order you see isn't the order a program gets.

### 1. One thread, and the queues around it

**JavaScript runs your code on one thread.** While a piece of your code is running, nothing else in your program runs: no other function, no timer, no event handler. The waiting happens elsewhere. When you start a network request, a timer or a child process, Node hands the waiting to the operating system and carries on. When the wait is over, the function you asked to be called (a *callback*) goes into a queue. The **event loop** takes callbacks off the queues and runs them one at a time, each to completion.

So a callback can only run once the code before it has finished. Watch what a busy loop does to a timer that should fire at once:

```js
const start = Date.now();
setTimeout(() => console.log(`timer fired after ${Date.now() - start} ms`), 0);

const end = Date.now() + 1000;
while (Date.now() < end) {}            // busy for one second
console.log('busy loop done');
// → busy loop done
// → timer fired after 1001 ms
```

`spawnSync` does the same thing. It waits for the command *inside* your code, so the thread stays busy until the command exits:

```js
import { spawnSync } from 'node:child_process';

const start = Date.now();
setTimeout(() => console.log(`timer fired after ${Date.now() - start} ms`), 0);
spawnSync('sleep', ['1']);
console.log('command done');
// → command done
// → timer fired after 1013 ms
```

That's why Day 1's toy couldn't handle Ctrl+C. Readline reports Ctrl+C by calling a handler, and a handler is a callback, so it can't run while `spawnSync` holds the thread. The fix is to never block: start the work, and let a callback tell you when it's done. Today's `runBash` uses the asynchronous `spawn` for exactly this reason.

**Two kinds of queue.** Not all callbacks wait in the same queue. In each round, the event loop:
1. runs the current synchronous code to completion (everything on the **call stack**);
2. runs **every microtask**, including any that are added while it does so: promise callbacks (`.then`, and the rest of an `async` function after an `await`), `queueMicrotask` callbacks and `process.nextTick` callbacks;
3. runs the next **macrotask** (a timer, an I/O callback such as "data arrived" or "the child exited", a `setImmediate`), then goes back to step 2.

Microtasks always jump the queue. Here is one of each, numbered in the order they print:

```js
console.log('1 stack');
setTimeout(() => console.log('5 macrotask: timer'), 0);
Promise.resolve().then(() => console.log('3 microtask: promise'));
queueMicrotask(() => console.log('4 microtask: queueMicrotask'));
console.log('2 stack');
```

The two plain `console.log` calls run first, because they belong to the code that's already running. Then the event loop runs the microtasks, in the order they were queued. Only then does it look at the timer, even though its delay was 0. A timer's delay is a minimum, not a promise of "now".

Step 2 runs microtasks *until none are left*, including new ones queued along the way. So a microtask that keeps queueing another one holds back every timer and every I/O callback, just like the busy loop above. In a test, 100,000 chained `queueMicrotask` calls all ran before a `setTimeout(…, 0)` that was queued first.

**Two Node details that trip up predictions.** First, the order of `process.nextTick` and promise callbacks depends on the module type. In CommonJS, `nextTick` callbacks run before promise callbacks. In an ES module (your `.mjs` files), the top-level code itself runs inside a promise job, so at the top level promise callbacks run first:

```js
Promise.resolve().then(() => console.log('promise'));
process.nextTick(() => console.log('nextTick'));
// in an .mjs file → promise, then nextTick
// in a .cjs file  → nextTick, then promise
```

Most blog posts use CommonJS, so their answers may differ from yours. Second, `setTimeout(fn, 0)` and `setImmediate(fn)` from the main module can run in either order. Never write code that depends on it.

C++ contrast: there are no threads to start and no locks to take. Two callbacks never run at the same time, so they can't race on a variable halfway through a statement. The concurrency bug in JavaScript is *blocking the loop*. Python contrast: this is `asyncio`'s model with different names: an event loop, callbacks, and coroutines that give way at each `await`.

### 2. Promises and async/await

**A promise is a placeholder for a result that isn't ready yet.** Functions that start slow work, like `fetch` or `rl.question`, can't hand you the result straight away, because that would mean waiting on the thread. So they return a promise at once and fill it in later. A promise starts **pending**, then becomes either **fulfilled** (with a value) or **rejected** (with an error), and after that it never changes. A promise that is no longer pending is **settled**.

You can make a promise yourself with `new Promise`. The function you pass to it receives two functions: call `resolve(value)` to fulfil the promise, or `reject(error)` to reject it. This one fulfils after a delay (you'll write it yourself in 3.2):

```js
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const p = delay(10);
console.log(p);                        // → Promise { <pending> }
```

**`await` waits for a promise without blocking the thread.** Inside an `async` function, `await p` pauses *that function* until `p` settles, then gives you its value. The thread stays free in the meantime, so other callbacks keep running. An `async` function always returns a promise, so starting two of them runs them side by side:

```js
async function slow(name) {
  console.log(`${name} starts`);
  await delay(100);
  console.log(`${name} ends`);
}

slow('a');
slow('b');
console.log('both started');
// → a starts
// → b starts
// → both started
// → a ends
// → b ends
```

Each call runs until its first `await`, then returns a pending promise and lets the next line run. A hundred milliseconds later the timers fire, and both functions carry on from where they paused. In an ES module you can also use `await` at the top level of the file, outside any function, as Day 1's toy does.

**Promises start at once.** Calling `fetch(url)` sends the request immediately, whether or not anyone ever `await`s the promise. `await` only waits for a result that's already on its way.

Python contrast: calling an `async def` function creates a coroutine that does nothing until it's awaited; a JavaScript promise is already running. C++ contrast: a promise is like the `std::future` from `std::async`, except that no second thread runs your code. The operating system does the waiting, and your code continues in a callback.

**`.then` is the older way to write the same thing.** `p.then(callback)` registers a callback for the value and returns a new promise, so steps can be chained. `async`/`await` reads like ordinary step-by-step code, and it's what this course uses. These two do the same thing:

```js
const url = 'http://localhost:11434/api/version';

fetch(url)
  .then((res) => res.json())
  .then((data) => console.log(data.version));

const res = await fetch(url);
const data = await res.json();
console.log(data.version);
```

**A rejection becomes an exception at the `await`.** So an ordinary `try/catch` handles it, just like a synchronous error. If Ollama isn't running:

```js
try {
  await fetch('http://localhost:11434/api/version');
} catch (err) {
  console.log(err.message);            // → fetch failed
  console.log(err.cause.code);         // → ECONNREFUSED
}
```

`fetch` only rejects when it can't get a response at all. An HTTP error status such as 404 or 500 still fulfils the promise, so check `res.ok`, as Day 1's toy does.

**Unhandled rejections crash Node.** If a promise rejects and nothing is waiting for it (no `await`, no `.catch`), Node raises an `unhandledRejection`, and by default it prints the error and exits with code 1. Forgetting `await` is the usual cause:

```js
async function work() {
  await delay(10);
  throw new Error('boom');
}

work();         // ✗ nobody waits for the result: Node prints "Error: boom" and exits
await work();   // ✓ the error is thrown here, where a try/catch can handle it
```

Day 5 covers errors properly: `try/catch/finally`, error classes and `cause`.

### 3. Cancellation: `AbortController` and `AbortSignal`

**A promise can't be cancelled from outside.** Once `fetch` has started, the promise it returned has no "stop" button. So JavaScript has a separate, standard way to ask work to stop. An **`AbortController`** is the stop button, and its **`signal`** is the wire you hand to the work. Whoever holds the controller can press the button, and everyone holding the signal hears it:

```js
const controller = new AbortController();
const { signal } = controller;

signal.aborted                         // → false
signal.addEventListener('abort', () => console.log('stop!'), { once: true });
controller.abort();                    // logs: stop!
signal.aborted                         // → true
signal.reason.name                     // → 'AbortError'
```

`signal.reason` is the error that aborted work should report: by default, a `DOMException` named `AbortError`. `signal.throwIfAborted()` throws that reason if the signal has already fired, which makes it a handy first line for any function that takes a signal.

**APIs that accept a signal stop when it fires.** `fetch`, `spawn` and `rl.question` all take a `signal` option, and one `abort()` reaches all of them:

```js
const controller = new AbortController();
const { signal } = controller;
fetch(url, { signal });                // rejects with an AbortError
spawn('sh', ['-c', cmd], { signal });  // the child is killed
rl.question('run it? ', { signal });   // the question is cancelled, rejecting with an AbortError
controller.abort();                    // one call cancels all three
```

That's the design the toy uses from today. Each question you type gets its own controller, and its signal is passed to every piece of work the run starts. Ctrl+C calls `abort()`, and whatever is running at that moment stops: the request to the model, a command, or an open `[y/N]` question. **One signal can cancel many operations. That is the whole design.**

**Write your own functions to take a signal, too.** Your own slow functions should follow the same contract: accept `{ signal }`, stop when it fires, and reject with `signal.reason`. Here is `delay` made abortable:

```js
function delay(ms, { signal } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();          // already aborted? A throw in here rejects the promise
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);             // stop the work…
      reject(signal.reason);           // …and report why
    }, { once: true });
  });
}
```

Today's course tests use the same pattern: their fake `confirm` rejects with `signal.reason` when the signal fires, exactly as `rl.question` does, to check that Ctrl+C cancels an open question.

**Timeouts are signals too.** `AbortSignal.timeout(ms)` makes a signal that aborts by itself after `ms` milliseconds. `AbortSignal.any([a, b])` makes a signal that aborts as soon as *either* `a` or `b` does. That's how you combine "the user pressed Ctrl+C" with "it took too long".

**How each API reports an abort.** You'll see these for yourself in 3.3:

| | After `controller.abort()` | After `AbortSignal.timeout(ms)` fires |
|---|---|---|
| `fetch` rejects with | an `AbortError` | a `TimeoutError` |
| `spawn` emits `'error'` with | an `AbortError` (`err.cause`: an `AbortError`) | an `AbortError` (`err.cause`: a `TimeoutError`) |
| `rl.question` rejects with | an `AbortError` | |

`spawn` reports both kinds as an `AbortError`, so to tell a timeout from a Ctrl+C, `runBash` asks the timeout signal: `timeout.aborted`. Recognize an abort by its error *name* (`err.name === 'AbortError'`), never by its message text.

**An abort is not an error.** Ctrl+C is the user's choice. Code that receives an `AbortError` should stop cleanly and say so, as the toy's `(aborted)` line does. It shouldn't report a failure.

### 4. Running work together: combinators

**One at a time, or all together.** An `await` inside a loop waits for each step before it starts the next:

```js
for (const url of urls) {
  const res = await fetch(url);        // one at a time: the total is the sum of all the waits
}
```

Promises start as soon as they are created, so you can start them all first and *then* wait:

```js
const responses = await Promise.all(urls.map((url) => fetch(url)));   // together: the longest wait
```

`urls.map(…)` creates every promise, which starts every request. `Promise.all` then waits for the whole set.

**The four combinators.** Each takes an array of promises and returns a single promise. They differ in when that promise settles:

| | Settles when | Use for |
|---|---|---|
| `Promise.all` | all fulfil, or the **first** rejects | independent work that must all succeed |
| `Promise.allSettled` | all settle; never rejects | "report every outcome" |
| `Promise.race` | the first settles (either way) | first response wins |
| `Promise.any` | the first fulfils (else `AggregateError`) | redundant sources |

`Promise.all` fulfils with an array of values in the same order as its input, whatever order they finished in. `Promise.allSettled` never rejects. Instead, it describes each outcome:

```js
await Promise.allSettled([delay(10).then(() => 'fast'), Promise.reject(new Error('boom'))]);
// → [ { status: 'fulfilled', value: 'fast' },
//     { status: 'rejected', reason: Error: boom } ]
```

Python contrast: `Promise.all` is `asyncio.gather`, and `Promise.allSettled` is `asyncio.gather(…, return_exceptions=True)`.

**A combinator doesn't cancel anything.** When `Promise.all` rejects because one request failed, the other requests keep running, and their results are thrown away. To stop them, give them a shared signal and abort it. Stretch 3.6 puts combinators and signals together.

## Build

**Files today:** `notes/day-03.md`, `scratch/loop-order.mjs`, `scratch/slow-server.mjs`, the four toy modules, and `tests/course/`.

### 3.1 Predict the event loop — Core

In `scratch/loop-order.mjs`, write three short snippets that mix `console.log`, `Promise.resolve().then(…)`, `queueMicrotask(…)`, `process.nextTick(…)` and `setTimeout(…, 0)`. **Write your predicted order** in `notes/day-03.md`, then run each one. Label every line *stack*, *microtask* or *macrotask*, as concept 1's example does. One wrong prediction usually means one misunderstood queue (or the ES-module detail in concept 1).

Run one snippet at a time, with the others commented out. Snippets in the same file share the same queues, so their output interleaves.

### 3.2 Promises and async/await — Core

1. Write `delay(ms)` as `new Promise((resolve) => setTimeout(resolve, ms))`.
2. Turn a nested-`setTimeout` "callback pyramid" into `.then` chains, then into `async/await`. Start from this one, which prints three lines 100 ms apart:

   ```js
   setTimeout(() => {
     console.log('one');
     setTimeout(() => {
       console.log('two');
       setTimeout(() => console.log('three'), 100);
     }, 100);
   }, 100);
   ```

3. Throw after an `await` and catch it. Then remove the `catch` and watch Node die on the unhandled rejection.

### 3.3 Abort experiments — Core

1. Write `scratch/slow-server.mjs`: a `node:http` server that answers after `?ms=` milliseconds. You'll use it for repeatable tests instead of hoping the network is slow.

   Some hints:
   - `http.createServer((req, res) => …)` calls your function once per request.
   - `new URL(req.url, 'http://localhost').searchParams.get('ms')` reads the parameter.
   - `setTimeout(() => res.end('done'), ms)` answers late.
   - `server.listen(8787)` starts it.

   Run it in a second terminal.
2. `fetch` it with a manual `AbortController` and abort after 50 ms. Print `err.name` (`AbortError`).
3. Repeat with `AbortSignal.timeout(50)` (`TimeoutError`).
4. Share **one** controller across three concurrent fetches, abort it, and confirm all three reject.

### 3.4 Make the toy abortable — Core

Thread one `signal` through every module.

**1. `toy/ollama.mjs`:** `chat(messages, tools, { signal } = {})` passes `signal` to `fetch`.

**2. `toy/bash-tool.mjs`:** replace `spawnSync` with the async `spawn`, so the event loop stays free while a command runs:

```js
import { spawn } from 'node:child_process';

export function runBash(command, { signal, timeoutMs = 30_000 } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  // Never rejects: a failed command is still a result for the model.
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], {
      // Ctrl+C or too slow, whichever comes first
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });   // Day 4 comes back to these two lines
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('error', (err) => resolve(                      // abort and timeout both land here
      timeout.aborted ? `(command timed out after ${timeoutMs / 1000} s)`
      : err.name === 'AbortError' ? '(command stopped: run aborted)'
      : `(command failed to start: ${err.message})`));
    child.on('close', (code) => resolve(out.slice(0, 4000) || `(exit code ${code}, no output)`));
  });
}
```

How it works:
- **`spawn` returns at once,** with a `child` object. The command's output arrives later as `'data'` events, and its end as a `'close'` event. Each is a callback the event loop runs when it's ready, so the thread stays free, and Ctrl+C can be handled while the command runs.
- **When the signal fires,** Node kills the child and emits `'error'` with an `AbortError`. The chained `? :` picks one of three messages: the timeout fired (`timeout.aborted`), the user aborted, or the command couldn't start at all.
- **After an abort, `'close'` fires as well.** That's harmless: a promise settles only once, so the second `resolve` does nothing.

**3. `toy/loop.mjs`:** `runTurns({ client, messages, confirm, runTool = runBash, signal, maxTurns = 10 })` passes `{ signal }` to `client.chat`, to `confirm(command, { signal })` and to `runTool(command, { signal })`. It now returns `{ text, turns, aborted }`. If `chat` rejects with an `AbortError`, return `{ text: '', turns, aborted: true }` instead of throwing: Ctrl+C is the user's choice, not an error.

```js
let reply;
try {
  reply = await client.chat(messages, [bashToolSpec], { signal });
} catch (err) {
  if (err.name === 'AbortError') return { text: '', turns: turn, aborted: true };
  throw err;                                   // anything else is a real error
}
```

**4. `toy/main.mjs`:** create a fresh `AbortController` for each question. Readline turns Ctrl+C into a `'SIGINT'` event, and passing the signal to `rl.question` lets Ctrl+C cancel an open `[y/N]` question too:

```js
let controller = null;                         // non-null while a run is in flight
rl.on('SIGINT', () => {
  if (controller) {
    controller.abort();
    output.write('\n(aborting…)\n');
  } else {
    rl.close();
    process.exit(130);                         // idle: Ctrl+C exits, with the conventional code 130
  }
});

const confirm = async (command, { signal } = {}) =>
  (await rl.question(`\n  run \`${command}\`? [y/N] `, { signal })).trim().toLowerCase() === 'y';

// for each question:
controller = new AbortController();
const result = await runTurns({ client, messages, confirm, signal: controller.signal });
controller = null;
console.log(result.aborted ? '\n(aborted)' : `\nagent> ${result.text}`);
```

The `controller` variable is how the `'SIGINT'` handler knows what Ctrl+C should mean: stop the current run if there is one, or leave if you're at the `you>` prompt. Exit code 130 is the shell's convention for "ended by Ctrl+C" (128 plus 2, the number of the `SIGINT` signal).

### 3.5 Keep the history valid on abort, and prove it — Core

Suppose the model asks for two commands and you abort during the first. The second still needs a `tool` message, or the next request sends a tool call that was never answered. The same goes for a call whose `[y/N]` question you cancelled. Put the decision in one helper in `toy/loop.mjs`:

```js
/**
 * Ask, then run. An abort, even one that lands while the [y/N] question is open,
 * makes the call "skipped".
 */
async function answerToolCall(command, { confirm, runTool, signal }) {
  if (signal?.aborted) return 'Skipped: run aborted';
  try {
    const approved = await confirm(command, { signal });
    if (signal?.aborted) return 'Skipped: run aborted';
    return approved ? await runTool(command, { signal }) : 'The user denied this command.';
  } catch (err) {
    if (err.name === 'AbortError') return 'Skipped: run aborted';   // what rl.question does on Ctrl+C
    throw err;
  }
}
```

It looks at the signal three times, because an abort can arrive at three moments:
- **before asking:** an earlier call in the same batch was aborted, so don't ask about this one;
- **after asking:** the abort arrived while the question was open, but `confirm` returned anyway;
- **in the `catch`:** `rl.question` rejected because of the abort.

In the tool loop, push one `tool` message per call, whatever happened, and stop after the batch if the run was aborted:

```js
for (const call of reply.tool_calls) {
  const content = await answerToolCall(call.function.arguments.command, { confirm, runTool, signal });
  messages.push({ role: 'tool', tool_name: call.function.name, tool_call_id: call.id, content });
}
if (signal?.aborted) return { text: '', turns: turn, aborted: true };
```

This is the **tool-pair invariant**. You'll meet it again on Days 12, 13 and 25.

**Now prove it with the course tests.** Course tests are the course's executable spec: copy them into your project and make them pass.

```bash
mkdir -p tests/course
cp ../agent-harness-curriculum/course-tests/day-03/*.test.js tests/course/
node --test tests/course/day03-*
```

Each `✔` is a passing test. A `✖` prints what failed, with `+ actual` and `- expected` lines (Day 5 teaches you to write your own tests). When everything passes, the output ends like this:

```
✔ maxTurns stops a model that never stops calling tools (0.140167ms)
✔ runBash: an abort stops a running command at once (51.91925ms)
✔ runBash: a timeout is reported as a timeout (101.943042ms)
ℹ tests 9
ℹ suites 0
ℹ pass 9
ℹ fail 0
```

The loop tests drive `runTurns` with a fake client, a fake `confirm` and a fake `runTool`, so they need neither Ollama nor a keyboard. That is the payoff of Day 2's dependency injection.

**Demo:** ask for a long essay and press Ctrl+C. Approve `sleep 20` and press Ctrl+C. Ask for a command and press Ctrl+C at the `[y/N]` question. Each time you're back at `you>` within a second, and your next question still works. Commit `day-03: abortable toy`.

### 3.6 Abortable concurrent fetcher — Stretch

`scratch/abortable-fetch.js`: `fetchAll(urls, { timeoutMs, signal })` runs every request concurrently, each with its own timeout linked to an outer signal (`AbortSignal.any`). It returns `{ ok: [...], failed: [...] }`, and one dead URL never rejects the batch. Then fill in a table of how all four combinators behave with one fast, one slow and one failing promise.

### 3.7 Serialization cost — Stretch

Time three sequential `await delay(100)` calls against `Promise.all` of three (about 300 ms against about 100 ms). Then explain why the agent loop runs tools **one at a time, on purpose** (Day 12 gives the answer).

## Check

- [ ] `notes/day-03.md`: predicted and actual event-loop order, labelled by queue
- [ ] Abort experiments: you saw both `AbortError` and `TimeoutError`
- [ ] Ctrl+C stops a long answer, a running `sleep 20` and an open `[y/N]` question; Ctrl+C at `you>` exits with code 130
- [ ] `node --test tests/course/day03-*` passes 9 tests
- [ ] Commit `day-03: abortable toy`

Solution: [`solutions/toy/`](solutions/toy/) (`bash-tool.mjs`, `loop.mjs`, `main.mjs`). It shows the end of week 1, so it already streams (Day 4).

## Stuck?

<details><summary>Ctrl+C still kills the process</summary>

`rl.on('SIGINT')` only fires while readline owns the terminal, so create `rl` *before* the run starts and never close it in between. If your input is piped rather than a terminal, there is no keyboard SIGINT; run the toy directly in a terminal.
</details>

<details><summary>Ctrl+C prints <code>DOMException [AbortError]: This operation was aborted</code> and the toy exits</summary>

An abort escaped as an error, all the way up to `main.mjs`. Every `await` that receives the signal must expect an `AbortError`. `runTurns` catches it around `client.chat` and returns `{ aborted: true }`, and `answerToolCall` catches it around `confirm` (3.4 and 3.5).
</details>

<details><summary>Ctrl+C at the <code>[y/N]</code> question does nothing until I press Enter</summary>

The question doesn't know about the abort. Pass the signal: `rl.question(prompt, { signal })`. It then rejects with an `AbortError`, which `answerToolCall` turns into `Skipped: run aborted`.
</details>

<details><summary>The <code>sleep</code> keeps running after the abort</summary>

Did you pass `signal` all the way down to `spawn`? Log `signal.aborted` inside `runBash`. (On Day 11 you'll also kill the *grandchildren* that `sh -c` starts.)
</details>

<details><summary>A test says <code>confirm(command, { signal })</code> or <code>runTool(command, { signal })</code> didn't receive the signal</summary>

Pass an options object as the second argument: `confirm(command, { signal })`, not `confirm(command, signal)` or `confirm(command)`.
</details>

<details><summary>After an abort, the next question crashes with a 400 or gets a strange reply</summary>

You left a tool call without a matching `tool` message. See 3.5.
</details>

## Common mistakes

- Assuming `fetch` rejects on HTTP 500. It only rejects on a network failure or an abort, so check `res.ok`.
- Calling an `async` function without `await`. The next line doesn't wait for it, and if it fails, nothing catches the error.
- Awaiting independent requests in a loop, then blaming the network for the slowness.
- Expecting `Promise.all` to stop the other promises when one fails. It doesn't: abort them with a signal.
- Treating an abort as an error to report. It is the user's choice: stop cleanly.

## Self-check

1. Why does `setTimeout(fn, 0)` run after `Promise.resolve().then(fn)`?
2. Why did `spawnSync` make Ctrl+C impossible to handle?
3. What does the caller of `fetch` see when its signal aborts, and when an `AbortSignal.timeout` fires? How is `spawn` different?
4. Why must a skipped tool call still get a `tool` message?

Answers: [self-check-answers.md](self-check-answers.md#day-3).

## Further reading

- javascript.info, [Promise basics](https://javascript.info/promise-basics) · [Async/await](https://javascript.info/async-await) · [Promise API](https://javascript.info/promise-api) · [Event loop](https://javascript.info/event-loop): patient, beginner-friendly chapters with exercises
- Jake Archibald, [Tasks, microtasks, queues and schedules](https://jakearchibald.com/2015/tasks-microtasks-queues-and-schedules/): the classic step-by-step walk through the queues (written for browsers, but the microtask rules are the same)
- MDN, [The event loop](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Event_loop) · [Using promises](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Using_promises)
- Node.js, [The event loop, timers and `process.nextTick()`](https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick)
- MDN, [`AbortController`](https://developer.mozilla.org/en-US/docs/Web/API/AbortController) · [`AbortSignal.any`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/any_static)
- Node.js, [`child_process.spawn`](https://nodejs.org/api/child_process.html#child_processspawncommand-args-options) (see the `signal` option) · [`rl.question` with a signal](https://nodejs.org/api/readline.html#rlquestionquery-options)

---
← [Day 2](day-02.md) · [Curriculum home](README.md) · Next: [Day 4 — Streams and bytes: make it stream](day-04.md) →
