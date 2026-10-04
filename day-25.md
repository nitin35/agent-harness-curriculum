# Day 25 — Compaction, and Checkpoint 3 ⚠ heavier day

**Phase:** Week 4 — Power & context · **Checkpoint 3**

## By tonight

```
> My name is Ada and my project codename is BLUEBIRD. Reply with just OK.
agent> OK
> … (a few more turns) …
> /compact
  · Compacted 2 messages
> What is my project codename? One word.
agent> BLUEBIRD
```

Long conversations no longer fall off the end of the window. When the prompt passes 80% of the **real** window, the oldest part of the conversation is folded into a single compaction record. The protocol stays valid (no orphaned tool calls), the latest question is never lost, and nothing is deleted from the session file.

## Why it matters

Without compaction, a long session with an 8k window dies one of two ways:
- **Hosted APIs** reject the request (400).
- **Ollama silently drops the start of the prompt** (Day 7). That includes your system prompt and tools, so the model starts acting strangely.

Compaction is how every serious harness keeps going. Getting it *safe* is the hard part: cut in the wrong place and you leave a tool call without its result, which breaks the protocol for every provider.

## Concepts

### 1. Strategies

**Compaction replaces the oldest part of the conversation with something shorter.** History grows with every turn, and the window doesn't (Day 24), so sooner or later the oldest messages have to give way. The question is what takes their place:

| Strategy | Cost | What you lose |
|---|---|---|
| Sliding window (drop the oldest) | free | everything old, including the task itself |
| **Truncated transcript (Core today)** | one file rewrite | the detail past a byte cap; the front of the dropped text survives |
| LLM summary (Stretch) | one extra model call | whatever the summary leaves out |

Picture the *By tonight* session. BLUEBIRD is in the very first message. A sliding window drops that message first, and the model can no longer answer. A transcript keeps the words, shortened to fit. A summary keeps what the model judged important, at the price of an extra call. Stretch 25.7 compares the last two on this exact test.

**Core writes a transcript.** Core folds the oldest part of the **active path** (`getPath()`, never `getEntries()`) into one entry whose `content` is a readable transcript (`user: …`, `assistant: [called bash {…}]`, `tool bash: …`). For a short session, the reference writes:

```
user: My name is Ada and my project codename is BLUEBIRD. Reply with just OK.
assistant: OK
user: How many files are in src?
assistant: [called bash {"command":"ls src | wc -l"}]
tool bash: 12
assistant: There are 12 files in src.
```

The model receives this as a single user message that starts with `[Earlier conversation, compacted — older details may be missing]`, so it can tell a record of the past from a new request.

**Tool results shrink first.** Each tool result is shortened to a taste first (it can be read again from disk). A result longer than 160 characters keeps its first 160 and its size: a 5000-byte log becomes `tool bash: xxxx… [5000 bytes; re-read if needed]`. The user's words and the assistant's decisions can't be read again from anywhere, so they get the space.

**Then the whole text is cut at both ends.** The transcript is cut **head and tail** (Day 11), so the task at the start and the newest summarized context at the end both survive — not only the oldest lines. With a 300-byte cap, a long transcript keeps both of its ends:

```
user: OLDEST: the task is to refactor billing
user: filler 0 yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy
user: filler 1 yyyyyyyyyyyyyyyyyyyyyyy
...[truncated: showing the first 150 and the last 150 of 2084 bytes. Use read with offset/limit or …]
yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy
user: filler 29 yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy
user: NEWEST: the codename is BLUEBIRD
```

**Size the cap relative to the window.** A fixed 32 KiB cap sounds modest, but it's about 8k tokens: the *entire* 8k window. Use about 20% of the window: `limit × 4 bytes × 0.2`. That's 6553 bytes for an 8192-token window, and 3276 bytes for 4096.

### 2. Where to cut: the invariants

**A tool pair travels together.** A tool pair is an assistant message with tool calls, plus one `tool_result` for each call. Every provider expects each result to follow the call it answers. Put the cut between them, and the kept part starts with an answer to a question the model never asked:

