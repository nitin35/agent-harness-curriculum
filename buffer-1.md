# Buffer Day 1 — Catch Up, Repair, or Level Up

**When:** after Day 13 (Checkpoint 1)

Two weeks in, most learners are behind somewhere, and that's normal. This day exists so that being behind doesn't snowball into Week 3, which assumes a working engine.

Start by finding out where you stand. Run `node --test` with Ollama stopped (the first item of Checkpoint 1, in Day 13.6). Then pick your section: if anything is red, section 1; if everything is green, section 2; if you've already done what section 2 suggests, section 3.

## 1. Are you behind? Repair first

Work down this list and stop at the first red item. The order matters: later days build on earlier ones, so a failing test from Day 4 can make Day 12's tests fail for reasons that have nothing to do with the loop.

| Symptom | Go back to | Quick check |
|---|---|---|
| Course tests for Days 3–5 red | Day 3 / 4 / 5 | `node --test tests/course/day0[345]-*` |
| Provider tests red, or the smoke fails | Day 8 | `node scripts/smoke-provider.js` |
| Jail or tool tests red | Days 10–11 | `node --test tests/course/day1[01]-*` |
| Loop tests red | Day 12 | `node --test tests/course/day12-*` |
| Abort tests slow or red | Day 13 | `node --test tests/course/day13-*` |

The square brackets in those patterns are a shell feature: `[345]` matches one character that is `3`, `4` or `5`, so `day0[345]-*` picks up the test files for Days 3, 4 and 5, and `day1[01]-*` the ones for Days 10 and 11. The smoke check needs Ollama running; the others don't.

**How to repair one red test.** Run only that day's tests. Read the *first* failure, not the last: the `+ actual` and `- expected` lines (Day 5) say what your code returned and what the test wanted. Then open that day's **Stuck?** section, where the common causes of each failure are written down. Most red tests on this list are one of a handful of mistakes: a missing `await`, a signal that isn't passed on, or a result that was thrown instead of returned.

**If a day is still red after a real attempt, it's OK to look at the solution.** A real attempt means you've read the first failure, checked the day's Stuck? section, and tried a fix. Then read *one file* from [`solutions/checkpoint-1/`](solutions/checkpoint-1/), close it, and write yours. If you're truly stuck, copying `solutions/checkpoint-1/src` wholesale is allowed: say so in your commit message (`buffer-1: adopted reference loop`) and keep going. Finishing beats stalling.

## 2. On track? Consolidate (pick one or two)

**Read your own code aloud.** Open `agent-loop.js` and explain each line in `notes/buffer-1.md` as if teaching it. Anything you can't explain is worth a test. Explaining a line means saying *why* it's there, not what it does. For example: "this check sits before the tool runs, so a call after an abort gets `Skipped: run aborted` instead of starting". The places most worth explaining are the abort paths, where each tool result is appended, and the fail-closed approval branch.

**Do skipped Stretch items.** The most valuable ones are 8.5 (retry with backoff), 11.9 (a sandboxed bash) and 13.7 (composed signals). Each teaches something the core days only mention:
- 8.5: when retrying helps, and how to measure whether it does;
- 11.9: what real containment looks like, which the jail and approval can't give you;
- 13.7: telling a timeout from a user abort, which matters once a UI has to say *why* a run stopped.

**Type-check everything.** Install the compiler with Node's types (without them, `tsc` reports dozens of errors that aren't bugs), then run the same command as Day 5.7:

```bash
npm i -D typescript @types/node
npx tsc --allowJs --checkJs --noEmit --strict false --target es2022 --module nodenext \
  $(find src toy -name '*.js' -o -name '*.mjs')
```

`--strict false` matters because TypeScript 7 is strict by default. Fix what it finds. The checkpoint-1 reference passes it with 0 errors. The flags say: check JavaScript files (`--allowJs --checkJs`), don't write any output (`--noEmit`), and understand modern syntax and ES modules (`--target`, `--module`). Day 5.7 lists the kinds of error to expect.

## 3. Ahead? Challenges

1. **A `grep` tool.** Add `src/tools/builtin/grep.js`: `{ pattern, path?, glob? }`, read-only, jailed, truncated, skipping `node_modules`/`.git`. Write its description for the model (Day 9), then compare how often the model uses `grep` versus `bash grep`.

   It reuses everything you have: `resolveInWorkspace` for the path (Day 10), `decodeText` to skip binary files, and `truncateText` for the output. Count the model's choices over ten runs each, as in Day 9's experiment, rather than trusting one.
2. **Trajectory printer.** A script that runs `smoke-loop.js` and writes each run's messages to `notes/trajectories/<timestamp>.json`. You'll appreciate it on Day 29.

   The run's `result.newMessages` is the trajectory, and `JSON.stringify(messages, null, 2)` makes it readable. For the file name, `new Date().toISOString().replace(/[:.]/g, '-')` gives `2026-10-03T14-05-09-123Z`. Colons in file names cause trouble on some file systems, Windows drives under WSL among them.
3. **Toy vs real.** Ask the toy and your real loop the same five questions. Where do they behave differently, and why? (Hints: tool descriptions, `num_ctx`, approval, error messages.)
4. **Read ahead.** Skim Pi's `packages/tui` and think about what *you* want the interactive harness to feel like on Day 15.

## Done when

- [ ] Checkpoint 1 is fully green
- [ ] `notes/buffer-1.md` says what you repaired, consolidated or built
- [ ] Commit `buffer-1: …`

---
← [Day 13](day-13.md) · [Curriculum home](README.md) · Next: [Day 14 — Events and the printer](day-14.md) →
