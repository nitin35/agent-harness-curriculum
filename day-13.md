# Day 13 — Abort, `ScriptedProvider` and Checkpoint 1

**Phase:** Week 2 — Provider & tools · **Checkpoint 1**

## By tonight

```
$ node scripts/smoke-loop.js "Run sleep 30 with bash, then tell me the date."
  → bash {"command":"sleep 30"}
  allow bash {"command":"sleep 30"}? [y/N] y
^C
answer (1 turns, aborted=true):            ← back in ~1 s, not 30, and no stack trace
```

Ctrl+C during a 30-second command brings the run back in about a second, with `aborted=true` and no stack trace. Behind it is a test suite that proves the whole engine works **with Ollama switched off**.

## Why it matters

On Day 3 you made Ctrl+C work in the toy, with one signal handed to everything that waits. Yesterday's loop has more places to wait, and more state that an interruption can leave half-finished. Today the real loop gets the same treatment.

Abort is where harnesses get subtle bugs, and they come in three flavours. The fetch dies but the child keeps running. Or the child dies but the history now holds a tool call with no result, and the next request fails. Or abort throws, and every caller needs a `try/catch` it doesn't have. None of these show up when you test the happy path. They show up the first time someone changes their mind halfway through a long command.

So today you make abort plumbing, not an error path. You also build `ScriptedProvider`, the fake model that every later test, eval and demo runs on, and with both in place you reach Checkpoint 1: an engine that works, stops cleanly, and can be proven with Ollama switched off.

## Concepts

### 1. One signal, every sink

A *sink* here is anywhere the run spends time waiting. For the loop, that's waiting for the model, running a tool, and moving on to the next call. `run(…, { signal })` passes the **same** `AbortSignal` to:
- `provider.chat(…, { signal })`, so the `fetch` dies;
- `tool.execute(args, { signal })`, so `bash` kills its process group (Day 11);
- checks between tool calls (`if (signal?.aborted)`), so the rest are skipped.

This is Day 3's design, scaled up. The toy passed one signal to `fetch`, `spawn` and `rl.question`. Now the loop passes it to every provider and every tool.

Day 3 said that cancelling is a request, not a command, and promised that today would measure what that costs. Abort is cooperative: nothing happens unless the code doing the waiting passes the signal on or checks it. A tool that ignores its signal keeps going, and the loop waits for it. Here are two pieces of work that each take 1.5 seconds, aborted after 100 ms. One ignores the signal, and the other hands it to the thing it waits on:

```js run
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

async function ignoresSignal(signal) { await delay(1500); }          // ✗ never looks at it
async function listens(signal) { await abortableDelay(1500, signal); } // ✓ passes it on

for (const work of [ignoresSignal, listens]) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const start = Date.now();
  try { await work(controller.signal); } catch { /* the AbortError */ }
  console.log(`${work.name}: back after ${Date.now() - start} ms`);
}
// → ignoresSignal: back after 1501 ms
// → listens: back after 102 ms
```

The abort fired at 100 ms in both cases. The difference is entirely in whether the work was listening. The reference loop shows the same thing: with a test tool that sleeps 1.5 seconds without looking at the signal, an abort after 100 ms still took 1502 ms to come back. So every tool you write must hand the signal to whatever it waits on.

C contrast: `pthread_cancel` is asynchronous and unsafe, because it can stop a thread anywhere. Python contrast: `asyncio` raises `CancelledError` into a task at its next `await`, from outside. In JavaScript, the work has to opt in.

Once the signal reaches everything, the next question is what `run()` gives back when it fires.

### 2. Abort is a result

This is the most important rule of the day: `run()` never throws because the user pressed Ctrl+C. It **returns** `{ aborted: true, turns, toolCalls, usage, newMessages, response }` and never throws `AbortError` to its caller.

