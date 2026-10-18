# Day 12 — The Agent Loop (with a Fail-Closed Approval Gate) ⚠

**Phase:** Week 2 — Provider & tools

## By tonight

```
$ node scripts/smoke-loop.js "How many files are in the toy folder? Use the bash tool."
  → bash {"command":"find ./toy -maxdepth 1 -type f | wc -l"}
  allow bash {"command":"find ./toy -maxdepth 1 -type f | wc -l"}? [y/N] y
  ←        5

answer (2 turns, aborted=false):
There are **5** files in the "toy" folder.
```

Look at the three marks. `→` is the model asking for a tool, `allow …?` is the loop stopping to ask you, and `←` is the tool's result going back. This is your **real** loop, not the toy. It drives your provider, your registry and your jailed tools, and nothing dangerous runs without your `y`.

## Why it matters

For four days you've built parts: a provider that talks to the model, a registry that holds tools, a jail, and tools that read, write, edit and run commands. Nothing yet connects them. Today you write the engine that does.

`AgentLoop` is that engine, and it has to be boringly correct:
- tools are looked up fresh every turn;
- every tool call gets exactly one result, in order;
- runaway loops stop;
- bad tool calls become results the model can learn from;
- **risky tools are denied unless someone approves them.**

Each of those is a bug that some harness, somewhere, has shipped. A loop that caches its tools can't see one added later. A loop that answers two calls out of three sends the model a history the server rejects. A loop whose approval check defaults to "yes" runs shell commands nobody saw. The loop is short, but it's the code every other day leans on, so it's worth writing slowly.

This is a heavier day, but you know its shape already: it's the toy's `runTurns` from Days 2–3, grown up.

## Concepts

### 1. Write the pseudocode first

The loop has many exit paths and an order that matters, and pseudocode lets you check both before any code exists:

```
run(userMessage, history, { signal }):
  newMessages = [ user(userMessage) ]
  emit agent_start
  for turn in 1..maxTurns:
    emit turn_start
    reply = provider.chat([system, ...history, ...newMessages], registry.toProviderTools(), { signal })
    append assistant(reply)                      # with toolCalls, thinking, usage
    if no toolCalls: emit turn_end; return result(reply.content)
    for call in reply.toolCalls:                 # sequential, in order
      emit tool_call_start; r = executeTool(call); emit tool_call_end
      emit tool_result; append tool_result(call.id, r)
    emit turn_end
  return result(partial, warning "maxTurns")
  finally: emit agent_end                        # every exit path, exactly once
```

