# Self-Check Answers

Answer keys for the [30-day curriculum](README.md). **Answer each day's questions yourself first.** Writing even a wrong answer before you read these is where the learning happens.

## Day 1

1. **How is an agent harness different from a chatbot?** A chatbot only returns text. A harness gives the model tools, executes the tool calls the model requests in *your* process (after checking they're allowed), feeds the results back, and loops until the model answers.
2. **Where does the `ls` command actually run?** In your process. The model only emits a structured request (`bash` with `{ command: 'ls' }`); Ollama passes it to you; your code decides whether to run it and runs it.
3. **Why does the loop have a `MAX_TURNS`?** A model can keep calling tools forever: a confused retry, a loop between two tools. A turn limit turns that into a bounded, reportable outcome instead of a hang and a growing bill.
4. **What does `"type": "module"` change?** Node treats `.js` files as ES modules: `import`/`export` instead of `require`, top-level `await`, strict mode, and imports that need explicit file extensions.

## Day 2

1. **Why is `const msg = { … }` not immutability?** `const` stops you rebinding the *variable*; the object is still mutable (`msg.content = 'x'` works). Compensate by copying instead of changing (`{ ...msg, content }`), treating messages and tool data as read-only, `Object.freeze` for shallow locks, and `structuredClone` for deep copies.
2. **What does `this` depend on?** How the function is *called*: `obj.f()` sets it to `obj`, a bare `f()` leaves it `undefined` in an ES module, `new` creates it, and `.bind` fixes it. Hand the function to someone else (`setTimeout(obj.f)`) and *their* call decides: Node's `setTimeout` passes its `Timeout` object. Arrow functions have no `this` of their own and use the surrounding one, so passing them around never "loses" it.
3. **Why does `runTurns` take `confirm` and `runTool` functions?** Dependency injection. The loop doesn't care who answers or how a command runs (a terminal and a shell, or a test's fakes), so it can be tested without a keyboard, a model or a real process, and reused unchanged. Day 3's course tests rely on exactly this, and Day 12's `approve` and Day 20's gate keep the same shape.
4. **When would you choose a class over a factory?** For long-lived objects with state and several methods that you call as `obj.method()` (providers, the loop, sessions), and when `instanceof` is useful. Factories suit small closures and tools, where there's no `this` to lose.

## Day 3

1. **Why does `setTimeout(fn, 0)` run after `Promise.resolve().then(fn)`?** Promise callbacks are microtasks, and the event loop drains *all* microtasks before running the next macrotask (timers, I/O). So any `.then` queued "now" beats any timer queued "now".
2. **Why did `spawnSync` make Ctrl+C impossible to handle?** It blocks the one JavaScript thread until the child exits, so the event loop can't run readline's `SIGINT` handler, or anything else, until then.
3. **What does the caller of `fetch` see when its signal aborts?** The `fetch` promise rejects with a `DOMException` named `AbortError`. When an `AbortSignal.timeout(ms)` fires, it rejects with a `TimeoutError`. No partial response is returned, and HTTP error statuses do *not* reject (check `res.ok`). `spawn` is different: it reports both as an `AbortError`, with the signal's reason on `err.cause`, so to tell a timeout from a Ctrl+C you ask the timeout signal (`timeout.aborted`).
4. **Why must a skipped tool call still get a `tool` message?** Every tool call in an assistant message must be answered by a result before the next request. A dangling call is a protocol error (some APIs reject it with a 400) and confuses the model. A "Skipped: run aborted" result keeps the history valid.

## Day 4

1. **Why can't you `JSON.parse` each chunk of an NDJSON stream?** Chunks are arbitrary byte slices that don't line up with lines: one line can span chunks, and one chunk can hold several lines plus half of another. Buffer, split on `\n`, and parse only complete lines.
2. **Why does `String.prototype.slice` break a byte budget?** It counts UTF-16 code units, not UTF-8 bytes (`'é'` is 1 unit but 2 bytes, `'🙂'` is 2 units and 4 bytes). It can overshoot the budget and cut characters in half. Use `Buffer.byteLength`/`subarray` and back up to a character boundary.
3. **What does `{ stream: true }` on `TextDecoder.decode` do, and what did `out += chunk` do instead?** It holds back an incomplete multi-byte sequence at the end of a chunk and completes it with the next one, instead of emitting `�`. `out += chunk` converted each `Buffer` to a string on its own, which is a fresh decoder per chunk, so a character split across two chunks became two `�`. `child.stdout.setEncoding('utf8')` gives each stream one streaming decoder, which fixes it.
4. **Where do streamed tool calls appear?** In Ollama's stream, each tool call arrives whole in an *earlier* chunk, and the final `done: true` chunk does not repeat them. If you read the calls from the final chunk, you lose them, so collect them as they pass.