The loop has to notice the abort in two different situations, and they need two different kinds of check:
- **While it's waiting on something that listens**, the abort arrives as a rejection. The provider's `fetch` rejects with an `AbortError`, so catch it at the provider call: `if (isAbortError(err) || signal?.aborted) return result({ aborted: true })`. The `|| signal?.aborted` is there because some code fails with an error of a different name when it's interrupted. If the signal has fired, the run was aborted, whatever the error says.
- **Between steps**, nothing is waiting, so nothing rejects. A Ctrl+C that lands just after the model answered won't throw anywhere. The loop has to look: check `signal?.aborted` at the top of each turn, and before each tool call.

`maxTurns` gives `aborted: false` with a `warning`. Only abort gives `aborted: true`.

With a scripted model that takes five seconds to answer, and an abort after 50 ms, the reference loop returns in 51 ms with:

```js
{ response: '', turns: 1, toolCalls: [], aborted: true,
  newMessages: [{ role: 'user', … }], usage: { … } }
```

A run can end in four ways, and the caller can tell them apart:

| How it ended | `run()` | `aborted` | `warning` |
|---|---|---|---|
| The model answered | returns | `false` | none |
| `maxTurns` ran out | returns | `false` | `stopped after maxTurns (3) without a final answer` |
| The user aborted | returns | `true` | none |
| The provider failed | **throws** the error | — | — |

A **real** provider failure (server down) is different: it propagates as a `ProviderError`. The UI reports it (Day 15), and the loop is reusable afterwards because `#running` is reset in `finally`. Abort is the user's choice, so it's a result. A broken server is a failure someone has to see, so it stays an exception.

Returning cleanly isn't enough, though, if what's left behind is broken.

### 3. Abort must not corrupt history

The tool-pair invariant (Day 12) has to survive Ctrl+C. Say the model asked for three tools and you aborted during the first. The first returns `"bash aborted"` (or `[killed: run aborted]`). The other two each get `{ isError: true, content: 'Skipped: run aborted' }`. The assistant message plus three results is still a valid tool pair.

Measured on the reference loop, with a real `sleep 30` as the first call and an abort after 300 ms (the run returned in 303 ms, and no `sleep` was left):

```js
[
  { role: 'assistant', content: '', toolCalls: [/* c1: sleep 30, c2: echo second, c3: read */] },
  { role: 'tool_result', toolCallId: 'c1', content: '[killed: run aborted]', isError: true, … },
  { role: 'tool_result', toolCallId: 'c2', content: 'Skipped: run aborted', isError: true, … },
  { role: 'tool_result', toolCallId: 'c3', content: 'Skipped: run aborted', isError: true, … },
]
```

The next run starts from a valid history, and the model can see that its calls were interrupted rather than lost.

To test all of this without a real model, you need a fake one, and a good one.

### 4. `ScriptedProvider`: the seam made honest

On Day 12, a test faked the provider with `{ chat: async () => replies.shift() }`. That works, but every test rebuilds it, and it can't fake a slow model or a failing one. `ScriptedProvider` is that idea grown into a real class, a fake model that plays a script:

```js
const provider = new ScriptedProvider([
  ScriptedProvider.toolCalls(['read', { path: 'notes.txt' }, 'call_1']),
  (messages) => ScriptedProvider.text(`I read: ${messages.at(-1).content}`),   // computed from what the loop sent
  { delayMs: 5000, response: ScriptedProvider.text('slow') },                  // abortable wait
  { error: new Error('server exploded') },                                     // throws
]);
provider.calls;   // every (messages, tools) it received, for assertions
```

Each call to `chat` takes the next step from the script:
- **A `ChatResponse`** is returned as it is. `ScriptedProvider.text('hi')` builds `{ content: 'hi', toolCalls: [], … }`, and `ScriptedProvider.toolCalls([name, args, id], …)` builds one with tool calls.
- **A function** is called with the messages the loop sent, and its return value is the reply. In the first example, the second step reads the tool result and quotes it, so the test proves the result reached the model: the reply is `I read: the answer is 42`.
- **`{ delayMs, response }`** waits first, and the wait honours the signal: this is how tests abort a slow model.
- **`{ error }`** throws, like a server that fell over.