```
✗ user: [Earlier conversation, compacted …]     ← the call to c2 was folded in here
  tool_result c2: …                              ← a result for a call that isn't in the request
  assistant: …
```

Hosted APIs reject that request, and local models get confused about what happened. So the cut point `b` (the index of the first entry you keep) follows three rules.

Start at `b = path.length − keepMessages`, then:
1. **Never summarize the latest user message.** If `b` is past it, move `b` back to it.
2. **Never split a tool pair.** If `path[b]` is a `tool_result`, the cut would orphan it from its call, so move `b` **forward** past the pair's last result. Rule 1 is applied first, and a pair's results are always followed by a non-result entry (at the latest, the user message), so moving forward never passes the latest user message.
3. Nothing to fold (b ≤ 0), nothing left to keep (b ≥ length), or only an existing compaction entry to fold → do nothing. This is what stops repeated compaction from churning.

Here is a ten-entry path with `keepMessages: 4`. The start, `b = 6`, lands on `r2`, the result of `a3`'s call, so rule 2 moves it to `a4`:

```
before:  u1 → a1(call c1) → r1 → a2 → u2 → a3(call c2) → r2 → a4 → u3 → a5
cut 4:                                                   ↑ b lands on r2 → move to a4
after:   C[u1…r2] → a4 → u3 → a5         (a4.parentId rewritten to C.id)
```

Moving forward folds the whole pair into the summary, so the kept part is never larger than you asked for. That matters, because you're compacting to save space.

**Each rule has a case where it decides the outcome:**
- **Rule 1:** with `keepMessages: 1`, a path ending in `LATEST`, a call, its result and an answer keeps all four, starting at `LATEST`. The request you're answering is never folded into the summary.
- **Rule 2:** a pair right before the latest user message is folded whole, and the user message starts the kept part.
- **Rule 3:** a path no longer than `keepMessages` gives `null`. So does a path that ends in a tool pair with no user message (keeping nothing is not an option), and a compaction right after another one.

### 3. Rewiring one pointer

The compaction entry is `C = { type: 'compaction', id, parentId: <parent of the first summarized entry>, summarizedIds, content }`. To splice it in, set `kept[0].parentId = C.id`. One existing line changes, so the file is rewritten **atomically** (Day 17). The summarized entries **stay in the file** as an abandoned branch, so `getEntries()` still shows everything. Other branches are byte-for-byte untouched.

Here is a six-message session compacted with `keepMessages: 2`, with the ids shortened to `e1`…`e6`:

```
{"type":"message","id":"e1","parentId":null} q1
{"type":"message","id":"e2","parentId":"e1"} a1
{"type":"message","id":"e3","parentId":"e2"} q2
{"type":"message","id":"e4","parentId":"e3"} a2
{"type":"compaction","id":"C","parentId":null,"summarizedIds":["e1",…,"e4"],"content":"user: q1…"}
{"type":"message","id":"e5","parentId":"C"} q3        ← the one changed line: its parentId was "e4"
{"type":"message","id":"e6","parentId":"e5"} a3
```

Now the two views of the session differ:
- `getPath()` walks back from the leaf: `e6 → e5 → C`, then stops, because `C` has no parent. So the path is `C → e5 → e6`, and the model sees the compaction message, `q3` and `a3`.
- `getEntries()` still returns all seven entries. Nothing was deleted, and `q1`…`a2` can still be read.

**Why one pointer.** Copying the kept entries under new ids would also work, but every kept entry would then exist twice, and anything that remembered an old id would point at the wrong copy. Changing one `parentId` keeps every id stable.

**Why `C` goes before the kept entries.** Also put `C` *before* `kept[0]` in file order, so "the leaf is the last entry" (Day 17) stays true. Appended at the end of the file instead, `C` would be the last entry. After a reopen, the next message would hang off `C`, and `q3` and `a3` would fall off the active path.

