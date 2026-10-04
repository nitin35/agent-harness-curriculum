# Buffer Day 2 — Catch Up, Repair, or Level Up

**When:** after Day 25 (Checkpoint 3)

Week 4 was the densest: permissions, a second provider, extensions, MCP, context and compaction. Week 5 turns all of it into a product and then attacks it, so it needs everything to be solid.

Start by finding out where you stand. Run `node --test`, the last item of Checkpoint 3 (Day 25.6). Every course test from Days 3–25 runs offline, against scripted models and fake servers, so Ollama doesn't need to be running. In the reference, every one of them passes. Then pick your section: if anything is red, section 1; if everything is green, section 2; if you've already done what section 2 suggests, section 3.

## 1. Repair first

Work down this list and stop at the first red item. The order follows the days, and later days lean on earlier ones: a bridge that loses messages (Days 15–16) can make the resume and approval tests fail too.

| Symptom | Go back to | Quick check |
|---|---|---|
| Streaming or the prompt misbehaves | Days 15–16 | `node --test tests/course/day1[56]-*` |
| Resume loses history | Day 19 | the "blue" continuity check |
| Approvals hang, or "always" doesn't stick | Day 20 | `node --test tests/course/day20-*` |
| A tool appears twice, or not at all | Days 9, 22, 23 | `/mcp`, `/help`, then print `registry.getTools()` |
| `/context` numbers look wrong | Day 24 | is history counted twice? |
| Compaction loops or corrupts | Day 25 | `node --test tests/course/day25-*` |

Some of the quick checks need a word of explanation:
- **`day1[56]-*`**: the square brackets match one character, `5` or `6`, so the pattern picks up the test files for Days 15 and 16.
- **The "blue" continuity check** comes in two forms. `node --test tests/course/day19-*` runs it offline, with a scripted model that answers `blue` only if the old message reaches it. Day 19.4 runs it live: tell the model your favourite colour, quit, restart, resume, and ask.
- **A tool twice, or not at all.** Your registry refuses a second tool with the same name (`a tool named 'x' is already registered`), so "twice" usually means one job under two names, such as your `read` and an MCP server's `mcp__fs__read_file`. Log `registry.getTools().map((t) => t.name)` once after startup. Each name comes from one place: the built-ins (Days 10–11), an extension (Day 22), `load_skill` (Day 24) or an MCP server (Day 23). A missing name points at the place that should have registered it.
- **History counted twice** is Day 24.4's warning: a measured `promptTokens` already includes the system prompt and the tool schemas, so history is `total − system − tools`.

**How to repair one red test.** Run only that day's tests and read the *first* failure: the `+ actual` and `- expected` lines (Day 5) say what your code returned and what the test wanted. Then open that day's **Stuck?** section. For this week, the usual causes are there:
- the model forgets after a resume: `getHistory` reads an old session object (Day 19);
- an approval never resolves: one exit path doesn't settle the promise (Day 20);
- compaction runs on every turn: usage from before the compaction is trusted (Day 25).

**If a day is still red after a real attempt, look at the solution.** A real attempt means you've read the first failure, checked the day's Stuck? section, and tried a fix. Then read the matching file in [`solutions/checkpoint-3/`](solutions/checkpoint-3/), close it, and write yours. Adopting a whole module is allowed if you say so in the commit message.

## 2. On track? Consolidate