When the script runs out, `chat` throws `ScriptedProvider: script exhausted after 2 replies`. A test that scripts too few replies fails loudly instead of quietly getting `undefined`.

It implements the provider interface, so the loop can't tell it from Ollama. Tests stay deterministic and offline, and green tests then prove **the loop**, not the model. Day 26's CLI, Day 29's evals and Day 30's offline demo all run on it too.

One last thing before the build: a few ways of using signals that come up again and again.

### 5. Signal patterns worth knowing

Four patterns cover nearly everything:
- `signal.throwIfAborted()` at synchronous checkpoints.
- `AbortSignal.timeout(ms)` gives per-request deadlines.
- `AbortSignal.any([user, timeout])` combines reasons; `signal.reason` tells you which fired.
- A promise you stop waiting for still needs a handler. If an abort makes you give up on work that later rejects, Node reports an unhandled rejection and exits (Day 3).

The third in code:

```js
const user = new AbortController();
const signal = AbortSignal.any([user.signal, AbortSignal.timeout(60_000)]);
// … later, after a failure:
signal.reason.name   // → 'TimeoutError' if the deadline fired; 'AbortError' if the user aborted
```

The fourth needs more care, because it's easy to get almost right. `Promise.race` is safe: it attaches a handler to every promise you give it, so a loser that rejects later is still handled. The danger is a promise you start and then stop waiting for, typically because an abort made you return early. Here a run starts some slow work, the user aborts at 10 ms, and the run returns. At 30 ms, the abandoned work fails:

```js
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const doSlowThing = async () => { await delay(30); throw new Error('slow thing failed'); };
const stopAfter = (ms) => new Promise((_, reject) =>
  setTimeout(() => reject(new DOMException('aborted', 'AbortError')), ms));

async function run({ handleEarly }) {
  const work = doSlowThing();                     // started now; rejects at 30 ms
  if (handleEarly) work.catch(() => {});          // ✓ handled from the start
  try {
    await stopAfter(10);                          // the user aborts at 10 ms…
  } catch {
    return 'aborted';                             // …so we stop waiting for work
  }
  return await work;
}

// run one of these at a time:
await run({ handleEarly: false });   // → 'aborted', then at 30 ms Node exits: slow thing failed
await run({ handleEarly: true });    // → 'aborted', and the program carries on
```

Without the early handler, `run` returns `'aborted'` and the caller carries on, and 20 ms later the whole process dies of an error nobody was waiting for. The fix is to attach the handler *as soon as the work starts*, before any `await` that might lead you to return. A `.catch` written further down never runs if you return before reaching it.

## Build

First the signal goes through the loop, then the fake model that lets you test it. Then the course tests and one scenario of your own, then a live abort with a real model. The day ends with Checkpoint 1, a list of everything the engine must now do.

**Files today:** `src/agent/agent-loop.js`, `src/provider/scripted.js`, `tests/agent-loop-e2e.test.js`, `scripts/smoke-loop.js` and `notes/day-13.md`.

### 13.1 Thread the signal — Core

In `agent-loop.js`:
1. pass `signal` to `provider.chat` and to `executeTool` → `tool.execute(args, { signal })`;
2. before running each tool call, check whether the signal is aborted; if so, append the skip result instead (the loop keeps going so every call gets one);
3. at the top of each turn, return `aborted` if the signal is already aborted;
4. catch abort at the provider call.

Steps 2 and 4 in code:

```js
let reply;
try {
  reply = await this.provider.chat(messages, tools, { signal });
} catch (err) {
  if (isAbortError(err) || signal?.aborted) return result({ aborted: true });
  throw err;                                   // a real failure: the caller must see it
}
// …
for (const call of reply.toolCalls) {
  const toolResult = signal?.aborted
    ? { content: 'Skipped: run aborted', isError: true }
    : await this.executeTool(call, { signal });
  // …append exactly one tool_result for this call
}
```

### 13.2 `src/provider/scripted.js` — Core