### 4. Trees: `branch()` and `getChildren()`

**A branch goes back to an earlier point and continues differently, keeping both.** `branch(entryId)` moves the leaf to an existing entry; the next append becomes its child, which forks the tree. It's persisted as a tiny `{ type: 'leaf', leafId }` marker line, so the file stays append-only. `getChildren(id)` lists the forks.

From the course test: after `q1 a1 q2 a2`, branch at `a1` and continue with three new messages. The file and the tree look like this:

```
file:  header | q1 | a1 | q2 | a2 | {leaf → a1} | q2-alt | a2-alt | q3

tree:  q1 → a1 ─┬→ q2 → a2                       abandoned
                └→ q2-alt → a2-alt → q3          active path (the leaf is q3)
```

`getChildren(a1.id)` returns `q2` and `q2-alt`, in file order. When the file is reopened, `#ingest` reads the marker and moves the leaf back to `a1`, so `q2-alt` attaches in the same place. Compaction then works on the active path only: `q2` and `a2` stay byte-for-byte the same. A branch to an id that doesn't exist fails with `no such entry: <id>`.

(There's no `/branch` command in the core course; a `/fork` command is a nice Stretch.)

### 5. When to compact

**Before every model call.** Before **every** model call, the loop calls Day 24's `beforeModelCall({ history, newMessages, systemPrompt, tools })` hook. The app estimates the prompt (Day 24's calibrated count, against the effective window). Past 80%, it compacts the **session** and hands back the new, shorter history. The automatic case prints its reason, as in `Compacted 3 messages (context was over 80%)`.