**Draw your architecture as it actually is.** Update `docs/architecture.md` from your code (not from Day 6's plan): modules, events, the approval flow, the session tree, compaction. Mark everywhere the code disagrees with the plan.

Work from the code, not from memory. The folders under `src/` are the modules: the reference has `agent`, `cli`, `commands`, `config`, `context`, `events`, `extensions`, `mcp`, `provider`, `session`, `shared`, `tools` and `ui`. The events are the values of `EVENTS` in `src/shared/events.js`. This prints them:

```bash
node -e "import('./src/shared/events.js').then((m) => console.log(Object.values(m.EVENTS).join(' ')))"
```

Day 6's diagram has seven boxes: the UI, the bus, the bridge, the loop, the provider, the tools and the session. Everything since has to go somewhere: the command registry (Day 18), the permission policy and the approval gate (Day 20), extensions (Day 22), MCP clients (Day 23) and the context module (Days 24–25). Each disagreement you mark is a decision you made while building, and worth one sentence on why.

**Review the threat model.** Re-read `notes/tool-security.md` (Days 11, 20, 22, 23, 24). Is anything outdated? Day 27 attacks exactly this list.

Outdated usually means "written before a later day changed it". Day 11's section was written before the permission rules and modes of Day 20. Day 22's extensions were the first code from someone else to run inside your process, and Day 23's servers the first programs the harness starts on its own, so earlier sections couldn't cover them. For each risk in the file, write down which day's defence covers it now, and whether that defence is a boundary (the jail, the gate, global-only config) or only a label.

**Catch up on Stretch items.** The best ones: 16.6 (time to first token), 20.6 (network rules), 23.6 (a real MCP server), 25.7 (LLM summaries). What each one teaches:
- 16.6: what thinking costs in time, measured from your own events;
- 20.6: why a rule that matches command text is weak, and what only an OS sandbox can do;
- 23.6: what a real server's tools cost in tokens, and what its descriptions say;
- 25.7: whether a model-written summary beats the transcript on the BLUEBIRD test.

## 3. Ahead? Challenges

1. **`/fork`**: branch the session at the *N*th message back and continue from there; `/tree` prints the session tree with `getChildren()`.

   Day 25's `branch(entryId)` does the work: `/fork 2` branches at `getPath().at(-2)`. Make it an `idle` command (Day 18), like `/new`, because it moves the leaf under any running conversation. For `/tree`, start at the entries whose `parentId` is `null` and recurse through `getChildren()`, indenting one step per level. A compaction entry shows up in the tree too, so give it a label of its own.
2. **A `todo` tool**: the model keeps a checklist for multi-step tasks (`todo_write { items: [{ text, done }] }`), and the UI shows it after each turn. Many harnesses ship this. Does it help your small model finish longer tasks?

   It's an ordinary tool definition (Day 9) whose `execute` replaces a list kept in `createApp`. To show the list after each turn, listen for `turn_end` and print with `ui.printSystem`. Decide whether the tool should be `readOnly`: it changes no files, and Day 20's `read-only` mode denies every tool that isn't marked `readOnly`.
3. **Your own MCP server**: expose your harness's `read` tool over MCP (stdio, modern + legacy), then connect your *own* harness to it.

   Start from a copy of `course-assets/mcp/notes-server.mjs`: its framing and both eras already work. Replace its tools with one `read`, whose `inputSchema` is your read tool's `parameters` and whose call runs that tool's `execute` (from `createBuiltinTools({ root })`, Day 11). Log only to stderr (Day 23's rule 2). Connected through `mcp.json`, the tool appears as `mcp__<name>__read`, with its approval prompt.
4. **Thinking budget**: a `/think off|low|high` command that maps onto the provider's `think` option. Measure speed against quality on five questions.

   `OllamaProvider` reads `this.think` on every request, so the command can set it, the way `/model` calls `setModel` (Day 18). It takes `true`, `false`, or `'low'`, `'medium'` or `'high'` for models that accept levels (Day 7's table). A model that can't think gets `think` dropped after its first refusal (Day 8). Stretch 16.6's timing is a good way to measure the speed side.

## Done when

- [ ] Checkpoints 1–3 all green
- [ ] `docs/architecture.md` reflects the real code
- [ ] Commit `buffer-2: …`

---
← [Day 25](day-25.md) · [Curriculum home](README.md) · Next: [Day 26 — The CLI and secure settings](day-26.md) →