```js
export class ScriptedProvider {
  constructor(script = [], { model = 'scripted', contextLimit = 8192, models } = {}) { … }
  static text(content, extra) { … }            // → ChatResponse
  static toolCalls(...[name, args, id?]) { … } // → ChatResponse with toolCalls
  calls = [];                                  // structuredClone of every call
  // shift the next step; function / delayMs / error / response
  async chat(messages, tools, { signal }) { … }
  async listModels() { … }
  async getModelInfo(name) { … }
  setModel(name) { … }
}
export function sleep(ms, signal) { … }        // abortable setTimeout promise
```

When the script runs out, throw `"ScriptedProvider: script exhausted"`. Silently returning `undefined` would hide test bugs.

`sleep` is Day 3's abortable delay: reject with `signal.reason` when the signal fires, and clear the timer. Record calls with `structuredClone` (Day 2), so what a test inspects is exactly what was sent, even if something changes those objects afterwards.

### 13.3 Course tests — Core

Copy `course-tests/day-13/` and run it **with Ollama stopped** (`curl localhost:11434` should fail). It covers:
- an e2e read through the **real** `read` tool;
- abort during a slow provider call;
- abort between turns;
- **abort kills `sleep 30` and skips two queued calls**, timed at under 5 s, with the pair checked;
- maxTurns on the scripted provider;
- a provider failure that propagates while the loop stays reusable.

### 13.4 Your own e2e — Core

`tests/agent-loop-e2e.test.js`: one scenario of your own design, using `ScriptedProvider` and `createBuiltinTools` in a temp workspace. For example: the model writes a file (`autoApprove: true`), reads it back, then answers. Assert the file exists and that the final answer quotes it.

A temp workspace that cleans up after itself, as the course tests make one:

```js
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-e2e-'));
t.after(() => fs.rmSync(root, { recursive: true, force: true }));
```

Script one reply per provider call the loop will make. A write, a read and an answer are three turns, so three steps. Use a function step for the answer if you want it to quote what the read returned: that proves the tool's result really reached the model.

### 13.5 Live abort — Core

In `scripts/smoke-loop.js`, wire Ctrl+C to the run's controller (`rl.on('SIGINT', () => controller.abort())`, plus `rl.question(…, { signal })` so a pending approval question is cancelled too). Run the *By tonight* scenario: approve `sleep 30`, press Ctrl+C, and see `aborted=true` within about a second. Paste the transcript into `notes/day-13.md`.

A cancelled `rl.question` rejects with an `AbortError` (Day 3). In the approver, `.catch(() => 'n')` turns that into a "no", so the run ends cleanly instead of failing.

### 13.6 Checkpoint 1 — Core

