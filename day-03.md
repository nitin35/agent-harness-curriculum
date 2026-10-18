# Day 3 — Async JavaScript: Make Ctrl+C Work ⚠ heavier day

**Phase:** Week 1 — Hello, agent · **Size:** two sittings

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

Look at what Ctrl+C does now. It stops the *work*: a long answer, a running command, or a question waiting for your `y`. It doesn't stop the program. Each time, the toy is back at `you>` within a second, with the conversation intact and ready for your next question. You'll also run your first **course tests**, which prove that every tool call is still answered after an abort, so the conversation stays valid.

## Why it matters

The moment you most want to stop an agent is the moment it's doing something you didn't expect: an answer that runs away, or a command that hangs. Right now Ctrl+C can't do that. On Day 1, `spawnSync` froze everything while a command ran, and Ctrl+C ended the whole session instead of just the command. A real harness has to stop the work and keep the conversation.

Yesterday you learned the first rules of `await`: a promise stands for a result you don't have yet, and `await` gets the result out of it. You could use those rules without knowing how any of it works underneath. Today you need to know.

Stopping the work without stopping the program takes three ideas, and each one builds on the one before:
- the **event loop**, which explains why nothing else can run while your code is busy, and so why Day 1's Ctrl+C couldn't get through;
- **promises**, which let a program wait without being busy;
- **`AbortController`**, the one cancellation mechanism that `fetch`, child processes, readline and your own code all share.

This is the hardest JavaScript in the course, and also the most important. Most of the hard-to-find bugs in an agent harness are bugs about *when* something runs. So this section goes slowly, one rule at a time, with an example for each, and I'd encourage you to run every one of them. Day 13 builds the real harness's abort on exactly this.

## Concepts

**How to read this section.** Run the examples in concepts 1 and 2 *in a file* (for example `node scratch/try.mjs`), not in the REPL. The REPL runs each line as you enter it, so callbacks queued by one line run before you type the next, and the order you see isn't the order a program gets. Many examples number their output lines (`1 …`, `2 …`) in the order they print, so you can check your prediction at a glance.

**If you know an event loop already.** Python's `asyncio`, or a GUI toolkit's main loop such as Qt's, works on the same idea, so the first half of concept 1 will feel familiar: skim it, and slow down at *Two kinds of queue*. Microtasks, concept 2's ordering rules and concept 3's cooperative cancellation are where JavaScript differs from what you know, so read those slowly. Two boxes marked *Going deeper* hold details you can skip on a first read.

### 1. One thread, and the queues around it

Why couldn't Ctrl+C get through on Day 1? To answer that, you need a picture of how JavaScript runs your code. The good news is that it's simpler than threads in C++ or Python: one rule, one loop and two queues.

**JavaScript runs your code on one thread.** At any moment, exactly one piece of your code is running. It runs to completion, until it returns, before anything else of yours gets a turn. No timer, no event handler and no other function can interrupt it partway through. (Node does use other threads internally, for some file and DNS work, but none of them ever runs your JavaScript.)

The functions currently in progress form the **call stack**. When `a` calls `b`, `b` goes on top of `a`, and when `b` returns, it comes off again. "Runs to completion" means the stack keeps running until it's empty.

**The waiting happens elsewhere.** If only one piece of code can run at a time, how can a program wait for a network reply without freezing? The answer is that it doesn't do the waiting itself. When you start a timer, a network request or a child process, Node hands the waiting to the operating system and carries straight on with the next line. Along with the request, you hand over a function to call when it's done: a **callback**. When the wait is over, the callback is put in a **queue**.

```js run
console.log('1 start a timer');
setTimeout(() => console.log('3 the timer fired'), 100);
console.log('2 setTimeout has already returned');
```

`setTimeout` doesn't wait 100 ms. It asks for a timer, registers the callback, and returns at once, so line 2 prints straight away. When the 100 ms are up, the callback is queued and runs.

**The event loop runs the queued callbacks, one at a time.** The part of Node that takes callbacks off the queues and runs them is the **event loop**. In rough pseudocode, every Node program does this:

```
run the main file, top to bottom
while there is still something to wait for, or something queued:
  wait until a callback is queued
  take the next callback off its queue
  run it to completion
```

That small loop explains a great deal. A callback never interrupts running code: it waits in its queue until the stack is empty. And a program ends when nothing is left, meaning no queued callbacks and no timers, connections, child processes or open readline interfaces still to wait for. That's why a script with a pending `setTimeout` doesn't exit until the timer has fired.

**So a busy thread delays every callback.** Here's the rule at work. A timer set for 0 ms should fire at once, but it can't run while the code before it is still busy:

```js run
const start = Date.now();
setTimeout(() => console.log(`timer fired after ${Date.now() - start} ms`), 0);

const end = Date.now() + 1000;
while (Date.now() < end) {}            // busy for one second
console.log('busy loop done');
// → busy loop done
// → timer fired after 1001 ms
```

The timer was due almost immediately. It simply couldn't run until the busy loop finished and the stack was empty, and that took a whole second.

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

That's why Day 1's toy couldn't handle Ctrl+C. When you press Ctrl+C, readline reports it by calling a handler, and a handler is a callback, so it waits in a queue like any other. While `spawnSync` holds the thread, nothing in any queue can run. The fix is never to block: start the work, return to the event loop, and let a callback tell you when the work is done. Today's `runBash` uses the asynchronous `spawn` for exactly this reason.

**Two kinds of queue.** Not all callbacks wait in the same queue, and the difference decides the order things happen in:
- A **macrotask** is a callback from the outside world: a timer, an I/O callback such as "data arrived" or "the child exited", or a `setImmediate`. (The specification and browsers call these simply *tasks*.)
- A **microtask** is a callback from a promise: a `.then` callback, or the rest of an `async` function after an `await`. `queueMicrotask(fn)` queues one directly. Node's own `process.nextTick` callbacks run in a separate queue alongside them.

In each round, the event loop:
1. runs the current synchronous code to completion (everything on the **call stack**);
2. runs **every microtask**, including any that are added while it does so;
3. runs the next **macrotask**, then goes back to step 2.

Microtasks always jump the queue. Here is one of each, numbered in the order they print:

```js run
console.log('1 stack');
setTimeout(() => console.log('5 macrotask: timer'), 0);
Promise.resolve().then(() => console.log('3 microtask: promise'));
queueMicrotask(() => console.log('4 microtask: queueMicrotask'));
console.log('2 stack');
```

Walk through it one line at a time, keeping track of what's waiting:

| Line | What happens | Prints | Microtasks waiting | Timers waiting |
|---|---|---|---|---|
| 1 | runs | `1 stack` | | |
| 2 | asks for a timer | | | timer |
| 3 | the promise is already fulfilled, so its callback is queued | | promise | timer |
| 4 | queues a microtask | | promise, queueMicrotask | timer |
| 5 | runs | `2 stack` | promise, queueMicrotask | timer |
| — | the stack is empty: run every microtask, in order | `3 …`, `4 …` | | timer |
| — | run the next macrotask | `5 …` | | |

The two plain `console.log` calls run first, because they belong to the code that's already running. Then the event loop runs the microtasks, in the order they were queued. Only then does it look at the timer, even though its delay was 0. A timer's delay is a minimum, not a promise of "now".

That's the practical consequence to remember. When a promise settles, the code waiting on it runs promptly, before any new timer or I/O event is handled.

Step 2 runs microtasks *until none are left*, including new ones queued along the way. So a microtask that keeps queueing another one holds back every timer and every I/O callback, just like the busy loop above. In a test, 100,000 chained `queueMicrotask` calls all ran before a `setTimeout(…, 0)` that was queued first.

<details><summary>Going deeper: two Node details that trip up predictions</summary>

First, the order of `process.nextTick` and promise callbacks depends on the module type. In CommonJS, `nextTick` callbacks run before promise callbacks. In an ES module (your `.mjs` files), the top-level code itself runs inside a promise job, so at the top level promise callbacks run first:

