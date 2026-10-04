# Day 30 — Ship It: Demo, Docs, Capstone, Graduation

**Phase:** Week 5 — Product & proof

## By tonight

```
$ node examples/demo.js            # Wi-Fi off — it doesn't matter
you> What does notes.txt say?
  ⚙ read {"path":"notes.txt"}
agent> The notes say: Release: October · Owner: Grace
you> Add a status line saying we are on track.
  ⚙ edit {…}
agent> Added "Status: on track" under the owner.
--- saved 8 entries; reopening…
$ git log --oneline | wc -l
32
```

A harness someone else can install, read, extend and trust, plus one feature that's *yours*.

## Why it matters

Shipping is making every contract visible:
- a demo that runs anywhere;
- docs that match the code (docs that don't match the code are fiction);
- an extension that proves the extension API;
- an eval table that can fail.

Then you graduate, by building something the course didn't hand you.

## Concepts

### 1. An offline demo is a library proof

**The demo is the first thing a stranger runs, so it must work on their machine as it is.** No Ollama, no model download, no settings. `examples/demo.js` uses only `src/index.js` (`AgentLoop`, `ScriptedProvider`, `SessionManager`, `createBuiltinTools`, `EventBus`) with a scripted model: two turns, a read, an edit, a save, then a reopen that prints the resumed history. It's the first thing a stranger runs, and it proves your core doesn't secretly depend on Ollama or the terminal UI.

The reference demo also imports `ToolRegistry`, and builds everything by hand in about forty lines:
1. it makes a temp workspace with a `notes.txt`;
2. it registers the built-in tools with that folder as the jail's root;
3. it prints tool calls and results from bus events, as Day 14's printer does;
4. it runs the loop twice and saves each run with `session.appendMessages`;
5. it reopens the session file and prints what came back.

Its output, shortened:

```
you> What does notes.txt say?
  ⚙ read {"path":"notes.txt"}
  · ✓ Release: October
agent> The notes say: Release: October · Owner: Grace ·
…
--- saved 8 entries to 2026-10-04T03-21-16-208Z_36cbf2e8.jsonl; reopening…
  user        What does notes.txt say?
  assistant   [calls read]
  tool_result Release: October
  …
```

**Three details make it convincing:**
- **The model's answer comes from the file.** The scripted model's second reply is a function of the messages it receives (Day 13), so `The notes say: …` quotes what `read` really returned.
- **`autoApprove: true` is written out and commented.** It's safe *here*: a throwaway temp folder and a scripted model. That's a choice a reader can see, not a default.
- **The reopen is a separate `SessionManager.open`.** Eight entries come back from disk, which proves that sessions persist, not only that the loop ran.

A demo that needs `createApp` and a terminal proves less. It shows that your *application* works, not that the pieces are a library someone else can build on.

### 2. Four documents

**Each document has one reader:**

| File | Contents |
|---|---|
| `README.md` | install, usage (interactive, `-p`, modes, input conventions), commands, settings table (and what a *project* file may set), extending, dependencies table |
| `docs/architecture.md` | component diagram from the **real** code, key decisions with reasons, the **eval table from real runs**, the Pi mapping |
| `docs/extending.md` | the extension API, the trust model, the canonical event table, skills, MCP |
| `docs/api.md` | one line per export of `src/index.js` |

- The README is for someone deciding whether to install it.
- `architecture.md` is for whoever maintains it next, including you in six months.
- `extending.md` is for extension authors.
- `api.md` is for programmers who import the library.

**A decision needs its reason.** One row from the reference's key decisions:

| Decision | Why |
|---|---|
| `num_ctx` on every request; budget against `min(num_ctx, model max)` | Ollama's 4k default silently drops the prompt's start |

Without the "why", the next person sees one extra field in every request and deletes it.

**Docs drift unless something checks them.** The course test checks that every `src/index.js` export is documented and every canonical event is listed. Wherever you can, *generate* rather than hand-copy (for example, `Object.keys(await import('./src/index.js'))`). The same idea makes a short check you can run at any time (*run this in a file*, from the project folder):

```js
import fs from 'node:fs';

const api = fs.readFileSync('docs/api.md', 'utf8');
for (const name of Object.keys(await import('./src/index.js'))) {
  if (!api.includes(name)) console.log('undocumented:', name);
}
```

On the reference it prints nothing. With the `McpClient` row deleted from `docs/api.md`, it prints `undocumented: McpClient`. The test also refuses event rows named after other systems' events, such as Pi's `message_update`. An extension author who subscribed to one would wait forever.

### 3. The Pi comparison, honestly

Fill the mapping table (*your module* · *Pi package* · *divergence and why*), then **three things to steal** from Pi and **three you kept simpler**. Re-read Mario Zechner's post. Pi has no MCP, no sub-agents and no plan mode, and its system prompt and tool definitions together stay under 1,000 tokens. Where did you agree, and where didn't you? Why?

The post lists more choices, and some go the other way from yours. Pi runs in "YOLO mode" by default, with no approval questions. Your harness fails closed (Days 12 and 20). Neither is wrong. They're for different users, and the honest comparison says which user you built for.

A row of the mapping table, from the reference:

| Our module | Pi | Divergence and why |
|---|---|---|
| `src/mcp/` | none (Pi deliberately ships no MCP) | MCP is now the standard tool bus; we chose to support it |

### 4. Capstone: choose one (or propose your own)

**The capstone is the first feature nobody specified for you.** Each option takes a gap the course named and closes it:

| Capstone | You'll learn | Starting point |
|---|---|---|
| **OS sandbox for `bash`** | real containment: no network, writes only in the workspace | macOS `sandbox-exec` profile or Linux `bwrap`; Day 11 / Day 20 stretches |
| **A hosted provider** | content blocks, prompt caching, a third dialect | Anthropic Messages or OpenAI Responses API, behind your `Provider` interface |
| **Sub-agents** | context isolation | a `task` tool that runs a fresh `AgentLoop` with its own history and returns a summary |
| **LLM compaction** | summarization with recursion guards | Day 25 stretch, plus a BLUEBIRD-style eval |
| **Your own MCP server** | the other side of the protocol | expose `read`/`grep` over stdio, modern and legacy; connect your harness *and* another one |
| **A TUI** | raw mode, differential rendering, restoring the terminal on every exit path | study `@earendil-works/pi-tui` |

Write the plan in `notes/capstone.md` first: the goal, how you'll know it works (**an eval or a test**), and what you'll leave out.

**"How you'll know" comes first** for the same reason as Day 29's checkers: it decides what "done" means before you're tempted to call it done. For the sandbox, a good test already exists in spirit. Day 27's canary, read through `bash` with `cat`, must fail inside your sandbox and succeed outside it. "What you'll leave out" keeps the capstone finishable.

## Build

### 30.1 Offline demo — Core

Write `examples/demo.js` (concept 1). Run it with Ollama stopped.

Import everything from `../src/index.js`. If the demo needs anything that isn't exported there, either export it (and document it in `docs/api.md`) or do without. To be sure the demo is offline, quit Ollama first, rather than trusting that nothing calls it.

### 30.2 The `git-status` extension — Core

`examples/extensions/git-status.js` (if you skipped it on Day 22):
- `git_status` is `readOnly`;
- `git_commit` has `needsApproval: true` and uses `execFile('git', ['commit', '-m', message])`, an **argument array**, so a message like `"; rm -rf / #` is only text;
- `/git-status` is a command.

Load it with `--extension`. Deny one commit, then approve one.

An argument array means no shell parses the message (Day 11). In a test repository with one staged file, `git_commit` with that message makes a commit whose subject is, literally, `"; rm -rf / #`. With nothing staged, it returns `git commit failed: …` with `isError: true`, because git refuses an empty commit. The tool commits staged changes only, as its description tells the model.

### 30.3 The four docs — Core

Concept 2. Paste in your real eval tables (Day 29) and your red-team summary (Day 27). Under "Known gaps", state honestly: no OS sandbox for `bash`, approval fatigue, the TOCTOU window in the jail, in-process extensions, and estimated tokens.

Each gap deserves a sentence on what it means in practice. From the reference:

```
- **The jail's check-then-use window (TOCTOU).** A file swapped for a symlink between the check and
  the open can escape.
```

Day 10 named that window, and Day 27's report has the rest. A gap stated plainly is a reason to trust the other claims in the document.

### 30.4 Course tests and history review — Core

Copy `course-tests/day-30/` (3 tests: demo offline, the extension, docs vs code), then run `node --test`: **every course test from Day 3 to Day 30 should be green.** Then `git log --oneline`: about 32 commits. Write one line about each gap in your history (*"day 16 took two days: the stream assembler"*). That's your learning log.

`git log --oneline --reverse` lists the commits oldest first, which reads like the course. A gap is a day with no commit, or two days in one.

### 30.5 Graduation checklist — Core

- [ ] **Checkpoint 1** — headless loop, fail-closed approval, abort kills `sleep 30`
- [ ] **Checkpoint 2** — interactive streaming, Ctrl+C, the prompt always returns
- [ ] **Checkpoint 3** — compaction keeps the protocol valid
- [ ] All course tests green; scripted evals at 100%; a live eval table with dates
- [ ] Red-team report; threat model v3
- [ ] README, architecture, extending and api docs, plus the offline demo
- [ ] I can explain: why `num_ctx` matters · the tool-pair invariant · why `-p` fails closed · why project settings are an allow-list · why AGENTS.md can't grant permissions · pass@k vs pass^k · what the jail does *not* stop

Commit `day-30: ship`.

### 30.6 Capstone — Stretch, and the point

Build your capstone, with its test or eval first. Then write a short post: what you built, one thing that surprised you, and your eval table. Share it, or contribute what you learned to Pi.

## Check

- [ ] `node --test tests/course/day30-*` green (3 tests), and `node --test` green: Days 3–30, plus your own tests
- [ ] Graduation checklist ticked
- [ ] `notes/capstone.md` written

Solution: [`solutions/final/`](solutions/final/), the complete project (329 course tests, the offline demo, the evals, the docs and the extensions).

## Stuck?

<details><summary>The demo needs the network</summary>

Something imports `OllamaProvider` at module level and calls it, or `createApp` was used instead of the library classes. Build the loop by hand with `ScriptedProvider`, as concept 1 does.
</details>

<details><summary>The docs test says an export is undocumented</summary>

Add a row to `docs/api.md`, or remove the export if nobody should depend on it.
</details>

<details><summary><code>git_commit</code> always fails</summary>

It commits staged changes only, and git refuses a commit with nothing staged. Stage the files first (`git add`), with an approved `bash` call or by hand.
</details>

<details><summary>The demo's reopen prints no messages</summary>

The runs weren't saved before the reopen. `await session.appendMessages(result.newMessages)` after each run, so the file is written before `SessionManager.open` reads it.
</details>

## Common mistakes

- An architecture doc describing the Day 6 plan instead of the code you actually wrote.
- An eval table with numbers you didn't measure.
- A capstone with no way to tell whether it works.
- An export list in `docs/api.md` copied by hand and never checked again.
- A "Known gaps" section that's missing, or too vague to act on.
- A demo that only runs on your machine, because it reads your settings or your Ollama.

## Self-check

1. Why must the demo run offline, and what does that prove about your architecture?
2. Why does `git_commit` go through the approval gate instead of its own confirm?
3. What three things did you steal from Pi, and what did you deliberately keep simpler?
4. Which known gap in your harness worries you most, and what would close it?

Answers: [self-check-answers.md](self-check-answers.md#day-30).

## Further reading

- Mario Zechner, [What I learned building an opinionated and minimal coding agent](https://mariozechner.at/posts/2025-11-30-pi-coding-agent) (re-read it now)
- Anthropic, [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- The README's [After the Curriculum](README.md#after-the-curriculum) list
- [Make a README](https://www.makeareadme.com/): what a README's readers look for, section by section
- [bubblewrap](https://github.com/containers/bubblewrap): the Linux sandbox behind the first capstone's `bwrap`

---
← [Day 29](day-29.md) · [Curriculum home](README.md)