`history` is what came before this run, and `newMessages` is the run so far. The session holds only finished runs (they're saved when a run ends, Day 17), so compaction can only fold earlier runs.

**The latest user message and any in-progress tool pair are never touched.** But when a *single run* is itself too big — one request, many large tool reads — its **older** tool results are shortened in place: every call/result pair stays (the protocol holds), and bulky old output becomes a short note the model can re-read from disk. Only when even that can't help does it warn and carry on. "Never drop; old tool output may be shortened."

With three 1000-byte results in one run, `shortenOldToolResults` clears the first two and keeps the last one whole, because the model just asked for it:

```
tool_result c1: [cleared: 1000 bytes of earlier tool output — read the file again if you still need it]
tool_result c2: [cleared: 1000 bytes of earlier tool output — read the file again if you still need it]
tool_result c3: CCCCCCCCCC… (all 1000 bytes)
```

It returns how many it shortened (2), and a second call returns 0, because a cleared result is already short. The app prints `Shortened 1 earlier tool result to fit the window — read the file(s) again if needed` each time it does this. The run's messages are what gets saved, so the session file keeps the short notes too.

**One subtle trap:** after compaction, the `usage` numbers on kept messages measured the *old, longer* prompt. Trusting them would trigger compaction again on every call. `getMessages()` drops usage that was measured before the latest compaction.

The course test shows it in numbers. Before compaction, the last reply's usage says 7500 prompt tokens plus 10 for the reply, and Day 24's calibration reports `measured: 7510`. That reply survives the compaction, but its 7500 described a prompt that no longer exists. Read as-is, 7510 is over 80% of an 8192 window (6553), so the next call would compact again, and so would every call after it. With the stale usage dropped, calibration falls back to an estimate of the new, short history: `measured: 0`, `tokens: 40`. The entry in the file keeps its usage. Only the copy that `getMessages()` returns leaves it out.

## Build

### 25.1 On paper — Core

In `notes/day-25.md`, draw a path where the naive cut lands inside a tool pair. Show the forward move and the `… → C → kept … → leaf` result. Then write down the 32 KiB-vs-8k-window problem in one sentence.

Concept 2's ten-entry diagram is the model to follow. Try one where the pair has two results, and one where the latest user message stops rule 1.

### 25.2 `src/context/compaction.js` — Core

`planCompaction(path, { keepMessages = 6 })` → `{ boundary, summarized, kept } | null`; `compactionText(summarized, maxBytes)` (shortens tool results, cuts head+tail); and `shortenOldToolResults(messages, { keepLast = 1 })`, which the loop hook uses to shrink a single over-sized run in place. All pure functions: no I/O, so their tests need no files.

Some hints:
- **`planCompaction` takes path entries**, `{ type, id, parentId, message }`, not bare messages. A `tool_result` is an entry whose `message.role` is `'tool_result'`.
- **`compactionText` meets earlier compactions too.** On a second compaction the first `C` is among the summarized entries. Write it as `[earlier summary]` followed by its content (the multi-level test looks for that).
- **The cut is Day 11's `truncateText` with `keep: 'head+tail'`.**
- **`shortenOldToolResults` returns the number it shortened**, which the tests check.

### 25.3 `SessionManager`: `compact`, `branch`, `getChildren` — Core

`compact({ keepMessages, maxBytes })` → `{ dropped, kept, entry } | null` (concept 3); `branch(entryId)` writes a leaf marker; `#ingest` handles `leaf` lines; `getMessages()` drops stale usage (concept 5); `save()` writes a leaf marker if the leaf isn't the last entry.

Some hints:
- **`compact` in order:** plan on `getPath()`, build `C`, insert it into `#entries` right before `kept[0]`, set `kept[0].parentId`, then `save()`.
- **"Measured before the latest compaction"** compares each entry's `timestamp` with the newest `C` on the path. ISO timestamps compare correctly as strings: `'2026-10-04T09:59:59.999Z' < '2026-10-04T10:00:00.000Z'` is `true`.
- **Return copies from `getMessages()`.** Remove `usage` from a copy (`const { usage, ...rest } = e.message`), never from the stored entry.

### 25.4 The loop hook, the app wiring, `/compact` — Core

Day 24's `beforeModelCall` hook may now **return a replacement history**, which the loop uses for that call. `createApp` takes `compaction: { enabled = true, keepMessages = 6 }` and `contextLimitCap` (Day 24's settings cap). In `createApp`:
- cache `getModelInfo()` per model;
- `compactNow()` emits `compaction { dropped, kept }` and prints `Compacted N messages`;
- the hook is the 80% check: compact older history, and if the prompt is *still* over (this run is the weight) `shortenOldToolResults(newMessages)`;
- `/compact` forces it.

Per model call, the hook runs this sequence:

```
over 80%?  no  → return undefined                       (the loop keeps its history)
           yes → compactNow(); history = session.getMessages()
still over?    → shortenOldToolResults(newMessages)     (or warn once if nothing could shrink)
return the new history, if compaction happened
```

Give `session.compact` a cap of `limit × 4 × 0.2` bytes (concept 1). `/compact` on a session that's too short answers `Nothing to compact yet.`

### 25.5 Course tests — Core

Copy `course-tests/day-25/`. It covers:
- planning, including **a boundary inside a tool pair** and **the latest user message with `keepMessages: 1`**;
- a pair right before the latest user message; an empty kept part;
- the transcript text and cap;
- the one-pointer rewrite plus reopen; **an abandoned branch unchanged**; multi-level compaction without churn;
- a large tool result shortened to a re-readable note; the transcript cut head+tail so task **and** newest line survive;
- `shortenOldToolResults` clearing older results in place, keeping every pair and the most recent result whole;
- **stale usage dropped**; the loop hook;
- **an end-to-end app run where a 4k window fills up and compaction fires mid-session**, with the latest message surviving and every tool result still having its call;
- **a single run that outgrows the window finishing anyway**, its older tool results cleared, no pair dropped.

Run `node --test tests/course/day25-*.test.js`: 15 tests green.

### 25.6 Checkpoint 3 — Core