```js
Promise.resolve().then(() => console.log('promise'));
process.nextTick(() => console.log('nextTick'));
// in an .mjs file → promise, then nextTick
// in a .cjs file  → nextTick, then promise
```

Most blog posts use CommonJS, so their answers may differ from yours. Second, `setTimeout(fn, 0)` and `setImmediate(fn)` from the main module can run in either order. Never write code that depends on it.

</details>

C++ contrast: there are no threads to start and no locks to take. Two callbacks never run at the same time, so they can't race on a variable halfway through a statement. The concurrency bug in JavaScript is *blocking the loop*. (Races of a different kind still exist, and concept 2 shows where.) Python contrast: this is `asyncio`'s model under different names: an event loop, callbacks, and coroutines that give way at each `await`. Calling `time.sleep(20)` inside a coroutine freezes Python's whole event loop, just as `spawnSync` freezes Node's, while `await asyncio.sleep(20)` hands the loop back. The difference is that Node has no separate, non-async world: every Node program runs on its event loop.

With the queues in place, the next layer is promises, which is how nearly all waiting in JavaScript is written.

### 2. Promises and async/await

Day 2 gave you the rules for *reading* async code. Now let's look underneath, because every one of those rules follows from one fact you've just learned: a promise's callbacks always run as microtasks.

**A promise, made by hand.** Recall that a promise starts **pending**, then becomes either **fulfilled** (with a value) or **rejected** (with an error), and after that it never changes. A promise that is no longer pending is **settled**. You can make one yourself with `new Promise`. The function you pass to it, called the *executor*, receives two functions: call `resolve(value)` to fulfil the promise, or `reject(error)` to reject it. Watch when everything runs:

```js run
console.log('1 before');
const p = new Promise((resolve) => {
  console.log('2 the executor runs at once, inside new Promise');
  resolve('done');
});
p.then((value) => console.log('4 then:', value));
console.log('3 after');
```

Notice two things. The executor runs straight away, before `new Promise` even returns. And although `p` was fulfilled immediately, its `.then` callback did *not* run immediately. It was queued as a microtask, and it ran only once the stack was empty. A promise's callbacks always run later, never in the middle of your code, even when the result is already there. That single rule is what makes promise code predictable.

**A promise settles only once.** After the first `resolve` or `reject`, later calls are ignored, without an error:

```js run
const p = new Promise((resolve, reject) => {
  resolve('first');
  resolve('second');                   // ignored: p is already settled
  reject(new Error('too late'));       // ignored too
});
await p                                // → 'first'
```

You'll rely on this in 3.4, where `runBash` can call `resolve` twice.

