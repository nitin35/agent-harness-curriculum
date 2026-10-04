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

## Why it matters

Persistence is only real if the **model** remembers, not just the screen. The classic bug reprints the old transcript and then calls `loop.run(message)` with **empty history**. The UI looks resumed, but the model starts from scratch. Today you make resume feed history, and you prove it with a test.

## Concepts

### 1. Resume feeds history, not pixels

**The model knows only what's in the request.** Each call sends a list of messages (Day 7), and the model has no other memory. A resumed session loads `session.getMessages()` (the active path) and passes it as `loop.run(text, history)`. Since Day 17 the bridge's `getHistory` already returns `session.getMessages()`, so resuming just means **swapping which session is current**.

Here is what the reference harness sends to the model for *By tonight*'s second question, after resuming:

```
system:    You are a coding assistant running in a …
user:      My favorite color is blue.
assistant: Got it — blue!
user:      what color did I say?
```

The same question in a fresh session sends only `system` and the new `user` message, and the model answers `I do not know.` Printing the old conversation on the screen changes neither list. Only the history argument does.

### 2. The lifecycle as a small state machine

**Every session event has one defined effect.** This is Day 6's idea again, applied to sessions:

| Trigger | What happens |
|---|---|
| startup | a session saved **in this folder** exists → ask `resume last session? [y/N]` (**default N**, because prompts default to the safe choice) |
| a run ends | the bridge's `onRunComplete` appends its messages (Day 17). Nothing else: the newest file *is* the last session |
| `/new` | emit `session_shutdown` → create a fresh session → emit `session_start` |
| `/resume` | numbered picker → open the chosen file → it becomes current → `session_start` |
| `/quit` | emit `session_shutdown` → stop the UI. There's nothing to save, because every run was saved when it ended |

Illegal transitions are refused, not improvised. Commands run immediately, even mid-run (Day 18), so `/new` and `/resume` are `idle` commands: mid-run they answer "works between runs" instead of moving a running conversation into another session.

**Why "a run ends", and not `agent_end`.** Note "a run ends", not `agent_end`. The loop emits `agent_end` in its `finally`, **before** `run()` resolves and before anything is saved, and the bus doesn't wait for listeners. Saving on `agent_end` would race the run's own result. In order:

```
loop.run()   … finally: emit agent_end      ← a listener here runs before the result exists
             run() resolves { newMessages } ← "a run ends": the bridge's onRunComplete appends them
```

### 3. Sessions belong to a folder

**A conversation is about one project.** Every header records `cwd`. Resume only what was started **here**: the startup offer, `/resume`'s list and Day 26's `-c` all use `listSessions(dir, { cwd })`. A conversation from another project talks about files the tools here can't reach. Ask about "src/billing.js" in the wrong folder and the model is confidently wrong while every tool call fails. Claude Code's `--continue` and `/resume` are per folder for the same reason.

In practice: start the harness in a folder where you've never chatted, and it doesn't ask to resume at all, while `/resume` answers `No other saved sessions in this folder.` A subfolder of a project is a different folder, so start the harness from the folder you chatted in.

### 4. Pickers need an escape hatch

**Choosing must include "choose nothing".** `/resume` lists up to 15 sessions from this folder (newest first, excluding the current one) and asks `resume which? (number, empty to cancel)`. **An empty line cancels.** It never means "the first one", or every stray Enter would resurrect an old session. It uses `ui.ask()`, the same single-stdin primitive as approvals.

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

### 5. Show a summary, not the transcript

**One line is enough to orient you.** After resuming, print one line, such as `resumed 3f2a9c1e · 12 messages · last: "add tests for…"` (skip Day 15's interruption note when you look for the last thing you said). Reprinting the whole transcript is optional flavour. The history argument is what matters.

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

### 19.2 Startup prompt — Core

`app.start({ resume: 'ask' | 'last' | 'new' })` returns a promise that resolves once the app is ready for input. Start the UI without showing the prompt yet (`ui.start({ showPrompt: false })`), take the newest session in this folder (`(await ctx.listSessions())[0]`), ask if there is one, then `showPrompt()`. Day 26's `-c`/`--new` flags map onto `'last'` and `'new'`.

The three values: `'ask'` asks when there's a session to offer, `'last'` resumes it without asking, and `'new'` never looks. If the answer is anything but `y`, or there's nothing to offer, emit `session_start` for the fresh session that `createApp` already made.

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

The continuity check is the important one, and its idea is worth copying into your own tests. The scripted model's reply is a *function* of the messages it receives (Day 13). It answers `blue` only if the old message is really in its history. So the test passes only if resume fed the history, not merely if something was printed.

### 19.4 The continuity check, live — Core

Do the *By tonight* transcript for real with Ollama. If the model can't answer "what color did I say?", your history never reached `run()`. Fix that before Day 20. Paste the transcript into `notes/day-19.md`. Commit `day-19: resume`.

### 19.5 Session names — Stretch

`/name <text>` sets `session.header.name` and `save()`s, and `/resume` shows names. Bonus: auto-name a session from the first user message (the first 40 characters) on its first save.

## Check

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

- **Resuming empty history:** reprinting the old messages but not passing them to `run()`.
- Mapping an empty picker answer to session 1.
- Creating a fresh session id on every `agent_end`, which turns one conversation into a pile of fragments.
- A global "last session": in another project, the model picks up a conversation about files the tools can't reach.

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
