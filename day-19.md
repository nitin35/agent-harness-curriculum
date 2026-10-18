# Day 19 — Resume: It Remembers You

**Phase:** Week 3 — Interactive harness

## By tonight

```
$ node src/cli/main.js
> My favorite color is blue.
agent> Got it — blue!
> /quit
$ node src/cli/main.js
  resume last session? [y/N] y
  · resumed 3f2a9c1e · 2 messages
> what color did I say?
agent> You said your favorite color is blue.
```

There are two separate programs in this transcript. The first one hears about blue and quits. The second starts from nothing, finds a session saved in this folder, and asks whether to resume it. You answer `y`, it reports which session and how many messages, and then it answers a question that only makes sense if the model was given the first conversation. That last answer is the whole point of today: it comes from the model, not from anything printed on the screen.

## Why it matters

On Day 17 every run started going to disk, and yesterday the harness got commands of its own, including `/new`. The conversations are saved, but nothing reads them back yet. Every start is a fresh session.

Persistence is only real if the **model** remembers, not only the screen. Here's how resume goes wrong in a way that looks right. The harness starts, finds yesterday's session, and prints the old conversation, so the terminal shows everything you said. Then you ask a follow-up, the harness calls `loop.run(message)` with **empty history**, and the model has no idea what you're talking about. The UI looks resumed, but the model starts from scratch. It's the classic bug, and it survives any check that only looks at the screen.

Today you make resume feed history, and you prove it with a test that can't be fooled by what's on the screen.

## Concepts

### 1. Resume feeds history, not pixels

The model knows only what's in the request. Each call sends a list of messages (Day 7), and the model has no other memory. A resumed session loads `session.getMessages()` (the active path) and passes it as `loop.run(text, history)`. Since Day 17 the bridge's `getHistory` already returns `session.getMessages()`, so resuming only means **swapping which session is current**.

Here is what the reference harness sends to the model for *By tonight*'s second question, after resuming:

```
system:    You are a coding assistant running in a …
user:      My favorite color is blue.
assistant: Got it — blue!
user:      what color did I say?
```

The same question in a fresh session sends only `system` and the new `user` message, and the model answers `I do not know.` Printing the old conversation on the screen changes neither list. Only the history argument does.

Swapping the current session is an event with consequences, though, and so are starting, quitting and `/new`. They need to be decided together.

### 2. The lifecycle as a small state machine

Every session event has one defined effect. This is Day 6's idea again, a table of triggers and what each one does, applied to sessions:

| Trigger | What happens |
|---|---|
| startup | a session saved **in this folder** exists → ask `resume last session? [y/N]` (**default N**, because prompts default to the safe choice) |
| a run ends | the bridge's `onRunComplete` appends its messages (Day 17). Nothing else: the newest file *is* the last session |
| `/new` | emit `session_shutdown` → create a fresh session → emit `session_start` |
| `/resume` | numbered picker → open the chosen file → it becomes current → `session_start` |
| `/quit` | emit `session_shutdown` → stop the UI. There's nothing to save, because every run was saved when it ended |

Illegal transitions are refused, not improvised. Commands run immediately, even mid-run (Day 18), so `/new` and `/resume` are `idle` commands: mid-run they answer "works between runs" instead of moving a running conversation into another session.

Look at the second row's trigger: "a run ends", not `agent_end`. The two sound the same, but they happen at different moments, and the difference is pure async ordering. The loop emits `agent_end` in its `finally`, **before** `run()` resolves and before anything is saved, and the bus doesn't wait for listeners. Here is the same shape with a general example, an oven whose bell rings in a `finally`:

```js run
const listeners = [];
const plate = [];

async function bake(cake) {
  try {
    await new Promise((resolve) => setTimeout(resolve, 10));   // baking
    return cake;
  } finally {
    for (const listener of listeners) listener();              // the oven's bell rings
  }
}

listeners.push(() => console.log(`1. bell rings; on the plate: [${plate}]`));
const cake = await bake('sponge');
plate.push(cake);                                              // only now is the cake served
console.log(`2. bake() has resolved; on the plate: [${plate}]`);
// → 1. bell rings; on the plate: []
// → 2. bake() has resolved; on the plate: [sponge]
```

`return cake` doesn't hand the cake over straight away. The `finally` runs first, so the bell rings while the plate is still empty. Only after the `finally` has finished does `bake()`'s promise fulfil, and the caller's code after `await` runs later still, as a microtask. A listener on the bell can't see the result, because the result hasn't been delivered yet. Saving on `agent_end` would race the run's own result in exactly this way. In order:

```
loop.run()   … finally: emit agent_end      ← a listener here runs before the result exists
             run() resolves { newMessages } ← "a run ends": the bridge's onRunComplete appends them
```

So the save happens where the result is: in the bridge, after `await loop.run(…)` has returned it.

The table's first row hides a decision of its own: *which* saved session counts as "the last one".

### 3. Sessions belong to a folder

A conversation is about one project. Every header records `cwd`. Resume only what was started **here**: the startup offer, `/resume`'s list and Day 26's `-c` all use `listSessions(dir, { cwd })`. A conversation from another project talks about files the tools here can't reach. Ask about "src/billing.js" in the wrong folder and the model is confidently wrong while every tool call fails. Claude Code's `--continue` and `/resume` are per folder for the same reason.

In practice: start the harness in a folder where you've never chatted, and it doesn't ask to resume at all, while `/resume` answers `No other saved sessions in this folder.` A subfolder of a project is a different folder, so start the harness from the folder you chatted in.

The startup offer only ever proposes one session. `/resume` lets you choose among several, and choosing has its own trap.

### 4. Pickers need an escape hatch

Choosing must include "choose nothing". `/resume` lists up to 15 sessions from this folder (newest first, excluding the current one) and asks `resume which? (number, empty to cancel)`. **An empty line cancels.** It never means "the first one", or every stray Enter would resurrect an old session. It uses `ui.ask()`, the same single-stdin primitive as approvals.

From the reference harness, once cancelled and once picked (your ids and times will differ):

```
  ·  1. 2026-10-03 18:22 · 2e4f7450 · qwen3.5:4b
  ·  2. 2026-10-03 18:22 · 146e95d4 · qwen3.5:4b
  resume which? (number, empty to cancel)
  · cancelled

  resume which? (number, empty to cancel) 1
  · resumed 2e4f7450 · 2 messages · last: "what color did I say?"
```

`/resume 2` skips the question and picks the second session directly.

This is the same reasoning as the startup prompt's default N, and Day 12's fail-closed approvals. When the user's answer is missing or unclear, do the thing that changes nothing.

### 5. Show a summary, not the transcript