The simplest useful promise is a delay. It fulfils after a timer fires (you'll write it yourself in 3.2):

```js run
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const p = delay(10);
console.log(p);                        // → Promise { <pending> }
```

**What `await` really does.** `await p` is shorthand. It registers *the rest of the function* as a callback on `p`, and then it returns from the function, handing its caller a pending promise. When `p` settles, that callback is queued as a microtask, and the function carries on from where it stopped, with all its local variables just as they were. So these two functions behave the same:

```js
async function withAwait() {
  console.log('A');
  const value = await delay(100);
  console.log('B', value);
}

function withThen() {
  console.log('A');
  return delay(100).then((value) => {
    console.log('B', value);
  });
}
```

The real `await` also handles errors and loops for you, which is why nobody writes the second version by hand. But it's the right mental model. Each `await` cuts the function in two: the part before runs now, and the part after runs later, as a microtask.

**`await` always gives way, even when there's nothing to wait for.** Because the rest of the function always becomes a microtask, `await` pauses even when the value is already there:

```js run
async function task() {
  console.log('1 task starts');
  await null;                          // nothing to wait for, but the function still pauses here
  console.log('3 task resumes');
}

task();
console.log('2 the caller carries on');
```

`task()` runs synchronously up to its first `await`, then returns. The caller prints line 2. Only when the stack is empty does the microtask that resumes `task` run.

**Two at once.** `await` pauses *that function* and nothing else. The thread stays free in the meantime, so other callbacks keep running. Since an `async` function returns at its first `await`, starting two of them runs them side by side:

```js run
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

Each call runs until its first `await`, then returns a pending promise and lets the next line run. A hundred milliseconds later the two timers fire, and both functions carry on from where they paused. In an ES module you can also use `await` at the top level of the file, outside any function, as Day 1's toy does.

**Between two `await`s, the world can change.** No two callbacks ever run at the same time, so the code *between* two `await`s runs without interruption. At each `await`, though, other callbacks get their turn, and they can change shared state. A check made before an `await` can be out of date after it:

```js run
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let balance = 100;

async function withdraw(amount) {
  if (balance >= amount) {             // check…
    await delay(10);                   // …do something slow, like asking a server…
    balance -= amount;                 // …then act on a check that may no longer be true
  }
}

const first = withdraw(80);
const second = withdraw(80);
await first;
await second;
balance                                // → -60   both checks passed before either withdrawal ran
```

C++ programmers will recognize the check-then-act race. In JavaScript it can happen only at an `await`, which makes it easier to find: when a function shares state with other code, look at what it assumes across each `await`.

**Promises start at once.** Calling `fetch(url)` sends the request immediately, whether or not anyone ever `await`s the promise. `await` only waits for a result that's already on its way.

Python contrast: calling an `async def` function creates a coroutine that does nothing until it's awaited, while a JavaScript promise is already running. Calling a JavaScript `async` function is closer to Python's `asyncio.create_task(coro())`: the work is under way whether or not you wait for it. C++ contrast: a promise is like the `std::future` from `std::async`, except that no second thread runs your code. The operating system does the waiting, and your code continues in a callback.

**`.then` is the older way to write the same thing.** `p.then(callback)` registers a callback for the value and returns a *new* promise, so steps can be chained. Whatever a callback returns becomes the value of the next promise in the chain. If it returns a promise, the chain waits for that promise first. `async`/`await` reads like ordinary step-by-step code, and it's what this course uses. Both halves of this example look up a user, then that user's orders, and print the same list:

```js run
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const findUser = (name) => delay(10).then(() => ({ name, id: 7 }));
const findOrders = (id) => delay(10).then(() => [`order for user ${id}`]);

findUser('ada')
  .then((user) => findOrders(user.id))   // returns a promise, so the chain waits for it
  .then((orders) => console.log('with then:', orders));

const user = await findUser('ada');
const orders = await findOrders(user.id);
console.log('with await:', orders);
```

You'll still meet `.then` in other people's code and in documentation, so it's worth being able to read it.

**A rejection becomes an exception at the `await`.** So an ordinary `try/catch` handles it, just like a synchronous error. Here's a request to a port where no server is listening:

```js
try {
  await fetch('http://localhost:59999/');
} catch (err) {
  console.log(err.message);            // → fetch failed
  console.log(err.cause.code);         // → ECONNREFUSED
}
```

You'll see exactly this when Ollama isn't running. `fetch` only rejects when it can't get a response at all. An HTTP error status such as 404 or 500 still fulfils the promise, so check `res.ok`, as Day 1's toy does.

There's one trap here. The `try` catches the rejection only if the `await` happens *inside* it. Returning a promise from inside a `try` hands the promise to the caller unwaited, and its rejection skips your `catch` entirely:

```js
async function work() {
  await delay(10);
  throw new Error('boom');
}

async function careless() {
  try {
    return work();                     // ✗ returns the promise; its rejection skips this catch
  } catch {
    return 'recovered';
  }
}

async function careful() {
  try {
    return await work();               // ✓ waits here, so the rejection is thrown inside the try
  } catch {
    return 'recovered';
  }
}

await careful();                       // → 'recovered'
await careless();                      // Error: boom
```

**Unhandled rejections crash Node.** If a promise is rejected and nothing has attached a handler to it (no `await`, no `.catch`), Node raises an `unhandledRejection`. By default it prints the error and exits with code 1. Node checks for this right after the current microtasks have run, so "later" is too late. Forgetting `await` is the usual cause:

```js
async function work() {
  await delay(10);
  throw new Error('boom');
}

work();         // ✗ nobody waits for the result: Node prints "Error: boom" and exits
await work();   // ✓ the error is thrown here, where a try/catch can handle it
```

The same thing happens if you *do* wait, but not soon enough. A promise you start early and await later can reject in the meantime:

```js
const p = work();     // starts now, and rejects after 10 ms
await delay(50);      // meanwhile, wait for something else…
await p;              // ✗ never reached: Node exited at 10 ms, when p rejected with no handler
```

To start several promises and wait for them together, hand them all to `Promise.all` (concept 4), which attaches a handler to every one of them at once.

Day 5 covers errors properly: `try/catch/finally`, error classes and `cause`.

You can now start work and wait for it. The last piece is stopping it, and that's what Ctrl+C needs.

### 3. Cancellation: `AbortController` and `AbortSignal`

**A promise can't be cancelled from outside.** A promise is only a placeholder for a result. It has no link back to the work that will produce it, so there's nothing on it you could call "stop" with. Once `fetch` has started, the promise it returned has no stop button. So JavaScript has a separate, standard way to ask work to stop. An **`AbortController`** is the stop button, and its **`signal`** is the wire you hand to the work. Whoever holds the controller can press the button, and everyone holding the signal hears it:

```js run
const controller = new AbortController();
const { signal } = controller;

signal.aborted                         // → false
signal.addEventListener('abort', () => console.log('stop!'), { once: true });
controller.abort();                    // logs: stop!
signal.aborted                         // → true
signal.reason.name                     // → 'AbortError'
```

A signal announces the abort as an **event**. `addEventListener('abort', fn)` registers `fn` as a callback for it, and `{ once: true }` removes the listener after its first call. (A signal is an `EventTarget`, the standard object for anything that announces events.) Note *when* the listener runs: synchronously, inside `controller.abort()`, before `abort()` returns:

```js run
const controller = new AbortController();
controller.signal.addEventListener('abort', () => console.log('2 the listener runs inside abort()'));
console.log('1 calling abort()');
controller.abort();
console.log('3 abort() has returned');
```

So by the time `abort()` returns, every listener has already done its cleanup. Code that is `await`ing the cancelled work resumes later, as a microtask, like any other code waiting on a promise.

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

**Cancelling is a request, not a command.** Nothing can forcibly stop a running JavaScript function. `abort()` only sets `signal.aborted` and calls the listeners. Work stops only where something is listening. `fetch` listens and closes the connection, `spawn` listens and kills the child, and `rl.question` listens and gives up. A function that receives a signal and ignores it carries on to the end, and the code waiting for it waits for the end too. Day 13 measures what that costs.

Python contrast: in `asyncio`, `task.cancel()` throws a `CancelledError` into the coroutine at its next `await`, so the side doing the cancelling is in charge. In JavaScript, the work has to opt in by listening. C++ contrast: the closest match is C++20's `std::stop_source` and `std::stop_token`. One source hands out many tokens, and the work checks `stop_requested()`.

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

Each line has a job:
- **`signal?.throwIfAborted()`** handles a signal that fired before the work even started. A `throw` inside an executor doesn't escape `new Promise`: it rejects the promise, as if you'd called `reject`.
- **`clearTimeout(timer)`** actually stops the work. Without it, the promise would be rejected but the timer would still fire later, for nothing.
- **`reject(signal.reason)`** tells the caller *why* it stopped, with the same `AbortError` that `fetch` and `rl.question` use, so one check (`err.name === 'AbortError'`) handles them all.

And here it is being cancelled:

```js
const controller = new AbortController();
setTimeout(() => controller.abort(), 50);

try {
  await delay(1000, { signal: controller.signal });
} catch (err) {
  console.log(err.name);               // → AbortError, after 50 ms rather than 1000
}
```

Today's course tests use the same pattern: their fake `confirm` rejects with `signal.reason` when the signal fires, exactly as `rl.question` does, to check that Ctrl+C cancels an open question.

**Timeouts are signals too.** `AbortSignal.timeout(ms)` makes a signal that aborts by itself after `ms` milliseconds. `AbortSignal.any([a, b])` makes a signal that aborts as soon as *either* `a` or `b` does. That's how you combine "the user pressed Ctrl+C" with "it took too long":

```js
const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]);
await fetch(url, { signal });          // stops on Ctrl+C, or after 5 s, whichever comes first
```

**How each API reports an abort.** You'll see these for yourself in 3.3:

| | After `controller.abort()` | After `AbortSignal.timeout(ms)` fires |
|---|---|---|
| `fetch` rejects with | an `AbortError` | a `TimeoutError` |
| `spawn` emits `'error'` with | an `AbortError` (`err.cause`: an `AbortError`) | an `AbortError` (`err.cause`: a `TimeoutError`) |
| `rl.question` rejects with | an `AbortError` | |

`spawn` reports both kinds as an `AbortError`, so to tell a timeout from a Ctrl+C, `runBash` asks the timeout signal: `timeout.aborted`. Recognize an abort by its error *name* (`err.name === 'AbortError'`), never by its message text.

**An abort is not an error.** Ctrl+C is the user's choice. Code that receives an `AbortError` should stop cleanly and say so, as the toy's `(aborted)` line does. It shouldn't report a failure.

One question is still open from concept 2: how to wait for several things at once, and what happens to the others when one of them fails.

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

<details><summary>Going deeper: the combinators side by side</summary>

Here they are with one slow and one fast result:

```js run
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const after = (ms, value) => delay(ms).then(() => value);