Two weeks of work meet here. Each item below is something a later day assumes, so a red item now becomes a confusing bug next week. **All must be true** ([README checkpoints](README.md#checkpoints)). Fix anything red, using [Buffer 1](buffer-1.md) if you need it:

- [ ] `node --test` green with Ollama **stopped**: every course test from Days 3–13, plus yours
- [ ] Tool turn → text turn works; the next call sees the whole tool pair
- [ ] Unknown tool, bad arguments and a throwing tool all become results; the run completes
- [ ] `maxTurns` gives a partial result with a warning; there is no infinite loop
- [ ] With no approver attached, `bash` is denied (fail closed)
- [ ] One `AbortSignal` stops the fetch, kills `sleep 30` within seconds, and skips the remaining calls with results
- [ ] Nothing a command starts outlives it: `sleep 30 & echo started` returns promptly and leaves no `sleep` behind (Day 11)
- [ ] Abort returns `aborted: true`; it never throws
- [ ] Live: one approved tool turn and one Ctrl+C abort, transcripts in `notes/`

Commit `day-13: abort + scripted provider — checkpoint 1`.

### 13.7 Compose signals — Stretch

Give the provider a per-request deadline: `AbortSignal.any([opts.signal, AbortSignal.timeout(60_000)])`. Use `signal.reason?.name` to tell `TimeoutError` (report "the model took too long") from a user abort (stay quiet). Add a test with a 50 ms deadline on a `delayMs: 5000` step.

## Check

That's Checkpoint 1: a working engine. One signal reaches the model call, every tool and the gaps between them, and an abort comes back as a result, with the tool pairs still whole and no process left behind. A real failure still throws, so someone sees it. `ScriptedProvider` can play any model, slow or broken, so the whole engine is proven with Ollama switched off, and every later day builds its tests on it.

Next comes [Buffer 1](buffer-1.md), a day to catch up, repair or go further, and then [Day 14](day-14.md) starts week 3 by connecting the engine to a real interface through events.

Before you move on, check:

- [ ] Checkpoint 1 list fully ticked
- [ ] Commit `day-13: … checkpoint 1`

Solution: [`solutions/checkpoint-1/`](solutions/checkpoint-1/), the complete end-of-Day-13 project (127 course tests plus the 4 Day 7 capture tests).

## Stuck?

<details><summary>The abort test takes 30 seconds</summary>

The signal didn't reach `spawn`, or you're killing only `sh`, or `killTree` returns early because `sh` has already exited. Log inside the tool's abort listener. Also check that `executeTool` passes `{ signal }` as the **second** argument to `execute`.
</details>

<details><summary>Abort works, but only once the current tool finishes</summary>

That tool ignores its signal. Abort is cooperative (concept 1): a tool has to pass `signal` on to whatever it waits for, as `bash` passes it to its process group. Test tools you write yourself need it too.
</details>

<details><summary>After abort, I see two results for one call, or none</summary>

Each call must go through exactly one branch: skip (already aborted) **or** execute. Append the result after the branch, once.
</details>

<details><summary><code>ScriptedProvider: script exhausted</code> in my own test</summary>

The loop asked the model one more time than you scripted. After a tool turn, the loop always calls the model again to read the result, so a scenario with one tool call needs two replies: the call, and a final text answer.
</details>

<details><summary>My test hangs at the end even though it passed</summary>

Something still holds the event loop: a timer you didn't clear, or a child you didn't kill. `node --test --test-timeout=10000` helps you find which test it is.
</details>

## Common mistakes

- Passing the signal to `fetch` but not to `spawn`. The model call stops, but the command keeps running, and the loop waits for it. Ctrl+C is usually pressed while the model is talking, so the path that ignores the signal is the one you rarely try.
- Re-throwing `AbortError` out of `run()`. Every caller then needs a `try/catch` for a user's ordinary choice, and the partial history is lost. Rethrowing is the usual rule for errors you don't handle, and an abort arrives looking like one.
- A test that quietly calls the real Ollama. It passes on your machine and fails anywhere Ollama is off, and it proves the model, not the loop. Run the suite with Ollama stopped. Ollama is always running where you write the tests, so nothing tells you.
- Abandoning a promise without a handler when an abort makes you stop waiting for it. When it rejects later, Node exits with an error nobody was waiting for. Attach the handler as soon as the work starts (concept 5). Once you've stopped waiting, the promise feels finished, but the work behind it is still running.

## Self-check

1. Why must abort come back as a result instead of an exception?
2. Why is injecting `ScriptedProvider` safer than stubbing global `fetch`?
3. The abort test asserts elapsed time. What does that prove?
4. The model requested three tools and you aborted during the first. What's in the history afterwards?

Answers: [self-check-answers.md](self-check-answers.md#day-13).

## Further reading

- MDN, [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) (`reason`, `throwIfAborted`, `timeout`, `any`) · [`Promise.race`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/race)
- Node.js, [Test runner: mocking timers](https://nodejs.org/api/test.html#mocking) (a different way to test timeouts) · [`'unhandledRejection'`](https://nodejs.org/api/process.html#event-unhandledrejection)

---
← [Day 12](day-12.md) · [Curriculum home](README.md) · Next: [Buffer 1](buffer-1.md), then [Day 14 — Events and the printer](day-14.md) →