One line is enough to orient you. After resuming, print one line, such as `resumed 3f2a9c1e · 12 messages · last: "add tests for…"` (skip Day 15's interruption note when you look for the last thing you said). Reprinting the whole transcript is optional flavour. The history argument is what matters.

The interruption note, `[Request interrupted by user]`, is stored as a user message, so a naive "last user message" would show it instead of what you actually asked. That's why it's skipped.

## Build

### 19.1 `ctx.openSession` and `/resume` — Core

`openSession(path)`:
1. `SessionManager.open` it;
2. emit `session_shutdown` for the old session;
3. make it current;
4. emit `session_start`.

Add `ctx.listSessions = () => listSessions(paths.sessions, { cwd })`. Then add the `/resume [number]` command (concept 4), with `idle: true`. With a number argument it skips the picker.

The order of `openSession` matters. Opening comes first, so a corrupt or unreadable file throws before anything has changed: you keep the session you had. Only once the new one is open does the old one shut down. In `/resume`, filter out the current session's id before numbering, so you can't "resume" the conversation you're already in.

Step 3 is Day 18's reassigned variable again. Every `getSession()` and every `getHistory()` after it reads the new session, which is what makes the model see the resumed history on the very next message.

### 19.2 Startup prompt — Core

`app.start({ resume: 'ask' | 'last' | 'new' })` returns a promise that resolves once the app is ready for input. Start the UI without showing the prompt yet (`ui.start({ showPrompt: false })`), take the newest session in this folder (`(await ctx.listSessions())[0]`), ask if there is one, then `showPrompt()`. Day 26's `-c`/`--new` flags map onto `'last'` and `'new'`.

The three values: `'ask'` asks when there's a session to offer, `'last'` resumes it without asking, and `'new'` never looks. If the answer is anything but `y`, or there's nothing to offer, emit `session_start` for the fresh session that `createApp` already made.

Holding the prompt back matters because of a gap in time. Once the UI has started, readline is reading the keyboard, but the question only appears after `await ctx.listSessions()` has read the folder. A line that arrives in between finds no question pending, so readline delivers it as an ordinary `'line'` event, and it goes to the model as a message (Day 15). Showing no `> ` until the question has been asked means a person has no reason to type in that gap.

### 19.3 Course tests — Core

Copy `course-tests/day-19/`. These are **integration tests**: they run `createApp` over in-memory streams, with a `ScriptedProvider` and a temp config dir. They cover:
- auto-save, including a run that failed after its tool wrote a file;
- the **continuity check** (quit, restart, resume; the provider *receives* the old message);
- answering N at startup;
- `/resume` cancel and pick, where the picked history reaches the model;
- `/new`;
- resume per folder (another project's session is never offered);
- `/new` and `/resume` refused mid-run.

The tests wait for each question to appear before answering, just like a person. If your app reads input before asking, they hang (so run them with `--test-timeout=10000`).

That waiting is the 19.2 gap from the test's side. The test watches the output stream for the question text and only then writes its answer, so an app that never asks, or asks with different words, leaves the test waiting for a question that doesn't come.

The continuity check is the important one, and its idea is worth copying into your own tests. The scripted model's reply is a *function* of the messages it receives (Day 13). It answers `blue` only if the old message is really in its history. So the test passes only if resume fed the history, not merely if something was printed.

### 19.4 The continuity check, live — Core

Do the *By tonight* transcript for real with Ollama. If the model can't answer "what color did I say?", your history never reached `run()`. Fix that before Day 20. Paste the transcript into `notes/day-19.md`. Commit `day-19: resume`.

### 19.5 Session names — Stretch

`/name <text>` sets `session.header.name` and `save()`s, and `/resume` shows names. Bonus: auto-name a session from the first user message (the first 40 characters) on its first save.

## Check

The harness now remembers you across restarts, and the proof is the model's answer, not the screen. Resuming swaps which session is current, and because the bridge reads its history through `getHistory()`, the very next request carries the old conversation. Each session event has one defined effect, and the save happens when `run()` has returned its result, not on `agent_end`, which fires before the result exists. Sessions belong to the folder they started in, and every choice, the startup prompt and the picker alike, treats a missing answer as "change nothing".

Tomorrow, [Day 20](day-20.md) replaces the yes/no prompt you've been answering since Day 12 with a real approval gate: permission rules and modes that can allow or deny a call before you're asked at all.

Before you move on, check:

- [ ] `node --test tests/course/day19-*` green (8 tests)
- [ ] Live continuity check passes (blue survives a restart)
- [ ] Commit `day-19: resume`

Solution: `createApp` (`openSession`, `resumeCommand`, `start`) in [`solutions/checkpoint-3/src/app.js`](solutions/checkpoint-3/src/app.js).

## Stuck?

<details><summary>Resumed, but the model has amnesia</summary>

Log `getHistory().length` inside the bridge right before `loop.run`. If it's 0 after resuming, the bridge is reading the *old* session object. Make `getHistory` read the *current* session each time (`() => session.getMessages()`, where `session` is a variable you reassign).
</details>

<details><summary>The startup test hangs</summary>

Your app asks *after* an async step, and the test's answer arrived first, so it was treated as a normal message. The course test waits for the question text; make sure your question contains `resume last session?`.
</details>

<details><summary>The startup question never appears, though you chatted yesterday</summary>

Sessions are per folder, so check that you started the harness in the same folder as before (not a subfolder). `ls ~/.config/agent-harness/sessions/` shows the files, and `head -1` on one shows the `cwd` it recorded.
</details>

## Common mistakes

- **Resuming empty history:** reprinting the old messages but not passing them to `run()`. The screen is what you check by eye, and it looks perfect.
- Mapping an empty picker answer to session 1. "Default to the first item" feels friendly, until a stray Enter swaps your conversation.
- Creating a fresh session id on every `agent_end`, which turns one conversation into a pile of fragments. `agent_end` sounds like "the conversation ended", but it fires after every run.
- A global "last session": in another project, the model picks up a conversation about files the tools can't reach. With one project on your machine, global and per-folder behave the same, so the difference only shows up on the second project.

## Self-check

1. Why isn't reprinting a transcript enough for the model to remember?
2. What happens at each trigger: startup, a run ending, `/new`, `/resume`, `/quit`? Why "a run ending" and not `agent_end`?
3. Why does an empty line cancel the picker?
4. Why does the startup prompt default to N?
5. Why does resume only offer sessions from the current folder?

Answers: [self-check-answers.md](self-check-answers.md#day-19).

## Further reading

- Anthropic, [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents): how real harnesses keep state across sessions
- Claude Code, [CLI reference](https://code.claude.com/docs/en/cli-reference): its `--continue` and `--resume` flags, which work per folder like yours

---
← [Day 18](day-18.md) · [Curriculum home](README.md) · Next: [Day 20 — Approval gate and permission rules](day-20.md) →