```
Checkpoint 3 — the protocol stays valid
[ ] no compaction ever leaves a tool_result without its call (tests: pair integrity)
[ ] the latest user message survives every compaction
[ ] getPath() = … → C → kept … → leaf; getEntries() still has everything; other branches untouched
[ ] the budget uses the REAL window (min of num_ctx and model max, settings can only lower it)
[ ] live: /compact, then a question about something from before the cut
[ ] node --test green (all course tests Days 3–25)
```

Commit `day-25: compaction — checkpoint 3`. If anything is red, that's what [Buffer 2](buffer-2.md) is for.

For the live check, do *By tonight*: a fact in the first message, a few more turns, `/compact`, then the question. `/compact` needs more than `keepMessages` (6) messages before it has anything to fold.

### 25.7 LLM-written summaries — Stretch

Replace the truncated transcript with a model-written summary: a second `chat()` with **no tools**, the same signal, and a prompt like "Summarise this conversation for yourself: the task, decisions made, files touched, open questions." Guard against recursion (the summary call must **not** trigger compaction itself), and on any failure fall back to the transcript. Then compare the two on the BLUEBIRD test with ten turns of filler.

## Check

- [ ] Checkpoint 3 list fully ticked
- [ ] Commit `day-25: … checkpoint 3`

Solution: [`solutions/checkpoint-3/`](solutions/checkpoint-3/), the complete end-of-Day-25 project (281 course tests).

## Stuck?

<details><summary>Compaction runs on every turn</summary>

You're trusting stale usage. After compaction, the kept messages' `usage` described the old, longer prompt, so drop it in `getMessages()` (concept 5). Also check rule 3: folding a lone compaction entry is a no-op.
</details>

<details><summary>After compaction, the next append lands on the wrong branch</summary>

`C` was appended at the end of the file, so "last entry = leaf" picked `C`. Insert `C` before `kept[0]` in `#entries`.
</details>

<details><summary>It compacted but the prompt is still too big</summary>

Your compaction text is too large for the window. Cap it at about 20% of the window, not 32 KiB.
</details>

<details><summary>The request after a compaction is rejected, or a test finds a result without its call</summary>

The cut landed inside a tool pair. Check rule 2 against `path[b]`, the first entry you *keep*, and make sure it runs after rule 1. A call with two results needs a loop: keep moving forward while `path[b]` is a `tool_result`.
</details>

<details><summary><code>/compact</code> says <code>Nothing to compact yet.</code></summary>

The active path isn't longer than `keepMessages` (6 by default), or the only thing to fold is an earlier compaction entry. Have a longer conversation, or create the app with `compaction: { keepMessages: 2 }` while you test.
</details>

## Common mistakes

- Compacting `getEntries()`, which folds abandoned branches into the active conversation.
- Splitting a tool pair "just this once".
- Giving up when one big run can't be compacted, instead of shortening its older tool results.
- Keeping only the head of the summary, so the newest facts fall off.
- Appending `C` at the end of the file, where it becomes the leaf.
- Copying the kept entries under new ids instead of rewriting one `parentId`.
- Deleting `usage` from the stored entries instead of from the copies `getMessages()` returns.

## Self-check

1. Why does splitting a tool pair break the protocol, and what does the provider actually see?
2. After compaction, what do `getPath()` and `getEntries()` each return?
3. Why rewrite one parent pointer instead of copying the kept entries?
4. Why must usage measured before a compaction be ignored afterwards?

Answers: [self-check-answers.md](self-check-answers.md#day-25).

## Further reading

- Anthropic, [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) (the compaction and note-taking sections)
- Anthropic, [Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing): tool result clearing in a hosted API, the same idea as `shortenOldToolResults`
- Anthropic, [Compaction](https://platform.claude.com/docs/en/build-with-claude/compaction): compaction as a hosted API feature, with thresholds and kept recent turns
- Pi's compaction: search `packages/coding-agent/src` in the vendored reference for "compact"

---
← [Day 24](day-24.md) · [Curriculum home](README.md) · Next: [Buffer 2](buffer-2.md), then [Day 26 — The CLI and secure settings](day-26.md) →