Compare it with the toy's `runTurns`. The `for` over turns and the inner `for` over tool calls are the same. What's new:
- the history arrives as an argument and isn't changed: the run collects **`newMessages`** and returns them;
- the loop **emits events** at each step (Day 6's protocol), so a UI can draw it and a test can check it;
- every return goes through one `result(…)` helper, so the caller always gets the same shape;
- `agent_end` sits in a `finally` (Day 5), so it fires on every exit: an answer, `maxTurns` or a thrown error.

**One run, start to finish.** With a fake provider that first asks for `read` and then answers (Day 2's injection, now for the provider), and a registry whose test `read` tool returns `contents of <path>: hi`, a run produces exactly this:

```js
const replies = [
  { content: '', toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'notes.txt' } }] },
  { content: 'The notes say hi.', toolCalls: [] },
];
const loop = new AgentLoop({ provider: { chat: async () => replies.shift() }, registry });
const result = await loop.run('What do my notes say?');

result.response                    // → 'The notes say hi.'
result.turns                       // → 2
result.newMessages
// → [
//     { role: 'user', content: 'What do my notes say?' },
//     { role: 'assistant', content: '',
//       toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'notes.txt' } }] },
//     { role: 'tool_result', content: 'contents of notes.txt: hi', toolCallId: 'call_1',
//       toolName: 'read', isError: false },
//     { role: 'assistant', content: 'The notes say hi.' },
//   ]
```

The events, in order: `agent_start → turn_start → tool_call_start → tool_call_end → tool_result → turn_end → turn_start → turn_end → agent_end`. That's a legal walk through Day 6's state machine.

The pseudocode hides several rules inside single lines. The rest of this section takes them one at a time, starting with the one about order.

### 2. The tool-pair invariant

A call and its results are one unit. An assistant message with `toolCalls` is followed by **one result per call, in the same order**, before the provider is called again. Tomorrow, abort keeps this true as well ([contract](README.md#tool-pair-history-invariant)).

```
✓  assistant { toolCalls: [call_1, call_2] }
   tool_result call_1
   tool_result call_2
   (now the next provider call)

✗  assistant { toolCalls: [call_1, call_2] }
   tool_result call_1
   (provider call: call_2 was never answered)
```

Hosted APIs reject the second history outright, and a local model is left guessing what happened to `call_2`. You met this on Day 3 with the toy, and Day 25's compaction has to keep pairs whole too.

The next rule hides in where one line of the pseudocode sits.

### 3. Fresh tools every call

The pseudocode calls `registry.toProviderTools()` inside the turn loop, and that placement is deliberate. Call `registry.toProviderTools(enabledTools)` **right before every** provider call, never once in the constructor. On Day 22, extensions add tools while the program runs, and a cached list is stale by construction.

```js
this.tools = registry.toProviderTools();            // ✗ in the constructor: a snapshot that goes stale

const tools = this.registry.toProviderTools(this.enabledTools);   // ✓ inside the turn loop, every time
```

The call costs almost nothing, and "why can't the model see my new tool?" is a miserable bug to track down. Day 23's MCP tools and Day 24's skills also arrive while the program runs.

Fresh tools tell the model what it can ask for. What it actually asks for can still be wrong.

### 4. `executeTool` never throws

Another single line of the pseudocode, `r = executeTool(call)`, has to survive everything a model can get wrong. Every way a tool call can go wrong becomes a result, so the model can read what happened and try again, and the run carries on. Each step that can fail becomes a result:
1. **An unknown tool, or one that isn't enabled:** `"Unknown tool 'fs_read'. Available tools: read, write, edit, bash."`
2. **`call.parseError`, or `validateArguments` fails:** Day 9's malformed-arguments message, ending in *"Retry the call with corrected arguments."*
3. **Approval:** see concept 5.
4. **`tool.execute(args, { signal })`:** a string result is wrapped as `{ content, isError: false }`; the result is checked with `validateToolResult`; and a throw becomes `"Tool X failed: <message>"`.

From the reference solution, with a registry of `read`, `bash` and a tool that always throws:

```js
await loop.executeTool({ id: 'c', name: 'fs_read', arguments: {} })
// → { content: "Unknown tool 'fs_read'. Available tools: read, bash, boom.", isError: true }
await loop.executeTool({ id: 'c', name: 'read', arguments: { path: 42 } })
// → { content: 'Invalid arguments for read: path must be string, got number. Retry the call …',
//     isError: true }
await loop.executeTool({ id: 'c', name: 'boom', arguments: {} })
// → { content: 'Tool boom failed: disk on fire', isError: true }
```

Listing the available tools in the first message matters: models correct a wrong name quickly once they're told what exists.

Of those steps, approval is the only one that involves a person, so it gets a concept of its own.

### 5. Approval: minimal today, fail closed always

Some tools must not run until a person says yes. `AgentLoop` takes an optional `approve(call, tool, { signal })`. It resolves to `true`/`false`, or to `{ approved, reason?, by? }`.

- `needsApproval` and `autoApprove` → run without asking (an explicit opt-in only).
- `needsApproval` and **no `approve` function** → **deny**: `"Denied bash (approval required but no approver is attached…)"`.
- Otherwise → ask. A denial is a normal tool result that the model can react to.

The second rule is the important one. *Fail closed* means that when the gate can't get an answer, the answer is no. A door lock that stays locked when the power fails is fail-closed. If the loop *allowed* tools whenever no approver was attached, then a test, a script or a misconfigured app would quietly run shell commands nobody approved. Denying costs at most a confused model. Allowing can cost your files.

Who refused decides the wording. A human "no" reads `User denied bash`. A refusal no human made (a rule, a mode, nobody to ask) reads `Denied bash (<reason>)`. The approver says which with `by: 'policy'`, and anything else counts as the user's. Route on that field, never on the reason's text (Day 5): a policy whose reason happens to contain "aborted" is still a policy.

| The approver resolves to | The `bash` call's result |
|---|---|
| `true` | the tool runs |
| `false` | `User denied bash` |
| `{ approved: false, reason: 'timed out' }` | `User denied bash (timed out)` |
| `{ approved: false, by: 'policy', reason: 'bash is not allowed in read-only mode' }` | `Denied bash (bash is not allowed in read-only mode)` |
| (no approver attached) | `Denied bash (approval required but no approver is attached; …)` |

Today's approver is a three-line `readline` prompt in a script. Day 20 replaces it with the real gate, through the same function signature.

The last rule isn't in the pseudocode at all, because it's about how the code is written rather than what it does.

### 6. Async state belongs in locals

Every `await` is a point where other code can run (Day 3). While one run waits for the model, timers fire, the UI reacts, and in principle a second run could start. So state that belongs to one run must live in that run's local variables, never in module-level variables shared by every run.

Here is what goes wrong otherwise, on a small example. Two calls to the same function each count their own steps, once with a shared counter and once with a local one:

```js run
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let steps = 0;                                   // ✗ module level: shared by every call
async function walkShared(name, n) {
  steps = 0;
  for (let i = 0; i < n; i++) {
    await delay(10);
    steps++;
  }
  console.log(`shared: ${name} took ${steps} steps`);
}

async function walkLocal(name, n) {
  let steps = 0;                                 // ✓ local: each call has its own
  for (let i = 0; i < n; i++) {
    await delay(10);
    steps++;
  }
  console.log(`local:  ${name} took ${steps} steps`);
}

await Promise.all([walkShared('a', 3), walkShared('b', 5)]);
await Promise.all([walkLocal('a', 3), walkLocal('b', 5)]);
// → shared: a took 5 steps
// → shared: b took 8 steps
// → local:  a took 3 steps
// → local:  b took 5 steps
```

With the shared counter, both calls reset the same `steps`, and then each one's `steps++` lands on the other's count at every `await`, so `a` reports 5 steps instead of 3. Nothing threw, and both answers are wrong. With a local `steps`, every call gets its own variable, and the `await`s don't matter. In the loop, that means `turn`, `newMessages`, the tool log and the usage totals are all locals of `run`:

```js
async run() {
  let turn = 0;                      // ✓ local: each call gets its own
  const newMessages = [];
  …
}
```

Keep loop state in local variables and the result object. Then guard re-entry. If `run()` is called while it's already running, that's a programmer error, so throw `already running`. (On Day 15, the bridge *queues* input instead.)

```js
const first = loop.run('a');
await loop.run('b');
// Error: AgentLoop.run() is already running — queue the message instead
```

The guard is a flag, and *where* you set it matters. The check and the set must come with no `await` between them. That's Day 3's check-then-act rule again: anything after an `await` may be acting on a check that's no longer true. Here are two guards, run twice at once:

```js run
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let busy = false;

async function gapGuard() {               // ✗ an await between the check and the set
  if (busy) throw new Error('already running');
  await delay(1);
  busy = true;
  try { await delay(10); return 'done'; } finally { busy = false; }
}

async function tightGuard() {             // ✓ check and set back to back
  if (busy) throw new Error('already running');
  busy = true;
  try { await delay(10); return 'done'; } finally { busy = false; }
}

const statuses = async (f) => (await Promise.allSettled([f(), f()])).map((r) => r.status);
console.log('gap:  ', await statuses(gapGuard));     // → [ 'fulfilled', 'fulfilled' ]   both got in
console.log('tight:', await statuses(tightGuard));   // → [ 'fulfilled', 'rejected' ]
```

In `gapGuard`, both calls check `busy` before either has set it, because each one pauses at the `await` in between. In `tightGuard`, the first call's check and set run in one stretch, before it reaches any `await`, so the second call sees `busy` already `true`. That's why `run()` checks and sets its flag on its first two lines.

Reset the flag in the same `finally` that emits `agent_end`, as `tightGuard` does. Then a run that crashed (the provider threw, say) doesn't leave the loop locked, and the next message can run.

## Build

The order follows the advice in concept 1: words before code. The pseudocode goes in your notes first, then the types, then the loop itself against the course tests, and only at the end a live run with a real model and a real `y`.

**Files today:** `notes/day-12.md`, `src/agent/agent-schemas.js`, `src/agent/agent-loop.js` and `scripts/smoke-loop.js`.

### 12.1 Pseudocode — Core

Copy and adapt concept 1 into `notes/day-12.md` **before** writing any code. Mark where the tools are fetched, where the pair is appended, where `executeTool` can return `isError`, and every return path.

### 12.2 `src/agent/agent-schemas.js` — Core

Typedefs:
- `ApproveFn`, resolving to `boolean | { approved, reason?, by?: 'user' | 'policy' }`;
- `AgentOptions`: `provider`, `registry`, `systemPrompt?` (a string or a function), `maxTurns?` (default 20), `approve?`, `autoApprove?`, `enabledTools?`, `emit?` and `streaming?`;
- `AgentResult`: `response`, `turns`, the `toolCalls` log, `usage` (`{ promptTokens, completionTokens, lastPromptTokens }`), `aborted`, `newMessages` and `warning?`.

Add `validateAgentOptions(options)` returning `{ ok, error }`.

`systemPrompt` may be a function so that a later day can build the prompt fresh for every run: Day 24 does, from the project's instructions. `validateAgentOptions` follows Day 9's style: check that `provider` has a `chat` method and `registry` has `getTool`, and report the first problem.

### 12.3 `src/agent/agent-loop.js` — Core

```js
export const DEFAULT_SYSTEM_PROMPT = '…you have tools… use them instead of guessing… if a tool errors, adjust.';
export class AgentLoop {
  constructor(options) { … }               // validate; store; emit defaults to a no-op
  get isRunning() { … }
  async run(userMessage, history = [], { signal } = {}) { … }   // → AgentResult
  async executeTool(call, { signal } = {}) { … }                // → ToolResult, never throws
}
```

`run` builds `newMessages` (the messages added during this run) and returns them, so sessions (Day 17) can save exactly what's new. Messages use the internal shape:
- `{ role: 'assistant', content, thinking?, toolCalls?, usage? }`
- `{ role: 'tool_result', content, toolCallId, toolName, isError }`

Emit `agent_start`, `turn_start`, `tool_call_start`, `tool_call_end`, `tool_result`, `turn_end` and `agent_end` (the last one in a `finally`) through `this.emit(name, payload)`. Day 14 plugs in the event bus.

A small helper keeps the return paths consistent: `const result = (extra) => ({ response, turns: turn, toolCalls: toolLog, usage, aborted: false, newMessages, ...extra })`. Then the normal answer is `return result()`, and running out of turns is `return result({ warning: … })`. Inside `executeTool`, follow concept 4's order: look up, check arguments, approve, execute, normalize.

### 12.4 Course tests — Core

Copy `course-tests/day-12/`. It uses a hand-rolled fake provider, and covers:
- plain answers, a tool turn then a text turn (the second call sees the whole pair), and history order;
- sequential calls, fresh tools, unknown tools, malformed and invalid arguments, and throwing tools;
- maxTurns;
- **deny with no approver**, approve and deny callbacks, the `by: 'policy'` wording, and autoApprove;
- re-entry, and the event order.

### 12.5 Live: your loop, your approval — Core

`scripts/smoke-loop.js`: a registry with `createBuiltinTools({ root: process.cwd() })`, an `OllamaProvider`, and the minimal approver:

```js
approve: async (call) => {
  const a = await rl.question(`  allow ${call.name} ${JSON.stringify(call.arguments)}? [y/N] `);
  return a.trim().toLowerCase() === 'y';
},
emit: (event, p) => {
  if (event === 'tool_call_start') console.log(`  → ${p.name} ${JSON.stringify(p.arguments)}`);
  if (event === 'tool_result') console.log(`  ← ${p.content.split('\n')[0]}`);
},
```

The `tool_result` line prints the first line of each result, which is where *By tonight*'s `←        5` comes from. The script ends by printing `result.turns`, `result.aborted` and `result.response`.

Run it on a question that needs `bash`, then on one that needs `read` (no approval needed: `read` is read-only). Deny once and watch the model adapt. Paste both transcripts into `notes/day-12.md`. Commit `day-12: agent loop + minimal approval`.

### 12.6 Why sequential? — Stretch

Models can request several calls at once (your Day 7 capture had two). Write a paragraph on why we still run them one at a time:
- deterministic history order;
- one approval prompt at a time;
- one shell at a time.

Then name a tool for which parallel execution would be safe and worth it (several `read`s?). How would you mark such tools?

## Check

The parts are now one engine. The loop asks the registry for tools on every turn, answers every tool call in order, turns every mistake into a result the model can read, stops a model that won't stop, and refuses risky tools unless someone says yes. It does that with no approver at all, too. Its state lives in locals, so one run can't corrupt another, and every exit ends with exactly one `agent_end`.

Tomorrow you make it stoppable. [Day 13](day-13.md) threads Ctrl+C through the whole loop, as Day 3 did for the toy, and builds a fake model that lets every later test run without Ollama. That completes Checkpoint 1.

Before you move on, check:

- [ ] `node --test tests/course/day12-*` green (15 tests)
- [ ] `notes/day-12.md`: pseudocode written before the code, plus two live transcripts (approve and deny)
- [ ] With no approver attached, `bash` is denied; with one, you are asked
- [ ] Commit `day-12: agent loop + minimal approval`

Solution: `src/agent/` and `scripts/smoke-loop.js` in [`solutions/checkpoint-1/`](solutions/checkpoint-1/).

## Stuck?

<details><summary>The "fresh tools" test fails</summary>

You're calling `toProviderTools()` once, before the `for` loop. Move it *inside* the loop, right before `provider.chat`.
</details>

<details><summary>The event-order test sees <code>agent_end</code> twice, or not at all</summary>

Emit it exactly once, in a `finally` around the whole body of `run`, and nowhere else.
</details>

<details><summary>The wording test says "User denied" where it expects "Denied"</summary>

Pass `by` through from the approver's answer, and choose the wording from `decision.by === 'policy'`, not from the text of `reason`.
</details>

<details><summary>The model keeps calling a tool that doesn't exist</summary>

Make the unknown-tool message list the available tools. Models correct themselves quickly when told what exists.
</details>

<details><summary><code>TypeError: Cannot read properties of undefined (reading 'length')</code> inside <code>run</code></summary>

A reply without a `toolCalls` array reached the loop: usually a fake provider in a test that returns `{ content: 'hi' }`. A real `ChatResponse` always has `toolCalls`, even if it's empty (Day 7's schema), so make your fakes return `toolCalls: []` too.
</details>

<details><summary>After one failed run, every later run says "already running"</summary>

The running flag was set, but nothing cleared it when the run threw. Clear it in the `finally` block, next to `agent_end`.
</details>

## Common mistakes

- **Caching the tool list.** Tools added later (extensions, MCP, skills) never reach the model.
- **Appending the assistant's tool-call message, but calling the provider before all its results are appended.** The provider sees an unanswered call, and hosted APIs reject the request.
- **An approval stub that *allows* by default.** A test or a script with no approver then runs commands nobody saw. Fail closed.
- **Deciding who refused by searching the reason's text.** A policy's reason can contain any words, so route on `by`.
- **Keeping per-run state in module-level variables.** Two overlapping runs then share it, and both report wrong numbers without an error (concept 6).

## Self-check

1. Why fetch the tool list before every provider call?
2. What is the tool-pair invariant, and what breaks if you violate it?
3. `maxTurns` runs out mid-task. What does the caller receive?
4. A `needsApproval` tool runs in a script with no approver attached. What happens, and why is that the right default?

Answers: [self-check-answers.md](self-check-answers.md#day-12).

## Further reading

- Anthropic, [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents): the "agent loop" section
- Thorsten Ball, [How to Build an Agent](https://ampcode.com/how-to-build-an-agent): compare your loop with his
- Wikipedia, [Fail-safe](https://en.wikipedia.org/wiki/Fail-safe): fail-closed and fail-open designs, outside software

---
← [Day 11](day-11.md) · [Curriculum home](README.md) · Next: [Day 13 — Abort, ScriptedProvider and Checkpoint 1](day-13.md) →
