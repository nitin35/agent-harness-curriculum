# Reference solutions

A complete, tested implementation of the course, snapshotted at each checkpoint. Every snapshot is a self-contained `agent-harness` project. `cd` into one and run `node --test`:

| Folder | State | Course tests |
|---|---|---|
| [`toy/`](toy/) | The toy agent: `agent.mjs` (Day 1, single file, runnable anywhere) and the Days 2–5 modules | (in each snapshot) |
| [`checkpoint-1/`](checkpoint-1/) | End of Day 13: provider, tools, loop, abort, scripted provider | 131 |
| [`checkpoint-2/`](checkpoint-2/) | End of Day 16: plus events, interactive UI, streaming | 169 |
| [`checkpoint-3/`](checkpoint-3/) | End of Day 25: plus sessions, commands, permissions, second provider, extensions, MCP, context, compaction | 281 |
| [`final/`](final/) | End of Day 30: plus CLI, secure settings, red-team defenses, `@file`, evals, demo, docs | 329 |

Notes:
- `toy/`'s Days 2–5 modules import `../src/shared/ndjson.js`, `../src/tools/truncate.js`, `../src/cli/args-parser.js` and `../src/shared/errors.js`, just as the course has you build them. The toy's course tests (Days 3–4) run inside every snapshot. In the snapshots, `toy/main.mjs` also includes Day 11.6: it runs commands through the real `bash` tool. The copy in `solutions/toy/` stays at the end of week 1. **Run them from inside a snapshot** (`cd final && node toy/main.mjs`). The copy in `toy/` is for reading side by side with week 1.
- Live parts need Ollama with the course model (`ollama pull qwen3.5:4b`): `node scripts/smoke-provider.js`, `node scripts/tool-description-experiment.js` (Day 9, about 5 minutes), `node scripts/interrupt-experiment.js` (Day 15, about 2 minutes), `node src/cli/main.js`, `node examples/evals/run.js --live`. Everything else, including every course test, runs offline.
- Each snapshot's `tests/course/` holds the course tests up to that day. Run them with `node --test tests/course/*.test.js` (Node 22+ doesn't accept a bare directory).
- Your own tests go directly in `tests/`. Each snapshot includes Day 6's event-protocol checker (`tests/helpers/event-protocol.js`, `tests/event-protocol.test.js`), and from checkpoint 2 on, Day 14's real-trace test (`tests/event-protocol-loop.test.js`).
- Point `AGENT_HARNESS_HOME` at a temporary folder to try a snapshot without touching your real `~/.config/agent-harness`.

**Spoiler policy:** try the day's **Stuck?** hints first. Then read *one file* here, close it, and write yours. Copying a whole checkpoint to get unblocked is allowed. Say so in your commit message and keep going.

Built and verified 2026-10-01 on Node 26.3 and Ollama 0.32.0 with `qwen3.5:4b`. The course requires Node 22+; Node 24 LTS is recommended.