await Promise.all([after(30, 'slow'), after(10, 'fast')])    // → ['slow', 'fast']
await Promise.race([after(30, 'slow'), after(10, 'fast')])   // → 'fast'
await Promise.any([
  Promise.reject(new Error('down')),
  after(10, 'backup'),
])                                                           // → 'backup'   the failure is skipped
```

`Promise.all` fulfils with an array of values in the same order as its input, whatever order they finished in: `'slow'` comes first even though `'fast'` finished first. `Promise.allSettled` never rejects. Instead, it describes each outcome:

```js
await Promise.allSettled([delay(10).then(() => 'fast'), Promise.reject(new Error('boom'))]);
// → [ { status: 'fulfilled', value: 'fast' },
//     { status: 'rejected', reason: Error: boom } ]
```

</details>

Python contrast: `Promise.all` is `asyncio.gather`, and `Promise.allSettled` is `asyncio.gather(…, return_exceptions=True)`.

**A combinator doesn't cancel anything.** When `Promise.all` rejects because one request failed, the other requests keep running, and their results are thrown away. To stop them, give them a shared signal and abort it. Python contrast: an `asyncio.TaskGroup` cancels its remaining tasks when one fails, but JavaScript has nothing like that built in, and signals fill the gap. Stretch 3.6 puts combinators and signals together.

## Build

The first three steps are experiments in scratch files, so you can watch each idea from the concepts on its own before it's mixed in with anything else. Steps 3.4 and 3.5 then put those ideas into the toy.

**Files today:** `notes/day-03.md`, `scratch/loop-order.mjs`, `scratch/slow-server.mjs`, the four toy modules, and `tests/course/`.

### 3.1 Predict the event loop — Core

This is concept 1's trace table, done by you. In `scratch/loop-order.mjs`, write three short snippets that mix `console.log`, `Promise.resolve().then(…)`, `queueMicrotask(…)`, `process.nextTick(…)` and `setTimeout(…, 0)`. **Write your predicted order** in `notes/day-03.md`, then run each one. Label every line *stack*, *microtask* or *macrotask*, as concept 1's example does. One wrong prediction usually means one misunderstood queue (or the ES-module detail in concept 1's *Going deeper* box).

Run one snippet at a time, with the others commented out. Snippets in the same file share the same queues, so their output interleaves.

### 3.2 Promises and async/await — Core

Each of these repeats one idea from concept 2, this time in your own code.

1. Write `delay(ms)` as `new Promise((resolve) => setTimeout(resolve, ms))`.
2. Turn a nested-`setTimeout` "callback pyramid" into `.then` chains, then into `async/await`. Start from this one, which prints three lines 100 ms apart:

   ```js run
   setTimeout(() => {
     console.log('one');
     setTimeout(() => {
       console.log('two');
       setTimeout(() => console.log('three'), 100);
     }, 100);
   }, 100);
   ```

   In the `.then` version, each callback should *return* the next `delay(…)`, so that the chain waits for it before going on (concept 2).

3. Throw after an `await` and catch it. Then remove the `catch` and watch Node die on the unhandled rejection.

### 3.3 Abort experiments — Core

Concept 3's table came from experiments like these. Now you run them yourself.

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

Thread one `signal` through every module. Work from the bottom up: first the two pieces that do the waiting (`chat` and `runBash`), then the loop that passes the signal down to them, and last `main.mjs`, which owns the controller and presses the button.

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

Stopping an agent no longer means losing it. Underneath that is a model of JavaScript you'll use every day from here on. One thread runs your code, and callbacks wait in queues until it's free. A promise's callbacks always run later, as microtasks. `await` cuts a function in two. And cancelling is a request that the work has to listen for. The toy puts all of that into one signal per question, handed to every piece of work, and a loop that answers every tool call even when the run is cut short.

Tomorrow tackles the other thing you noticed on Day 1: the long wait before anything appears. [Day 4](day-04.md) makes the toy stream its answer as the model writes it, which means handling bytes that arrive in pieces.

Before you move on, check:

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

<details><summary>My event-loop predictions are right in a file but wrong in the REPL</summary>

The REPL runs each line as you enter it, and then sits idle until you type the next one. While it's idle, the stack is empty, so the event loop runs whatever was queued. A `.then` from one line has already printed before you type the next one. Order experiments only make sense in a file, run with `node scratch/loop-order.mjs`.
</details>

<details><summary>Node exits with <code>Error: …</code> and a stack trace, though I wrapped the call in <code>try/catch</code></summary>

The rejection didn't happen inside your `try`. Two common causes: a `return somePromise()` inside the `try`, which hands the promise out unwaited (write `return await somePromise()`), or a promise started early and awaited later, which rejected while nothing was waiting for it (use `Promise.all`). Concept 2 shows both.
</details>

## Common mistakes

- Assuming `fetch` rejects on HTTP 500. It only rejects when there's no response at all (a network failure or an abort). A 500 is still a response, so check `res.ok`. An error status feels like an error, and while the server is working, a 500 never comes up in testing.
- Calling an `async` function without `await`. The next line doesn't wait for it, and if it fails, nothing catches the error, so Node exits with an unhandled rejection. When the call succeeds, the missing `await` changes nothing you can see, so it survives every test that doesn't make it fail.
- `return promise` inside a `try`, instead of `return await promise`. The function hands the promise out before it settles, so its rejection never passes through your `catch`. Both lines return the same value, so they look interchangeable until the promise rejects.
- Awaiting independent requests in a loop, then blaming the network for the slowness. Each `await` waits for one request before the next one starts, so the waits add up. Start them all, then `Promise.all`. A loop with `await` inside reads like the synchronous code you'd write in another language, and with two or three requests the extra wait is hard to notice.
- Expecting `Promise.all` to stop the other promises when one fails. A combinator only waits. It has no way to stop work, so abort the rest with a shared signal. `Promise.all` rejects at once, which looks as if everything stopped, while the other requests carry on out of sight.
- Writing a function that takes a `signal` and never looks at it. Cancelling is cooperative. If the function doesn't pass the signal on or listen to it, Ctrl+C waits for it to finish. Taking the parameter feels like supporting cancellation, and a quick function finishes before anyone notices that it ignored the abort.
- Treating an abort as an error to report. It is the user's choice, so stop cleanly and say so. An abort arrives as a rejection, the same way a failure does, so it's natural to handle both alike.

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