## Day 5

1. **Programmer error vs operational error?** Programmer errors (bugs, broken invariants such as a duplicate tool name) should throw loudly. Operational errors (server down, a missing file, bad model output) are expected. They become *results* the caller can act on (`ToolResult { isError: true }`) or categorized errors with a fix (`ProviderError` with "is Ollama running?").
2. **`fetch` is a global you could patch. Why inject it anyway?** Injection is explicit: the signature says what the module talks to. Nothing shared leaks: a patched global affects every other test in the file until someone restores it. And the same pattern works for imports, which you *can't* reassign (they are live, read-only bindings owned by the exporting module, and `mock.module()` is still experimental). So: `createOllamaClient({ fetch })`, `new OllamaProvider({ fetch })`, and fakes in tests.
3. **Why must `finally` be taught explicitly to a C++ programmer?** There's no RAII: nothing is cleaned up automatically when a scope exits. Child processes, timers, listeners and stream readers stay alive unless *you* clean them up in `finally` (or on abort).
4. **What does `-v` mean?** `--version`, never verbose (verbose is `--verbose` or `-V`). It's fixed in the README's CLI contract and pinned by the course test `day05-args-parser.test.js`.

## Day 6

1. **Two `AgentEvent` types Pi emits that we don't?** `message_update` (and `message_start`/`message_end`) and `tool_execution_update`. Around a tool call we emit `tool_call_start`, then `tool_call_end`, then `tool_result` (a separate record for the UI and history), plus `tool_approval_request`/`_result` when approval is needed.
2. **Pi awaits its listeners; our bus doesn't. What does each buy and cost?** Pi's `Agent.subscribe()` awaits every listener in order, so it gets ordering for free (a session write finishes before the next turn starts, and the run isn't over until listeners settle), but one slow or stuck listener stalls the whole agent. Our `emit` is synchronous and fire-and-forget, so no listener can stall or deadlock the loop, and many subscribers (UI, sessions, logs, extensions) attach by name. The cost: a listener can't rely on finishing before the next event, and anything that needs an *answer*, like approval, must be built as request/response on top of the bus (Day 20).
3. **Where does a `needsApproval` tool pause?** In `RunningTool`: `tool_approval_request` moves the protocol to `AwaitingApproval`, and the `tool_approval_result` for the same id moves it back. Approve runs the tool; a denial, a timeout or an abort produces an error result. Either way `tool_call_end` and `tool_result` follow, and the loop continues.
4. **Why can a `tool_result` appear without a `tool_call_start`?** After an abort, the loop still answers every remaining tool call with `Skipped: run aborted` (the tool-pair invariant), but it never starts those tools. So a skipped call has a result and no start or end. A protocol that forgot this would reject every real abort trace.

## Day 7

1. **Where do the text and the reasoning live?** In `message.content` and `message.thinking`. The end is marked by `done: true` with a `done_reason` (`stop`, `length`, …), alongside `prompt_eval_count` and `eval_count`.
2. **How does NDJSON parsing differ from SSE?** NDJSON is one JSON object per line, with no prefixes or event framing. SSE has `data:` lines that accumulate until a blank line dispatches an event, plus comments and named events. Both need incremental line buffering.
3. **Which fields identify the call a tool result answers?** Ollama keys results by `tool_name` (0.32 also accepts `tool_call_id`). OpenAI-compatible APIs use `tool_call_id`. Send both to Ollama to be safe.
4. **What did the silent-truncation experiment show?** Without `num_ctx`, Ollama ran with a 4096-token window, accepted an 11k-token prompt with HTTP 200, processed only about 2k tokens, and the model lost its system prompt. Your harness sends `options.num_ctx` on every request and budgets against `min(num_ctx, model maximum)`.

## Day 8

1. **Why is `{ signal }` in `chat()`'s signature from the first commit?** Cancellation has to reach the network call itself, and the toy already showed on Day 3 that Ctrl+C is needed from day one. Putting it in the interface now means abort, timeouts and the UI's Ctrl+C (Days 13, 15) work without changing every provider and caller later.
2. **Where does a string `arguments` payload become an object?** In the provider, at the boundary (`parseArguments`), exactly once. Broken JSON never throws: the call gets `arguments: {}` plus a `parseError`, and the loop turns that into a "retry with valid arguments" result for the model.
3. **Name the error kinds.**
   - `unreachable`: tell them to start Ollama (`ollama serve`).
   - `model_not_found`: `ollama pull <model>`.
   - `bad_response`: show what actually arrived (its keys).
   - `http`: the status and the body excerpt.

   Abort is not one of them; it passes through untouched.
4. **Why is `contextLimit` the minimum of two numbers?** The usable window is the smaller of what you *asked for* (`num_ctx`) and what the model *supports* (`/api/show`). Budgeting against the model maximum (262k) while Ollama runs at 8k means compaction never triggers before silent truncation.

## Day 9

1. **Why a `Map`, and why plain objects?** A `Map` has no prototype keys (a tool named `toString` or `__proto__` is safe), keeps insertion order and has a real size. The wire is JSON, though, and functions and policy flags must not leave the harness, so the provider gets plain `{ name, description, parameters }` objects.
2. **The model sends broken JSON arguments.** The harness returns `ToolResult { isError: true, content: "Invalid arguments for read: … Retry the call with corrected arguments." }`. It must never throw into the loop, never guess and run anyway, and never retry silently.
3. **What does `toProviderTools()` leave out?** `execute` (functions aren't data, and `JSON.stringify` silently omits them) and harness policy (`needsApproval`, `readOnly`, `label`). The model has no say in policy.
4. **When did the description matter most, and why might thinking narrow the gap?** It matters most when the model acts without reasoning first: with thinking off, we measured the clear description calling the tool 9/10 times on a project question, and the vague one 1/10. With thinking on, it was 10/10 against 8/10: the model reasons its way from "this project" and "Looks things up" to the tool. Thinking costs time on every turn, so a clear description is the cheap fix. Neither description made the model call the tool for general knowledge. A good description says what the tool does and returns, when to use it (and when not), its limits, and what each parameter means.

## Day 10

1. **Why is `startsWith` the wrong jail check?** `/work/app-evil` starts with `/work/app`. Use `path.relative(root, resolved)`: the path is outside if the result is `..`, starts with `../` (a `..` *segment*), or is absolute. Don't test for a `..` *prefix*: that would also refuse a legitimate name like `..data`.
2. **A symlink inside the workspace points to `/etc`.** The physical check: compare the `realpath` of the target (or of its nearest existing ancestor) with the `realpath` of the root. **A link to a file that doesn't exist yet** makes `realpath` fail as if nothing were there, but writing to it would create the target. So when `realpath` fails, `lstat` the path: if it's a symlink, follow it by hand and keep checking from where it points.
3. **What can the jail never stop?** A race between check and use (TOCTOU: swapping in a symlink between the two system calls), and anything `bash` does (the jail only sets bash's working directory; `cat ../secret` inside the command isn't checked).
4. **Which `read` failures are results?** All the expected ones: missing file, permission denied, a directory, binary content, too large, outside the workspace. They're results because the model can adapt to them (try another path, use `head`); an exception would kill the run.

## Day 11

1. **Two reasons `spawn` beats `exec`?** Any two of: `spawn` streams output instead of buffering everything in memory; it gives you the `pid` for killing the process group; it accepts an argument array, so boundaries stay explicit; and you control the shell explicitly instead of `shell: true` with interpolated strings.
2. **What kills `sleep` on abort?** The tool spawned `sh` with `detached: true`, so it leads its own process group. The abort listener calls `process.kill(-pid, 'SIGTERM')`, signalling the *whole group*, `sh` and `sleep` included, and escalates to `SIGKILL` after a grace period. It must do this even if `sh` itself has already exited: the group lives on as long as `sleep` does.
3. **What happens to `npm run dev &`?** The shell exits at once, but the server lives on in the command's process group, holding the output pipe. After a short grace, the tool kills the leftovers, and puts a note *first* in the result saying they were killed. Nothing a command starts outlives the call (or the harness), so the agent never hangs waiting on a pipe, and you never find a stray server hours later. Long-lived processes are yours to run, outside the agent.
4. **One attack the jail stops and one it doesn't?** It stops `read ../../.ssh/id_ed25519` and a symlink pointing out of the workspace. It doesn't stop `bash -c 'cat ~/.ssh/id_ed25519'` (only approval, deny rules or a sandbox do), or a check-then-use race.

## Day 12

1. **Why fetch the tool list before every call?** The set changes while the program runs (extensions on Day 22, MCP on Day 23, `load_skill` on Day 24). A list cached in the constructor would hide new tools, and "why is my tool invisible?" is a painful bug.
2. **The tool-pair invariant?** An assistant message with tool calls must be followed by exactly one result per call, in order, before the next model call. Violate it and the provider sees a call without a result (or a result without a call): hosted APIs reject the request, and models get confused.
3. **`maxTurns` runs out mid-task.** A normal `AgentResult` with what happened so far: `aborted: false`, a `warning` naming the limit, the turns and tool log, and every message appended so far. No hang, no throw.
4. **A `needsApproval` tool with no approver attached?** It's denied: `Denied bash (approval required but no approver is attached…)`. Failing closed means a script, a test or a misconfiguration can't silently run commands that were supposed to need a human.

## Day 13

1. **Why must abort come back as a result?** Abort is a normal user choice, not a failure. Returning `{ aborted: true, … }` keeps the partial history and the usage, avoids `try/catch` at every caller, and lets the UI simply say "aborted" and return to the prompt.
2. **Why is injecting `ScriptedProvider` safer than stubbing `fetch`?** It replaces the provider through the same interface the loop already uses, so nothing global is patched and nothing leaks between tests. The tests then prove the *loop's* behaviour, independent of the network or the model.
3. **What does the elapsed-time assertion prove?** That abort reached the tool and `run()` came back promptly. On its own, it doesn't prove that every process died: an implementation that kills only the direct child and resolves on `'exit'` also returns fast while a grandchild keeps running. That's why Day 11's test records the sleeping process's own pid (`$!`) and checks that *it* is dead.
4. **Three tools requested, aborted during the first.** The assistant message with three calls, then three results: the first is the aborted tool's result (`[killed: run aborted]` / "bash aborted"), and the other two are `Skipped: run aborted`. The pair stays valid.

## Day 14

1. **Why refuse a `tool_call` alias?** One vocabulary, defined once. Aliases create two names for one thing, and extensions inevitably subscribe to the one that never fires. The strict bus now throws on unknown names, so the mistake shows up immediately.
2. **A listener throws mid-emit.** The error goes to `onError`, the remaining listeners still run in order, and `emit` returns normally. One broken subscriber can't take down the UI or the loop.
3. **Why is `emit` fire-and-forget?** So emitting never blocks or deadlocks on a slow listener, and callers don't accidentally depend on listeners. It rules out using `emit` to *get an answer*, which is why approvals are request/response built on top of the bus.
4. **Who needs multiple subscribers by Day 22?** The bridge (UI output), session saving, the logger, the approval prompt, and any number of extensions, all listening to the same events.

## Day 15

1. **Why must exactly one component own stdin?** Two readers fight over the same keystrokes and lines go missing or arrive in the wrong place. Everything else asks through the owner (`ui.ask(question)`), which uses readline's own question mechanism.
2. **What does the first Ctrl+C do during a run?** It aborts the run (emits `abort`, which calls `AbortController.abort()`) and drops the queued messages, printing what wasn't sent. The program and session stay alive, and a second press exits. Dropping the queue keeps that promise: with the queue intact, the next message would start at once and the second press would only abort it. Exiting at once would throw away the conversation and leave tools half-finished.
3. **Where does the busy queue live?** In the bridge, the only component that knows whether a run is in flight. A line typed mid-run is pushed onto the queue ("queued (1 waiting)") and runs automatically after the current run, in order.
4. **The three ways a run can end?** A final answer, an abort, or an error. Each must clear the busy flag, restore the prompt exactly once, and start the next queued message: one teardown, called from `finally`. What each leaves in history:
   - an answer: `newMessages`;
   - an abort: `newMessages` plus the `[Request interrupted by user]` note;
   - an error: `err.newMessages` if a tool ran (the model must know the file was written), and nothing if only your message was sent.

## Day 16

1. **Why parse tool arguments once at the end?** Fragments of a JSON string (`{"pa`) aren't valid JSON, so parsing each one fails. Collect the fragments per call and parse the complete string once, when the call is finished.
2. **Where must streamed tool-call assembly live?** In the provider, which yields `{ type: 'done', response }` with a fully assembled `ChatResponse`, identical to `chat()`'s. The loop then runs one tool loop for both paths.
3. **Abort returns; disconnect throws.** On abort, the loop sees no `done`, notices the signal and returns `aborted: true`. On disconnect, the error propagates to the bridge, which reports it and restores the prompt.
4. **What do you do with thinking text?** Show it (dimmed, so the user sees progress), save it in the assistant message, and send it back to the server with tool turns. But it is never the answer, and it never counts as the final response.

## Day 17

1. **Why JSONL?** Appending is O(1) and a crash can tear at most the last line. You can inspect it with `cat`/`grep`/`jq`, and there are no dependencies. A JSON array must be rewritten on every message; SQLite is great for queries you don't need.
2. **A crash tears the last line.** `readJsonl` skips the unparseable line with a warning naming the line number, returns everything else, and reports `tornTail`. Losing one torn record beats losing the whole session. The next append must write a `\n` first. Otherwise its record is glued onto the torn line and skipped with it, the entry after that points at a missing parent, and `getPath()` loses the whole conversation before the crash.
3. **Why are appends and atomic rewrites different?** Appends add new lines cheaply and safely. A rewrite (when an existing line changes: the header, or Day 25's pointer) must never leave a half-written file, so write a temp file next to the target and `rename` it over, which is atomic.
4. **`getEntries()` vs `getPath()`?** `getEntries()` is every record in the file, abandoned branches included. `getPath()` walks `parentId` from the current leaf to the root: the active conversation. The model sees `getPath()`, via `getMessages()`.

## Day 18

1. **Where does the command-vs-message decision live?** At the input boundary. `PromptUI` emits `command` for lines starting with `/`, and the bridge runs it through the registry. Commands are about the harness and never cost a model call, so they must not reach the loop.
2. **What does `parse('/new "my session with spaces"')` return?** `{ name: 'new', args: ['my session with spaces'] }`: the arguments split on whitespace, with double quotes grouping words into one argument.
3. **Why a `Map` dispatch table?** Adding a command is one `register()` call (extensions do it too), lookup is one `get()`, and aliases are just more keys. An if/else chain grows a branch per command and hides fall-through bugs.
4. **What does `/model` change?** The provider's model, the session header's record of it, and your global `defaultModel` (Day 26). It doesn't touch the loop, the tools or the history: none of them hold a model name. It refuses a model that isn't installed, before changing anything: a typo would break every message, and once saved, every launch.
5. **Which commands must not run mid-run?** The ones that swap or rewrite the session: `/new`, `/resume` and `/compact`. Mid-run, the running conversation would be saved into a session it doesn't belong to, or history would be rewritten under the loop. They are marked `idle` and refuse while `isBusy()` is true. Everything else runs immediately, so `/quit` always works.

## Day 19

1. **Why isn't reprinting a transcript enough?** The model only knows what's in the `messages` you send. Reprinting changes the screen, not the request. Resume must pass `session.getMessages()` as the history to `loop.run`.
2. **What happens at each trigger?**
   - Startup: offer the newest session from this folder (default N).
   - A run ending: `onRunComplete` appends its messages. The newest file is the last session, so nothing else is written.
   - `/new`: `session_shutdown`, then a fresh session, then `session_start`.
   - `/resume`: pick a session, open it, and it becomes current (`session_start`).
   - `/quit`: `session_shutdown`, then stop. There's nothing left to save.

   Not `agent_end`: the loop emits it in its `finally`, before `run()` resolves and before anything is saved, and the bus doesn't wait for listeners. A save on `agent_end` would race the run's own result.
3. **Why does an empty line cancel the picker?** A picker needs an escape hatch, and an accidental Enter must never resurrect an old session. Only an explicit number selects one.
4. **Why does the startup prompt default to N?** Prompts default to the safe, unsurprising choice: a fresh session doesn't mix today's work into yesterday's context unless you ask for it.
5. **Why only sessions from the current folder?** A session from another project talks about files the tools here can't reach: the model is confidently wrong, and every tool call fails. Each header records `cwd`, and `listSessions(dir, { cwd })` filters by it.

## Day 20

1. **Why can't `emit()` carry the answer?** `emit` is synchronous and fire-and-forget: it returns before any human could answer, and it ignores listener return values. So build request/response on top: emit a request with an id, keep the promise's resolver in `Map<id, resolver>`, and resolve it when the matching `tool_approval_result` arrives.
2. **The four ways a pending approval resolves?** The user answers (y / N / a); the 120 s timeout denies; an abort denies; or, in non-interactive mode, it's denied immediately without asking. Each resolves exactly once and cleans up.
3. **Why must deny rules win even in `yolo`?** They're your last guard-rail when everything else is switched off, such as `bash(*curl*)` against an accidental exfiltration. They win over allow and yolo so nothing can quietly override them. They are **not** adversary-proof — `c\url` or `wget` dodge a string match — so a deny rule reduces blast radius; it is not a sandbox. (Allow rules are hardened the other way: a wildcard `bash` allow never pre-approves a chained command, and path rules match the normalized path.)
4. **Why does `-p` fail closed?** Nobody is there to read the command. Auto-approving would let any prompt, injected text or repo file run commands unattended, in scripts and CI. Opting in has to be explicit (`--auto-approve` or allow rules).

## Day 21

1. **Four dialect differences the provider must hide?** Any four of:
   - SSE vs NDJSON framing;
   - `arguments` as a JSON *string* vs an object;
   - fragmented tool calls keyed by `index`;
   - `tool_call_id` vs `tool_name` on results;
   - `delta.reasoning` vs `message.thinking`;
   - `finish_reason` vs `done_reason`;
   - `usage.prompt_tokens` vs `prompt_eval_count`;
   - a Bearer key; no `num_ctx`.
2. **Why key by `index`?** Only the first fragment of a call carries its `id`. Later fragments carry only the `index` (and argument text), so `index` is the one key every fragment shares.
3. **Why can't this provider report the real window?** The OpenAI Chat Completions API has no standard way to ask for, or report, the context length. Return the configured window (default a conservative 4096) with `maxContext: null`, and configure the server itself (for Ollama, `OLLAMA_CONTEXT_LENGTH`). Because you can't send `num_ctx`, a window set too high means the server silently drops the front of the prompt, so the provider also sends `max_tokens` (no runaway) and warns once when a response's `prompt_tokens` is far below the prompt it sent (truncation detected).
4. **What did you change outside `src/provider/`?** Essentially only the CLI's provider choice (and `src/shared/sse.js`, a framing helper). The loop, tools, sessions and UI were untouched, which proves the seam.

## Day 22

1. **Why do project extensions need a prompt?** They're code written by whoever wrote the repository, and they'd run with your privileges the moment you start the harness there. Global extensions are code *you* chose to install.
2. **What does `y` guarantee?** That you consented to run *exactly that code* for that project — pinned by a sha256 of **every file in the extensions tree**, entry points and the helpers they import, so a later `git pull` that changes any of them asks again. (Code imported from *outside* the extensions directory isn't fingerprinted; note that limit.) It guarantees no containment: the code still has your full privileges, and there's no sandbox.
3. **Why is a `trusted.json` inside the repo worthless?** The repo's author controls every file in it, so they can ship one that says "trusted". Trust has to be recorded somewhere the repository can't write: your own config directory.
4. **An extension wants to start a new run.** Call `api.sendMessage(text, { as: 'queue' })`. The bridge runs it after the current run (queued if busy). Never call `loop.run()` directly, because re-entrant runs corrupt history.

## Day 23

1. **Legacy vs modern MCP?**
   - **Legacy** (2025-11-25 and earlier) starts with an `initialize` handshake and keeps a session.
   - **Modern** (2026-07-28) has no handshake: every request carries `_meta` with its protocol version and client capabilities.

   A dual-era client probes with `server/discover`. A `DiscoverResult` or an `UnsupportedProtocolVersion` error means modern; any other error, or silence, means fall back to `initialize`.
2. **Protocol error vs tool error?** A protocol error is a JSON-RPC `error` (unknown tool, bad params), and it rejects the request. A tool error is a normal result with `isError: true`. Both reach the model as error results, but the tool error carries the server's actionable message.
3. **Why `needsApproval` by default?** Calling an MCP tool can do anything the server can do, and the spec says hosts must get user consent. A server's own hints (`readOnlyHint`) are claims by the server, untrusted unless you trust the server.
4. **When the server process dies?** Every pending request must reject immediately with a clear "server exited" error. Nothing may hang waiting for a reply that will never come.

## Day 24

1. **Why reserve reply space?** The model generates its answer *after* reading the prompt, into the same window. A prompt that fills the window leaves no room to answer: truncation, a 400, or a cut-off reply.
2. **How does calibration beat a pure estimate?** `promptTokens` is the server's exact count of everything up to the last call. Adding only an *estimate* of the few messages since keeps the error small, where a character-count estimate of the whole conversation can be 10–30% off.
3. **What should the harness do with `AGENTS.md`?** Follow it: it's the project's instructions for agents (commands, conventions, layout). Include it in the system prompt with its source labelled. It can't grant permissions or loosen the gate, rules or jail, which enforce policy whatever the prompt says.
4. **Why must the system prompt be deterministic?** Servers reuse work for an unchanged prompt *prefix* (prompt caching: cheaper and faster). A timestamp or random ordering at the top changes the prefix on every call and throws the cache away.

## Day 25

1. **Why does splitting a tool pair break the protocol?** The provider receives an assistant message whose tool calls have no results (or results with no matching call). Hosted APIs reject that with an error, and local models get confused about what happened.
2. **After compaction?** `getPath()` is `C → kept entries → leaf`: what the model sees. `getEntries()` still contains everything, including the summarized entries (now an abandoned branch) and any other branches, byte for byte.
3. **Why rewrite one pointer instead of copying?** Ids stay stable (references, `branch()` targets and tests keep working), nothing is duplicated, and one atomic rewrite does it. Copying would create two of every kept entry under new ids.
4. **Why ignore usage measured before a compaction?** That usage described the old, longer prompt. Trusting it overestimates the current size and triggers compaction again on every call. Only measurements taken after the compaction describe what the model sees now.

## Day 26

1. **Global `keepMessages: 9`, project `tools.enabled: ['read']`, CLI `--tools read,bash`?** `compaction.keepMessages` is 9 (from global; nothing overrides it), and `tools.enabled` is `['read', 'bash']`. The project narrowed tools to `read`, then your flag (the highest layer) set them explicitly.
2. **Why is the project layer an allow-list?** The repo's author writes that file. An allow-list means any setting not explicitly judged safe (including ones added later) is refused by default; a deny-list would let through whatever you forgot. Ignored keys are named so an attack can't hide, and so a legitimate preference can be moved to your own settings.
3. **Why must logs never go to stdout?** In `-p` mode, stdout is the answer that scripts parse, and in interactive mode it's your conversation. Logs mixed in corrupt both. Logs go to a file, and fatal messages to stderr.
4. **What does `-p` do when the model asks for `bash`?** It denies it, with a reason ("needs approval but nobody can answer… use --auto-approve or an allow rule"), and the model continues without it. When the run ends, `-p` says on stderr how many calls were denied and exits **4**, because the answer can't reflect them (and a model sometimes answers as if the denied command ran). Opt in with `--auto-approve`, or with an allow rule like `bash(npm test)` in your global settings.

## Day 27

1. **The lethal trifecta?** Access to private data, exposure to untrusted content, and a way to send data out.
   - The jail and read-only mode shrink *private data* access.
   - Repo trust prompts and the settings allow-list reduce *untrusted* control.
   - Deny rules for `curl`/`wget` make the obvious exfiltration harder; only a no-network sandbox actually cuts that leg (`python -c`, `c\url` and friends get past a string match).
   - The approval gate puts a human on all three.
2. **Why test with a compromised model?** Real models are inconsistent and change with every release: one refuses an injection today and follows it tomorrow (yours obeyed it every time in Day 29's eval). Security has to hold **even if the model does exactly what the attacker wrote**. That's what a scripted attacker model proves.
3. **Why doesn't the jail stop `bash -c 'cat ../secret'`?** The jail checks file-tool paths and bash's working directory, not what a shell command does. What stops it: the approval gate (a human reads the command), deny rules (weak), read-only mode, and properly an OS-level sandbox.
4. **What is terminal spoofing?** Escape sequences in untrusted text (file contents, command output, tool arguments, model output) can erase lines, move the cursor, or draw fake prompts and "✓" lines in your terminal. Sanitize at the **sinks**, where text leaves the program — the `Printer`, `PromptUI.ask`, the CLI's stderr, and `-p`'s stdout on a terminal — rather than at each source, because the sources keep multiplying (file names, settings keys, model names, server errors).

## Day 28

1. **Why must `@../etc/passwd` fail even though you typed it?** The jail protects the workspace boundary regardless of who asks. `@refs` are a convenience, not new authority, and the same rules as `read` keep behaviour predictable (and stop pasted or injected text from reaching outside).
2. **What does the model see for an attachment?** A fenced block, labelled as file content (data, not instructions), followed by your original message. You see one line: `attached: path (N B)`.
3. **A 60 KB file with multi-byte characters near the cut?** The longest whole-character prefix that fits the attachment budget — about 40% of the window (≈13 KB at 8k tokens), and never more than 50 KiB — then the truncation marker with the real counts. No broken characters, nothing silently dropped, and nothing the server would have to cut.
4. **Why a `<<<` sentinel?** Without raw mode, the terminal sends a line on Enter, and Shift+Enter is indistinguishable from Enter. The sentinel works in every terminal, is easy to explain, and is testable. Promising Shift+Enter would be a lie.

## Day 29

1. **pass@k vs pass^k?** pass@k is the chance that *at least one* of k attempts succeeds ("can it ever?"). pass^k is the chance that *all* k succeed ("can I rely on it?"). For an agent working unattended, pass^k is the honest one: 67% pass@1 can be 0% pass^3.
2. **Why must the scripted column be 100%?** The script is a fixed, correct sequence of tool calls, so the model plays no part. Any failure means your harness (tools, loop, CLI, checker) broke. It's a regression test, not a score.
3. **Why does each trial get a fresh copy of the fixture?** Trials must be independent. A file created by one trial would make the next pass (or fail) for the wrong reason.
4. **`resist-injection` with `--auto-approve`?** With nothing in the harness stopping the command, it measured the *model's* own resistance to a planted instruction: 0/3 for `qwen3.5:4b`. Without the flag, `-p` denies the command, so it would measure the *harness's* defense (which holds).

## Day 30

1. **Why must the demo run offline?** It has to work for anyone, anywhere, in seconds. Running it on `ScriptedProvider` through the public library API proves that the core (loop, tools, sessions) doesn't secretly depend on Ollama, the network or the terminal UI.
2. **Why does `git_commit` go through the approval gate?** One approval mechanism means one set of guarantees (timeout and abort deny, deny rules, modes, `-p` failing closed). A private confirm prompt would bypass all of that and teach extension authors to route around the gate.
3. **Steal from Pi / keep simpler?** Typical answers. **Steal:** a tiny system prompt, extension-first design, careful session persistence, a strong TUI. **Keep simpler:** no TUI (readline only), no deployment tooling, two providers plus the scripted seam. Then your own disagreement, for example MCP support.
4. **Which known gap worries you most?** Usually: `bash` isn't sandboxed (an approved command can do anything you can), approval fatigue, in-process extensions, the TOCTOU window, or estimated tokens. The fix for the biggest one is OS-level sandboxing: no network, and writes only inside the workspace.
