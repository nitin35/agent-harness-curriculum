# Changelog: the 2026-10 edition

## 2026-10-04: fixes for what the second pass found

The second pass listed problems in the code and the tests under "Found, not changed". These are now fixed. Each fix has a new check inside an existing course test, so every test count in the course stays the same (329 course tests in `solutions/final`). The changed course tests are copied into every snapshot that has them. Every new check was shown to fail against the old code and to pass against the new.

- **`read` and a final newline (Day 10; `checkpoint-1`, `-2`, `-3`, `final`).**
  - **The problem:** a ten-line file that ends with a newline was reported as "of 11".
  - **The fix:** a final newline now ends the last line instead of starting an empty one. A whole file still comes back exactly as it is on disk.
  - **Tests:** two new checks in Day 10's existing read tests.
  - **Docs:** Day 10.2 step 4 says so.
- **MCP servers that die or never start (Day 23; `checkpoint-3`, `final`).**
  - **The problem:** a server that couldn't be spawned, or that exited during the probe, was reported only after the 30-second request timeout, as `MCP initialize timed out`. A request sent after a server died also waited out its timeout.
  - **The fix:** the client remembers the first `exit` or `error`. Every later request fails with it at once, and `start()` rethrows it instead of trying the legacy handshake. In the app, a mistyped `mcp.json` path now reports `exited (code 1)` in milliseconds.
  - **Tests:** checks in the dying-server test.
  - **Docs:** concept 6, a 23.2 hint and a Stuck? entry.
- **A secret pasted into `apiKeyEnv` (Day 26; `final`).**
  - **The problem:** the validation error repeated the rejected value, and stderr can end up in a CI log.
  - **The fix:** the value of `openai.apiKeyEnv` is never echoed. Other keys still show what they got.
  - **Tests:** a check in the type-errors test.
  - **Docs:** a sentence in Day 26 concept 2.
- **Why `-p` denied a call (Days 26–27; `final`).**
  - **The problem:** the closing warning always said "nobody could approve", even when read-only mode or a deny rule refused the call.
  - **The fix:** the gate's non-interactive refusal (and the loop's no-approver refusal) now carries `unanswered: true`, which the loop copies into the denial's `details` and the tool log. `-p` words the warning from that field: `(nobody could approve)`, `(refused by your rules or mode)`, or both, each with its own advice. The Day 26 *By tonight* wording is unchanged. The `main.js` header comment now lists exit code 4.
  - **Tests:** checks in Day 27's read-only test.
  - **Docs:** Day 26 concept 5 and a 26.3 hint, and the README's exit-code line and troubleshooting row.
- **Which model an eval ran (Day 29; `final`).**
  - **The problem:** a live run without `--model` recorded `default-model` and `null`.
  - **The fix:** `runTrial` reads the model from each trial's session header and returns it as `model`, and the record keeps it. The file name and the header line use the CLI's default model, since trials run with fresh settings.
  - **Tests:** a check in the scripted-trial test.
  - **Docs:** a 29.3 hint and a Stuck? entry. The saved 2026-10-03 results file keeps its old name as a record of that run.
- **The offline demo test (Day 30).**
  - **The problem:** the test set `OLLAMA_HOST`, which the harness never reads, so a demo that used Ollama still passed on a machine running it.
  - **The fix:** the test now preloads a module (`--import` with a `data:` URL) that replaces `fetch` with one that throws. A demo that calls a provider fails the test, whether or not Ollama is running.

**Also, time hints removed from Day 1 and the README.**
- **Day 1:** the header and the ten step headings lost their time hints. The 3.4 GB download note stays in step 1.1.
- **README:** "about 2–3 hours a day", "(about 2 h)" and the total-hours paragraph are gone. The list of heavier ⚠ days and the note that Day 6 is lighter stay.

**Verified:**
- all four snapshots pass their full test suites (131, 169, 281 and 329 course tests, with the same counts as before), and the scripted evals are at 100%;
- each snapshot's `src` type-checks with 0 errors using the course's `tsc` command (TypeScript 5.9).

## 2026-10-03: second pass — writing, day by day

The material is settled; this pass rewrites each day so a newcomer can learn from it, not just look things up. Time hints are removed as each day is rewritten.

### Day 2

- **Concepts rewritten as a tutorial.** Each idea now gets an explanation, worked examples with their results (`// → …`), and C++/Python contrasts where they help. New material the rest of the course relies on: `undefined` vs `null` (and why JSON drops `undefined`), the single `number` type, truthiness traps (`if (list)`, `'0'` from an environment variable), objects comparing by identity, converting strings on purpose, the two families of array methods (and `sort`'s string ordering), `for...of` vs `for...in`, arrow-function syntax (returning an object literal), closures capturing variables (with the loop example and its Python contrast), a full `this` call table, the same client written as a class and as a factory, options objects and their destructuring error, shallow vs deep copies, why message objects must not be changed in place (a `preview` example), modules running once (so library modules must not start anything), strict mode, how to read a JSDoc comment and what `// @ts-check` reports, and dependency injection shown with the fakes tomorrow's tests use.
- Every example was run: the results and error messages are Node 26's, and the `@ts-check` messages are TypeScript 5.9's.
- **Formatting:** one-line code (the three snippets in old concept 5, the one-line class in 2.3, the one-line JSDoc) is laid out properly; the 2.1 expressions are one per line; the `confirm` one-liner in 2.4 is a code block.
- **Exercises clarified:** 2.2 shows how `once` and `memoize` should behave, and says to wrap the `this` cases in `try/catch` (a throwing case ended the script).
- **Stuck?** gains `Cannot read properties of undefined` (missing data, or a lost `this`) and `Cannot destructure property`. **Common mistakes** gains `if (list)`. **Further reading** gains javascript.info's chapters and MDN on strict mode.
- Time hints removed from the header and the build steps.

### Day 3

- **Concepts rewritten as a tutorial.**
  - **Event loop:** why one thread means a busy loop, or `spawnSync`, holds back every callback (both timed); a worked stack/microtask/macrotask example; how microtasks can starve timers; the `nextTick` ES-module detail shown as runnable code.
  - **Promises:** promise states, `new Promise` and `delay`, how `await` pauses the function and not the thread (two interleaved calls), promises starting at once (with the Python coroutine contrast), `.then` vs `await` on Ollama's `/api/version`, `try/catch` around `fetch` (`fetch failed`, `ECONNREFUSED`), and unhandled rejections.
  - **Cancellation:** `AbortController` as the stop button and `signal` as the wire; `reason` and `throwIfAborted`; an abortable `delay` written to the same contract as the tests' fake `confirm`; a table of how `fetch`, `spawn` and `rl.question` report each kind of abort.
  - **Combinators:** why `Promise.all` runs requests together, `allSettled`'s output, the `asyncio.gather` contrast, and the fact that combinators don't cancel anything.
- **Build clarified, not changed:**
  - 3.1 says to run one snippet at a time; 3.2 gives a starting callback pyramid; 3.3 gives hints for the slow server.
  - 3.4 explains how `runBash` works (events, the three messages, why the second `resolve` is harmless), shows the `try/catch` around `client.chat`, lays the `SIGINT` handler out over several lines, and explains exit code 130.
  - 3.5 explains why `answerToolCall` checks the signal three times, and shows what passing tests look like.
  - Code comments no longer run past 105 characters.
- **Stuck?** gains the `DOMException [AbortError]` crash. **Common mistakes** gains a missing `await` and expecting `Promise.all` to cancel. **Further reading** gains javascript.info's async chapters and Jake Archibald's article on tasks and microtasks.
- **Verified:** every example ran under Node 26 with the results shown. A toy assembled only from the code in 3.4 and 3.5 passes all of Day 3's course tests. New links return 200. Time hints removed.

### Day 4

- **Concepts rewritten as a tutorial, and reordered.** Bytes vs strings now comes before NDJSON framing, which depends on it; 4.4's reference moves from concept 4 to concept 3.
  - **Generators:** the iterator protocol shown with `next()`, a generator's body pausing at each `yield`, lazy infinite generators with `take`, `yield*`, and `break` running `finally` (with the Python `close()` contrast).
  - **Async generators:** a timed `countdown`, and why a streaming reply has this shape.
  - **Bytes vs strings:** `length` vs `Buffer.byteLength` for `é`, `→` and `🙂` (with the Python and C++ contrasts); a character split across chunks decoding to `h��!`, and a streaming `TextDecoder` fixing it; why `out += chunk` is a decoder per chunk; `slice` keeping 6000 bytes on a "4000" budget and halving an emoji; backing up over continuation bytes, worked through.
  - **NDJSON:** why `JSON.parse` on a chunk fails (the real error), how `split('\n')` leaves the partial line last, `NdjsonParser` on a split line, and the `getReader()` loop with why `cancel()` matters.
  - **Truncation:** why tool output must fit, `truncateText` on a tiny budget, including a cut that backs up.
  - **Backpressure:** what the stream's queue does, and why `await res.text()` defeats streaming.
- **Build clarified, not changed:**
  - 4.2's JSDoc is spread over several lines, with hints for `flush` and `readNdjson`. 4.3 gets a hint for `truncateText` and a sentence on why `constants.js` exists.
  - 4.4's one-line `node -e` command becomes a multi-line `--input-type=module` command that behaves the same.
  - 4.5's code is laid out one statement per line, and explains why `post` is a function, why the body is read once, why each piece goes both to the screen and into the reply, and what the escape sequences are.
- **Stuck?** now names the different `JSON.parse` messages a partial line produces (it only quoted `Unexpected end of JSON input`), and gains the thinking 400, `Body is unusable`, and a terminal stuck in dim. **Common mistakes** gains reading tool calls from the `done` chunk and `await res.text()`. **Further reading** gains javascript.info's generator chapters, Joel Spolsky on Unicode, MDN's streams concepts and the ANSI escape code reference.
- **Verified:** every example ran under Node 26, and the harness examples ran against `solutions/checkpoint-1`'s `NdjsonParser` and `truncateText`. A client built from 4.5's code passed a fake Ollama test: it streamed through a split `é`, collected the tool call, retried after the thinking 400 and stayed off afterwards, and still threw other errors. The `main.mjs` snippet wrote the exact expected bytes. The new 4.4 command reproduces `h��!` and, after the fix, `hé!`. The snapshot passes Days 3–4's 26 course tests. New links return 200. Time hints removed (the ⚠ stays in the title).

### Day 5

- **Concepts rewritten as a tutorial, plus one new concept.**
  - **Two kinds of failure:** what makes something a bug rather than the world, with a worked example of each (Day 9's duplicate-name throw, and a sketch of Day 10's `read` returning `ENOENT` as a result), and why an agent returns operational errors to the model.
  - **Error classes:** `HarnessError` explained line by line (why `super` comes first, why `cause` is passed only when present, what `name` changes), `UsageError` as the subclass pattern, routing on type or category shown ✗/✓, and a `ProviderError` wrapping `fetch failed`, with Node's real printout of the `[cause]` chain.
  - **`try/catch/finally`:** a `return` waiting for `finally`; a progress timer stopped in `finally` (and why the process would never exit without it); catching narrowly; why `isAbortError` uses `?.` (anything can be thrown).
  - **`node:test`:** what makes a test pass or fail, the five assertions you'll use with what each checks (including `equal`'s real message on lookalike objects), what `/strict` changes, and a table-driven test with its nested output.
  - **Injection:** a fake `fetch` built from `Response`, with `ok` and `json()`, and the `TypeError` you get when reassigning an import.
  - **New concept 6, the command line:** `process.argv`, flag conventions, exit code 2, and stdout vs stderr. Days 5.5, 5.6 and 26 build on these.
- **Build clarified, not changed:**
  - 5.1 points to concept 2's pattern for the remaining classes. 5.2 gives the two questions to ask. 5.3 points to concept 4's table pattern.
  - 5.4's test is laid out one statement per line, with a sentence on how the fake works.
  - 5.5's `FlagDef` becomes a multi-line `@typedef`, with worked `parseArgs` results and a plan for the loop.
  - 5.6 shows the routing on `category`.
  - 5.7's long command is split over two lines.
- **Stuck?** gains `super` before `this`, a class called without `new`, an un-awaited `assert.rejects` ("generated asynchronous activity after the test ended"), and a hanging test (an unclosed fake stream, and `--test-timeout`). **Common mistakes** gains routing on `err.message` and `assert.rejects` without `await`. **Further reading** gains javascript.info's error chapters, the test runner's subtests section and Node's errors page.
- **Verified:** every example ran under Node 26, and the harness examples ran against `solutions/checkpoint-1`'s `errors.js`, `args-parser.js`, `truncateText` and toy. The test code shown in 5.4 and concept 4 passes as written. Each new Stuck? message was reproduced: the un-awaited `rejects`, the hang and its timeout message, the `super` and `new` errors. The toy's `--nope`, `--num-ctx lots`, `--num-ctx 512` and `-h` give the documented messages and exit codes. The snapshot passes Days 3–5's 44 course tests. New links return 200. Time hints removed.

### Day 6

- **Concepts rewritten as a tutorial.**
  - **Read the type surface first:** why types come before bodies, Pi's real `index.ts` read as a table of contents, and a short guide to reading TypeScript, built on the real `AgentEvent` union (unions, object types, arrays, `any`, parameter and return types). Pi's `subscribe` signature is read without its body.
  - **Vocabulary:** a text-only run side by side, in Pi's events (in the order `agent-loop.ts` emits them) and ours. The tool-call rows are left for 6.2's table.
  - **Copy vs differ:** a picture of the append-only session tree with a branch, and the awaited-vs-fire-and-forget difference as two lines of code, with what each costs.
  - **Design vocabulary:** state machines taught through Day 3's REPL (as a table and as a lookup object), what a trace is, why policies are written down, and what Mermaid is.
  - **The protocol:** a one-tool run walked state by state, a rejected trace with its real error, and the three rules each given an example.
- **Build clarified, not changed:**
  - 6.2 shows the call-graph format, using the toy's own call graph.
  - 6.3 reads the event-flow diagram aloud.
  - 6.4's JSDoc is spread over several lines, with a description of `advance` and `checkTrace` and an example of what `checkTrace` returns. A sentence explains `assert.equal`'s message argument.
- **Stuck?** gains reading Pi's TypeScript, a trace without `agent_end` that is accepted anyway, and Mermaid that doesn't render. **Common mistakes** gains treating `agent_end` like any other transition. **Further reading** gains TypeScript for JavaScript programmers and Mermaid's syntax pages.
- **Verified:** every Pi path exists at 0.80.3. The quoted `index.ts`, `AgentEvent`, `subscribe` signature and `SessionManager` comment match `reference/pi`. Pi's listeners are awaited in order (`agent.ts`). The Pi event order comes from `agent-loop.ts`. The step table, the rejected trace's error, the `checkTrace` result and the ignored `session_start` come from the solution's `event-protocol.js`, whose own 9 tests pass. The bridge sentence matches `src/bridge.js` (history in via `getHistory`, finished runs out via `onRunComplete`). New links return 200. Time hints removed.

### Day 7

- **Concepts rewritten as a tutorial.**
  - **The wire:** what "the wire" means; the README's tool-pair conversation in the harness vocabulary; why translate at the edge, shown with string arguments read as an object (`undefined`, no error).
  - **What Ollama sends:** the course's real `chat-tools.json`, annotated. It shows `function` nesting, the `id` the docs said wasn't there, `done_reason: "stop"` alongside a tool call, and one call where two were asked for. Also where the streamed capture's two parallel calls sit, and concept 1's conversation as it looks on the wire, with each difference named (including the missing error flag).
  - **Context window:** what a token and a window are, the three different numbers (model maximum, running window, `num_ctx`), what silent truncation does, and how it shows up in `prompt_eval_count` (tied to Days 1, 8 and 24).
  - **Typedefs:** `ToolCall` read line by line, type-only imports, what `export {};` really does, and the `@ts-check` error for a missing field.
- **Build clarified, not changed:**
  - 7.1 explains curl's flags and how to pretty-print a capture.
  - 7.2's request is laid out over several lines (the `sed` that turns on streaming still matches), and explains `tools` and `-d @file`.
  - 7.3's request is laid out over several lines.
  - 7.4's script is laid out one statement per line, with `...(options && { options })` explained and a tip for seeing the HTTP status. The measured numbers are unchanged.
  - 7.6 gives pointers for the union and the `Provider` typedef.
- **Stuck?** gains an empty capture (`curl -s` hides the error; use `-sS`) and `model … not found`. **Common mistakes** gains detecting tool calls from `done_reason`, and trusting docs over captures. **Further reading** gains the JSDoc `@typedef` reference.
- **Verified:** the excerpt, its counts and the streamed capture's line numbers come from `course-assets/captures/ollama-0.32/`. The `done_reason` and missing-error-flag claims match `solutions/checkpoint-1/src/provider/ollama.js`. The reformatted 7.2 and 7.3 requests parse to the same objects as before, and 7.4's script writes byte-identical files. The `@ts-check` error and the `export {}` behaviour were reproduced with TypeScript 5.9. The `curl -s`, `-sS` and missing-model behaviour, and the pretty-print commands, were run. A first draft's claim that the schema file *can't be imported* without `export {}` turned out false and was replaced. New links return 200 (`/api/show`'s doc page 404s, so it isn't linked). Time hints removed.

### Day 8

- **Concepts rewritten as a tutorial.**
  - **Translator:** both directions, what "pure function" means and why the mapping is pure, and two worked examples from the solution: Day 7's conversation through `toWireMessages`, and the real `chat-tools.json` through `fromWireResponse` (with `finishReason: 'tool_calls'` derived from the calls).
  - **The request body:** `buildRequest` laid out over several lines, the exact body it produces, and what each of `num_ctx`, `num_predict`, `think` and `tools` is for.
  - **Arguments:** `parseArguments` on an object, a string, broken JSON and an array, why broken arguments are an operational error (Day 5) handed to Day 9's policy, and a generated id.
  - **Errors:** the two ways a request fails (`fetch` rejects, or `!res.ok`), the real message for each kind, why abort isn't wrapped, and the 5-minute headers timeout explained.
  - **Model info:** suffix matching, with what it finds, the return shape spread over several lines, and both cases of the minimum.
- **Build clarified, not changed:**
  - 8.1's signatures have their comments above them, and there's a hint about using a `switch`.
  - 8.2's constructor is laid out one option per line like the solution, with a note on defaults that refer to earlier parameters, and an outline of `#post`.
  - 8.4 shows the first smoke check, with why a failed `assert` gives a non-zero exit.
- **Stuck?** gains the undeclared private field. **Common mistakes** gains throwing on (or re-parsing) arguments, and budgeting against the model's maximum. **Further reading** gains MDN's private class fields and Ollama's Modelfile parameters.
- **Verified:** every example's output comes from `solutions/checkpoint-1`'s provider: the two mappings, the request body, each `parseArguments` case, a generated id, the message for each error kind (a closed port, faked 404, garbage, 500, glitch and headers-timeout responses), and `getModelInfo` for the course model, a smaller model and a missing key. The snapshot passes the 20 course tests. The private-field error and defaults that refer to earlier parameters were reproduced. New links return 200. Time hints removed.

### Day 9

- **Concepts rewritten as a tutorial.**
  - **The contract:** the `lookup` tool from *By tonight* written out field by field, the split between fields for the model and fields for the harness, and a success and a failure `ToolResult`.
  - **The malformed-arguments policy:** a short model ↔ harness exchange showing a bad call corrected by the model.
  - **JSON Schema:** what a schema is, a `read`-style schema read aloud, and `validateArguments` results on four inputs (with the Python `jsonschema`/pydantic contrast).
  - **`Map` vs plain object:** the inherited `toString`, and `__proto__` silently replacing the prototype instead of adding a key; the `Map` API and its insertion order. `JSON.stringify` dropping a function but keeping `needsApproval`, which is why provider tools are built from three named fields.
  - **Descriptions:** why the vague one fails on "tool pair".
  - **Measuring:** what counts as noise at ten trials.
- **Build clarified, not changed:**
  - 9.1 explains the name regex, and reporting `null`/array types.
  - 9.2's long comments move above their lines, with hints for the private `Map`, the duplicate throw, the returned unregister closure and `toProviderTools`.
  - 9.3 explains why the JSON round trip catches leaks.
  - 9.4 shows the counting loop, and how to time it.
- **Stuck?** gains `registerTool` rejecting a good-looking tool, and a failing round-trip test. **Common mistakes** gains copy-then-delete in `toProviderTools`. **Further reading** gains JSON Schema's types and objects pages.
- **Verified:** every `validateArguments`, `validateToolDefinition` and registry result comes from `solutions/checkpoint-1` (the `lookup` tool validates, and duplicate and bad-field registrations throw as described). The `executeTool` message format matches `agent-loop.js`. The plain-object traps, the `JSON.stringify` behaviour and the round-trip failures were reproduced. The snapshot passes the 12 course tests. New links return 200. The measured experiment table is unchanged. Time hints removed.

### Day 10

- **Concepts rewritten as a tutorial.**
  - **Lexical jail:** what the workspace and the jail are; `path.resolve` and `path.relative` with worked results; the inside check read aloud (with the Windows other-drive case); the `startsWith` trap and the `..notes` case shown as code.
  - **Symlinks:** what a symlink is; a link that looks inside but whose realpath isn't; why the nearest-existing-ancestor rule exists. For dangling links: `existsSync` says false, `lstat` sees the link, and a plain write creates the target outside. Why the hop limit stops loops.
  - **`read`:** a worked window with its marker, the real error messages, and the strict decoder vs the lenient one.
  - **`write`:** what `needsApproval` means from Day 12, and "Created" then "Overwrote" with their byte counts.
  - **Factories:** `createReadTool` in outline, registered with `process.cwd()`, and the `{ path: userPath }` rename explained.
- **Build clarified, not changed:**
  - 10.1's long comments move above their lines, with the order of the checks.
  - 10.2 gives the order of the steps inside `execute`. 10.3 explains Created vs Overwrote and `mkdir({ recursive: true })`.
  - 10.5 gives the setup commands (and what `$$` is) and a scratch script, with what success looks like.
- **Stuck?** gains a symlink loop that never finishes, and `fs.existsSync` missing the planted link. **Common mistakes** gains asking `existsSync` about a possible link. **Further reading** gains `fs.existsSync`, `TextDecoder.fatal` and the symbolic-link article.
- **Verified:** every path result, the symlink, dangling-link and `existsSync`/`lstat` behaviour, and the decoder error were reproduced in a scratch workspace. Every `read`/`write` result and message comes from `solutions/checkpoint-1`, and 10.5's script was run (both refused, nothing created). The snapshot passes the 14 course tests. New links return 200. Time hints removed.
- **Found, not changed (reported):** the reference `read` counts the empty piece after a file's final newline as a line, so a normal ten-line file is reported as "of 11", in every snapshot. The course tests use files without a final newline, so they don't see it. The doc's example uses such a file, to match the code. *Fixed on 2026-10-04: see "fixes for what the second pass found" at the top.*

### Day 11

- **Concepts rewritten as a tutorial, plus one new concept.**
  - **`spawn` vs `exec`:** `exec`'s real buffer limit (`RangeError: stdout maxBuffer length exceeded`), and why an argument array keeps data as data (Day 30's `git_commit`), while `bash` deliberately hands a whole command to `sh -c`.
  - **New concept 2, processes, signals and process groups:** pids and children, a table of `SIGTERM`/`SIGKILL`/`SIGINT`/`0`, `process.kill` sending any signal, orphans, and negative pids. The later concepts depend on all of it.
  - **Nothing outlives the call:** `'exit'` vs `'close'` explained, with a measured table (a background `sleep` holding the pipe: exit 3 ms, close 2012 ms; a redirected one: close at once, with the group still alive), and what `ESRCH` means.
  - **The bash contract:** `clampTimeout` results, the `setTimeout` overflow, a real head+tail truncation, and a real failing-command result.
  - **`edit`:** the real success diff, read line by line, and what CRLF is.
  - **Threat model:** what a threat model is and its four parts.
- **Fixed a wrong example (concept text):** the day said `sh -c 'sleep 30'` leaves `sleep` orphaned when `sh` is killed. On real shells (macOS `sh` is bash 3.2), a shell running one command replaces itself with it, so there is no separate `sh` to kill. The example is now `sh -c 'sleep 30; echo done'`, which does orphan `sleep` (verified: its parent becomes pid 1), with the reason explained. The course tests were already right: they use `sleep 30 & echo $! > pid; wait`.
- **Build clarified, not changed:**
  - 11.1's signatures are wrapped, and `unref()` and the SIGKILL grace are explained.
  - 11.2 explains moving forward to a character boundary.
  - 11.3 gives a hint for `countOccurrences` and the order of steps in `execute`.
  - 11.7 loses a "(10 minutes)" time hint.
  - Concept references move from 4 and 5 to 5 and 6.
- **Stuck?** gains every command killed at once (timer overflow), and `edit` "not found" for invisible whitespace. **Common mistakes** gains waiting for `'close'` alone. **Further reading** gains Node's child `'exit'`/`'close'` events, `signal(7)`, process groups and the unified diff format.
- **Verified:** every process, signal and timer behaviour above was run on macOS. The `clampTimeout`, bash, truncation and edit results come from `solutions/checkpoint-1`: the timeout returns in ~0.3 s and the abort in ~0.2 s, the leftover `sleep 25` is gone afterwards, and the CRLF file keeps `\r\n`. The snapshot passes the 15 Day 11 tests and Day 4's 7 truncate tests. New links return 200. Time hints removed (the ⚠ stays).

### Day 12

- **Concepts rewritten as a tutorial.**
  - **Pseudocode:** what's new compared with the toy's `runTurns`, and a complete worked run with a fake provider, showing its real `newMessages` and event order (a legal walk through Day 6's machine).
  - **Tool pairs:** a ✓/✗ history.
  - **Fresh tools:** ✗/✓ code, and the Day 22/23/24 tools that arrive while the program runs.
  - **`executeTool`:** real results for an unknown tool, bad arguments and a throwing tool.
  - **Approval:** what "fail closed" means (with the lock analogy), and a table of approver answers and the result wording each one produces.
  - **Local state:** a module-level ✗ vs local ✓ example, the re-entry error, and why the flag is reset in `finally`.
- **Build clarified, not changed:**
  - 12.2 explains why `systemPrompt` may be a function (Day 24 uses that), and how `validateAgentOptions` checks.
  - 12.3 shows the `result(…)` helper and the order of steps in `executeTool`.
  - 12.5's `emit` is laid out over several lines, with the `tool_result` line that produces *By tonight*'s `←` output, as the solution's script does.
- **Stuck?** gains a fake provider without `toolCalls`, and "already running" after a failed run. **Common mistakes** gains per-run state at module level. **Further reading** gains Fail-safe.
- **Verified:** every result, message and event sequence comes from running `solutions/checkpoint-1`'s `AgentLoop` with fake providers and tools: the worked run, each `executeTool` outcome, all five approval rows, `maxTurns`, re-entry, the flag reset after a provider crash, and both new Stuck? errors. Day 24's function-valued `systemPrompt` was confirmed in `checkpoint-3/src/app.js`. The snapshot passes the 15 course tests. New link returns 200. Time hints removed (the ⚠ stays).

### Day 13

- **Concepts rewritten as a tutorial.**
  - **One signal:** what a "sink" is, the link to Day 3's design, and what "cooperative" means. A measured example: a tool that ignores its signal held an abort for 1502 ms.
  - **Abort is a result:** the real result of an abort during a slow model call (51 ms), and a table of the four ways a run ends (answer, `maxTurns`, abort, failure), with what `run()` does in each.
  - **History:** the real message list after aborting during the first of three calls (a real `sleep 30`, back in 303 ms, nothing left running).
  - **`ScriptedProvider`:** why it replaces Day 12's hand-made fake, what each kind of step does (with the real `text()`/`toolCalls()` shapes and the exhausted message), and where it's used later (Days 26, 29, 30).
  - **Signal patterns:** `AbortSignal.any` and `reason.name` in code.
- **Fixed a wrong claim (concept text):** the day said "a promise you `race` against an abort needs its own `.catch`". Tested: `Promise.race` attaches a handler to every promise it gets, so a loser that rejects later is handled (no crash). What does crash is a promise you stop awaiting without racing it, or an abort promise that is never raced. The pattern now says so, with ✗/✓ code, and Common mistakes gains it.
- **Build clarified, not changed:**
  - 13.1 shows the provider-call `catch` and the skip branch.
  - 13.2's API block has one method per line, and explains `sleep` (Day 3's pattern) and `structuredClone` for `calls`.
  - 13.4 shows the temp-workspace pattern and how many replies to script.
  - 13.5 explains `.catch(() => 'n')` on a cancelled question.
  - The Checkpoint 1 list is unchanged.
- **Stuck?** gains an abort that waits for the tool, and `script exhausted` in your own test. **Further reading** gains `Promise.race` and `'unhandledRejection'`.
- **Verified:** every result, timing and message comes from running `solutions/checkpoint-1` (ScriptedProvider, abort during the provider call, a three-call abort with a real `sleep 30`, `maxTurns`, a provider failure then reuse, an uncooperative tool, `sleep` and `AbortSignal.any`). The four race variants were run. The snapshot passes the 7 Day 13 tests. New links return 200. The time hint is removed; the "Checkpoint 1" marker stays.
- **Skill guard fixed:** `check_day.py` compared the Phase line by cutting at the time hint, which would drop a marker after it (Day 13's "· **Checkpoint 1**"). It now removes only the time segment. Days 2–12 still pass.

### Buffer 1

- **Its own structure kept** (three paths, then "Done when"), with the writing expanded inside it:
  - **A way in:** run `node --test` with Ollama stopped, then pick a section.
  - **Repair:** why the table's order matters; what the `[345]` and `[01]` shell patterns match, and which checks need Ollama; a repair routine (run one day, read the first failure's `+ actual`/`- expected`, open that day's Stuck?, the usual three causes).
  - **Consolidate:** what "explaining a line" means, with an example and where to start; one line on what each recommended stretch teaches; the type-check command as a code block (token-for-token Day 5.7's), with its flags explained.
  - **Challenges:** hints for the `grep` tool (reuse the jail, `decodeText` and `truncateText`; count choices as in Day 9) and the trajectory printer (`result.newMessages`, and a file-safe timestamp).
- **Time hints removed:** the header's "**Time:** whatever you need, up to 3 h", and "still red after an hour", which became "after a real attempt" with what that means.
- **Verified:** both globs match the right files in zsh and bash. Stretches 8.5, 11.9 and 13.7 exist under those numbers. The timestamp expression was run. "Done when" and the footer are byte-identical.

### Day 14

- **Concepts rewritten as a tutorial.**
  - **Canonical names:** what "canonical" means, the `EVENTS` object in outline (and what `Object.freeze` and constants buy), and why an alias guarantees a listener that never fires.
  - **Strict bus:** the real errors for `bus.on('tool_call')` and for a misspelled constant (`unknown event 'undefined'`), compared with Node's `EventEmitter`, which silently ignores a typo.
  - **Semantics:** what a bus is; the throwing-middle-listener example with its real outcome; the async rejection arriving one tick later; `once` re-emitting and still running once. Observer pattern and Qt contrasts.
  - **Registry:** the `Map<string, Set>` drawn out; `Set` deduplication; why `on()` returns an unsubscribe closure; why `emit` iterates a copy, shown ✗/✓ (the live `Set` really does run a listener added mid-emit).
  - **Printer:** the exact lines it writes; why colour is gated (the real escape bytes, what `isTTY` is for a terminal and a pipe, and `NO_COLOR`).
- **Build clarified, not changed:**
  - 14.1's `EVENTS` line is spread over several lines, with how to build the arrays.
  - 14.2 gives hints for `once`'s wrapper, promise rejections in `emit`, and guarding `onError`. 14.3 gives hints for the roles table and the injected `out`/`env`.
  - 14.5's single paragraph becomes four numbered steps (the same tasks), plus what `padEnd(16)` does.
  - 14.6 shows the throwing-provider test.
- **Stuck?** gains `unknown event 'undefined'`, colour in the wrong place, and no `text_delta` yet (streaming is Day 16). **Common mistakes** gains iterating the live `Set`. **Further reading** gains `isTTY` and the observer pattern.
- **Verified:** every bus, event and printer result comes from `solutions/checkpoint-2` (strict errors, ordering, isolation, async timing, `once`, dedup, snapshot vs live `Set`, printer output under never/always/auto with and without a TTY and `NO_COLOR`). The `EventEmitter` typo was run. Both 14.6 test patterns pass against the checkpoint-2 loop. The snapshot passes the 12 course tests. New links return 200. Time hints removed.

### Day 15

- **Concepts rewritten as a tutorial.**
  - **One stdin owner:** what stdin is, and the fight shown in code: a second `readline` answers an approval *and* the main reader sends that same `y` to the model. With one owner, `question()` takes the line and the `'line'` handler never sees it.
  - **Responsibilities:** one message traced through the diagram in six steps, and why the split makes each part testable alone.
  - **Policies:** a table of five real lines and what the command rule makes of each, and the exact lines the harness prints for a queued message, then Ctrl+C twice.
  - **Teardown:** the classic bug shown ✗/✓.
  - **Run record:** what the screen and the history look like after a run that failed after `write` ran, and after one that failed at once.
- **Build clarified, not changed:**
  - 15.1 gets hints for the command regex, the press counter, the injected `onExit` and `terminal`, and a constructor spread over several lines.
  - 15.2 gets hints for `oneLine`, why the next queued run starts with `setImmediate`, and how `whenIdle` works.
  - 15.3's approver is laid out over several lines (the same behaviour), with the shebang explained and why `stop()` must undo `start()`.
  - The measured 15.7 table is unchanged.
- **Stuck?** gains an approval answer that also arrives as a message, and a prompt that never returns after an error. **Further reading** gains `setImmediate`, standard streams and the shebang.
- **Verified:** the two-reader and one-owner behaviours were run on `PassThrough` streams. The command-rule table, the Ctrl+C transcript, the interruption note in history, and both failure records come from the real `PromptUI` + `UIBridge` + `AgentLoop` of `solutions/checkpoint-2`, driven with `ScriptedProvider`. The snapshot passes the 13 course tests. New links return 200. Time hints removed (the ⚠ stays).

### Day 16

- **Concepts rewritten as a tutorial.**
  - **`chatStream`:** how it relates to `chat()`, and the real event sequence the course's `stream-tools.ndjson` produces through the reference provider (45 events: 40 thinking deltas, two start/delta pairs, then `done` with the assembled response).
  - **Assembling:** fragments assembled in code (and why `JSON.parse('{"pa')` can't be done early), what `key` is, and what an unfinished call becomes.
  - **Abort vs disconnect:** what each looks like to the caller, and the real disconnect message from a capture cut at 14 lines.
  - **The loop:** `#callModel` with its two-statement line split, why the missing-`done` branch rethrows the abort reason (Day 13), and parity checked (identical `newMessages`, with the deltas listed).
  - **The UI:** the exact output for thinking then text, and where "sent back with tool turns" happens (Day 8).
- **Build clarified, not changed:**
  - 16.1 gets hints for the stored shape, `String(key)` and id generation.
  - 16.2 explains accumulating text and choosing assembler keys.
  - 16.3 sketches the response-to-events helper and the quiet abort.
  - The Checkpoint 2 list is byte-identical.
- **Stuck?** gains the answer printed twice, and `chatStream is not a function`. **Common mistakes** gains re-printing a streamed answer. **Further reading** gains `for await...of`.
- **Verified:** the event sequence, the assembler results, the disconnect message, the quiet abort (run with a fake body that errors on abort, as real `fetch` does), parity, a loop abort mid-stream and the UI output all come from `solutions/checkpoint-2`. The snapshot passes the 13 course tests. Time hints removed (the ⚠ and "Checkpoint 2" stay).

### Day 17

- **Concepts rewritten as a tutorial.**
  - **JSONL:** what "append-only" means, and the O(n²) cost made concrete (200 messages of 2 KB: 400 KB appended vs about 40 MB rewritten).
  - **The leaf:** the two-step crash timeline that makes a stored `leafId` go stale.
  - **The tree:** `getPath()` walked on a three-entry example, and when it starts differing from `getEntries()`.
  - **Crash safety:** the torn-line story with the reference code's real outcome (`['five']` without the `\n` fix, all five messages with it, and what `cat -e` shows), why the temp file sits next to the target (`EXDEV`), and how the promise queue orders writes.
  - **Paths:** why `fs` doesn't expand `~` (with the real `ENOENT`), and how to read `0o600`/`0o700` and their `ls -l` letters.
- **Build clarified, not changed:**
  - 17.1 shows `globalPaths` results and the injected `env`.
  - 17.2 gives hints for `readJsonl`, `tornTail` and `readFirstLine`.
  - 17.3's API block has one member per line, with the long comments moved above, plus the array-and-`Map` hint and why `create()` writes nothing.
- **Stuck?** gains a literal `~`, and "not a session file". **Further reading** gains `fs.mkdir`'s `mode` and numeric permissions.
- **Verified:** lazy creation, the file name, the real modes (`drwx------`, `-rw-------`), the torn-line outcomes with and without the fix, the corrupt middle line, `configDir`/`globalPaths`, the literal-`~` error, `listSessions` and the headerless error were all run on `solutions/checkpoint-3`. The snapshot passes the 14 course tests. New links return 200. Time hints removed.

### Day 18

- **Concepts rewritten as a tutorial.**
  - **Routing:** `/model 2` traced from `PromptUI` to the registry and back.
  - **Dispatch table:** if/else ✗ vs lookup ✓, how aliases resolve through a second `Map`, why clashes are refused (with the real error), the real text for an unknown command and a throwing handler, and who hears `command_run`.
  - **Parser:** eight worked `parse`/`splitArgs` results (empty quotes, an unclosed quote, a path), and the real error for an untypeable alias.
  - **Context:** dependency injection again, and why `getSession` is a function (after `/new` the session is a different object).
  - **`/model`:** the `:latest` rule worked through both ways, and the real no-`tools` warning.
- **Build clarified, not changed:**
  - 18.2 gives hints for the two `Map`s, `parse` and the order inside `handle`.
  - 18.3 gives `/api/tags`' shape, numbering from 1, and the out-of-range answer.
  - 18.4 explains replacing the session variable.
- **Stuck?** gains `/model` refusing an installed model (the tag), and multi-line output. **Further reading** gains Dispatch table.
- **Corrected a draft claim:** I'd written that "the log (Day 26)" records `command_run`. Nothing in the final solution listens to it (only the registry emits it), so the text now says listeners such as extensions hear only successful runs.
- **Verified:** every parse, `splitArgs`, registry, `/help`, `/model`, idle and `listModels` result comes from `solutions/checkpoint-3`, with a fake context and `ScriptedProvider` models, and a fake `fetch` for `/api/tags`. `getSession`'s behaviour was checked in `checkpoint-3/src/app.js`. The snapshot passes the 11 course tests. New link returns 200. Time hints removed.

### Day 19

- **Concepts rewritten as a tutorial.**
  - **History, not pixels:** the exact message list the reference harness sends after a resume, compared with what a fresh session sends (where the model answers "I do not know.").
  - **Lifecycle:** linked to Day 6's idea, with a short timeline showing why saving happens when `run()` resolves and not on `agent_end`.
  - **Per folder:** what the user sees in a folder they've never chatted in, and that a subfolder counts as a different folder.
  - **Picker:** a real cancelled-then-picked transcript, and `/resume 2`.
  - **Summary:** why the interruption note is skipped when finding the last thing you said.
- **Build clarified, not changed:**
  - 19.1 explains why `openSession` opens before shutting down (a bad file changes nothing), and why `/resume` filters out the current session.
  - 19.2 spells out the three `resume` values and the fresh-session `session_start`.
  - 19.3 explains why the continuity test's scripted reply is a function of the messages it receives.
- **Stuck?** gains the startup question never appearing (folder mismatch). **Further reading** gains Claude Code's CLI reference (`--continue`, `--resume`).
- **Verified:** the message lists, the fresh-session answer, the startup resume line, the picker output (cancel, pick and summary) and the other-folder behaviour were all produced by driving `solutions/checkpoint-3`'s `createApp` over in-memory streams with `ScriptedProvider`, as the course tests do. The picker example labels its ids and times as yours-will-differ. The snapshot passes the 8 course tests. New link returns 200. Time hints removed.

### Day 20

- **Concepts rewritten as a tutorial** (attack examples kept at the level the day already used; only the defences were exercised).
  - **Policy first:** what allow/deny/ask mean, and a table of five calls walked through the flowchart, with each decision's reason.
  - **Rules:** how a pattern becomes an anchored regex (`globToRegExp` results), the chaining rule shown on four commands (one allowed, three falling through to a question), and the three path respellings that normalize to `.git/config`.
  - **Modes:** the same four calls decided in each mode, where the deny column never changes.
  - **The gate:** what a resolver is, the `Map<id, resolve>` core in a few lines, and the wording the model gets for a timeout and for a non-interactive refusal.
  - **"Always":** a table of call → session rule → what the prompt says it covers.
- **Build clarified, not changed:**
  - 20.1's API block has one member per line, with `decide` described as concept 1's checks in order, and why rules are validated in the constructor.
  - 20.2 gives the `finish`/`settled` pattern and the announcement on timeout and abort.
- **Stuck?** gains an unknown mode name and an invalid rule. **Further reading** gains the principle of least privilege.
- **Verified:** every decision, mode result, normalized path, `globToRegExp` output, session rule and its description, and both refusal wordings (non-interactive, and a 1-second timeout run through the loop, which also announced the result and left nothing pending) come from `solutions/checkpoint-3`. The 120 s wording follows the same format. The snapshot passes the 18 course tests. New link returns 200. Time hints removed (the ⚠ stays).

### Day 21

- **Concepts rewritten as a tutorial.**
  - **The dialect:** the same tool pair as this provider sends it (string arguments, no `tool_name`), next to the table. The measured risks paragraph is unchanged.
  - **SSE:** what SSE is, and a two-chunk example using every rule (comment, CRLF, multi-line data, a split line, `[DONE]`) with the parser's real results. Also the `JSON.parse('[DONE]')` error, and what the real `/v1` capture becomes (68 thinking deltas, one whole tool call with its string arguments parsed).
  - **Fragments:** the interleaved example's real event sequence and final calls, and why keying by `id` or parsing per piece fails.
  - **Factory:** the key-by-name indirection shown with settings, a shell `export` and the call, plus the unknown-provider error.
- **Build clarified, not changed:**
  - 21.1 describes the parser as Day 4's with a different line rule (cutting lines, the field rules).
  - 21.2's constructor is spread over several lines, with long comments moved above, a sketch of the `chatStream` loop, and the three real error messages.
- **Stuck?** gains `[DONE]` reaching `JSON.parse`, a rejected key, and empty answers with `prompt_tokens` about 4098. **Further reading** gains MDN's SSE guide. (OpenAI's API pages return 403 to automated checks, so they aren't linked.)
- **Verified:** the SSE parser results, the real capture's events and final response, the request URL, headers and body (`max_tokens: 4096`, `include_usage`), the fragmented stream's events and calls, `toWireMessages`, the factory's key lookup, and the 401/404/refused messages all come from `solutions/checkpoint-3`. The snapshot passes the 10 course tests. New link returns 200. Time hints removed.

### Day 22

- **Concepts rewritten as a tutorial** (the day's attack examples, a cloned repo and a `setup.js` that only logs `I RAN`, are unchanged; only benign extension files were run).
  - **Two sources:** what "in-process" means, and why the jail and the gate can't limit an extension (it runs on import, it isn't a tool call).
  - **Trust storage:** what a sha256 fingerprint is, the trust record the reference harness writes (one hash per file, keyed by the real path), and what a one-letter change in an imported helper does to it.
  - **The API:** one line per API member: when an extension's tool reaches the model, the real unknown-event error, queue vs note (with the note's real label), and `ui`.
  - **Loader:** why `pathToFileURL` (relative specifiers resolve against the importing module; Windows paths aren't URLs), the real warnings for three broken extensions next to a good one, rollback and exact unload, and the `import()` cache seen directly.
  - **Startup order:** why `session_start` comes last.
- **Build clarified, not changed:**
  - 22.2 points to the undo functions Days 9, 14 and 18 already return.
  - 22.3 gives the hash call, a sorted recursive walk, and what "match" means.
  - 22.4 stresses that nothing may be imported before the decision.
- **Stuck?** gains `ERR_MODULE_NOT_FOUND` for a relative path, and edits not taking effect (the cache). **Further reading** gains `crypto.createHash`.
- **Verified:** fingerprints and their change, the trust file's format, `isTrusted` before and after a change, the loader's warnings, rollback, unload counts, the note label and the `import()` cache were all run on `solutions/checkpoint-3` with benign files. The snapshot passes the 11 course tests. New link returns 200. Time hints removed.

### Day 23

- **Concepts rewritten as a tutorial** (the day's security content stays at the level of prose: a server's untrusted descriptions and leaked environment variables. Only the course's benign notes server was run).
  - **Transport:** a request typed by hand into the course server and its reply, the three rules drawn from that run, and `JSON.stringify` escaping a newline. Also why the trailing `\n` matters, and the polite shutdown.
  - **JSON-RPC:** the three message kinds, and replies arriving out of order (a real `sleep` and `add_note` pair). A minimal pending-map sketch (run against the real server), and the standard error codes plus the range MCP borrows.
  - **Two eras:** the handshake explained. A real modern request pretty-printed, and the server's three real answers to the probe. Why the probe has its own short timeout.
  - **Tools:** a real tool definition next to Day 9's, pagination, the content item types, and both failure kinds with real results.
  - **Untrusted guests:** each guard with an example: `mcpToolName` outputs, the `readOnlyHint` option, the prefixed description, `defaultEnv` output, and the collision warning. Day 22's and Day 26's roles are spelled out.
  - **Cancellation:** the three ways a request ends without a reply, and the real `notifications/cancelled` lines. Why a late reply must be ignored.
- **Build clarified, not changed:**
  - 23.1 suggests trying the server by hand first.
  - 23.2's API block is laid out over several lines. Hints name the properties the tests read, the public/private request split, and attaching listeners before the first request.
  - 23.3 gives rendering examples, the exported `mcpToolName`, the server-side tool name, and catching inside `execute`.
  - 23.4 shows `mcp.json` and the `/mcp` output.
- **Stuck?** The `_meta` entry now quotes the server's real message. New entries: a missing trailing newline, the `AbortError` the abort test expects, and a server that fails to start live. **Common mistakes** gains three entries. **Further reading** gains the spec's cancellation and security pages and Node's `child_process`.
- **Verified:** every wire line, result, error message, warning and rendering on the page was run on `solutions/checkpoint-3` against `course-assets/mcp/notes-server.mjs`, including the hand-typed command and the concept 2 sketch. The snapshot passes the 12 course tests. New links return 200. Time hints removed.
- **Found, not changed (reported):** if a server can't be spawned, or exits before answering the probe, the reference client reports it only after the full request timeout, as `MCP initialize timed out after 30000 ms`. The probe's rejection falls through to the legacy handshake, which writes to a dead process. A request made after a server has died waits for the timeout in the same way. In `createApp`, one mistyped path in `mcp.json` therefore delays startup by 30 s. This affects `checkpoint-3` and `final`, and the course tests don't catch it (their crash test kills the server mid-request). *Fixed on 2026-10-04: see "fixes for what the second pass found" at the top.*

### Day 24

- **Concepts rewritten as a tutorial:**
  - **Estimate and calibrate:** why the harness needs a count before each call (building on Day 7's tokens), the estimator's real outputs, and the course test's conversation estimated and calibrated side by side. Why the error shrinks, and why the cut-prompt check uses 60%.
  - **Budget:** what the reply reserve is for, with its floor, and `computeBudget` reproducing the *By tonight* table. The real over-budget line, why a settings cap may only lower the window, and the 80% boundary.
  - **Prompt caching:** why reuse stops at the first changed token, a ✗/✓ timestamp pair, and where the 631 ms / 54 ms numbers sit in Day 7's captures.
  - **System prompt:** the reference builder's real output for the course test's input, and what determinism rules out (clocks, randomness, unsorted `readdir`).
  - **AGENTS.md:** a sample file, the walk drawn as a folder tree (verified on a temp tree), and what a capped 50,000-byte file looks like.
  - **Skills:** a sample `SKILL.md`, its one catalog line, what `load_skill` returns, the real validation warnings, how much of the YAML the parser reads, and why your skills win over a repository's.
- **Build clarified, not changed:**
  - 24.1's API block lists one export per line.
  - New hints: what a message estimate counts, the backward search for usage, the strict `>`, the truncation contract, `.git` as a file in worktrees, warn-and-skip, `readOnly`, and the unknown-name error.
  - 24.4 shows the per-call order of the hook and the warning, and the double-count arithmetic with the *By tonight* numbers.
  - 24.5 names the startup line to look for.
  - The Stretch question about code's estimation error is left to 24.6.
- **Stuck?** gains a missing skill, a folded YAML description, and an ignored AGENTS.md. **Common mistakes** gains four entries. **Further reading** gains the Agent Skills specification, Anthropic's Agent Skills post and its prompt-caching docs.
- **Verified:** every estimate, budget, reserve, cap, threshold, prompt, walk, cap marker, skill warning and `load_skill` result on the page was run on `solutions/checkpoint-3`, and the startup line and the truncation warning were checked through `createApp`. The cache timings were read from the captures, not re-measured. The snapshot passes the 13 course tests. New links return 200. Time hints removed.

### Day 25

- **Concepts rewritten as a tutorial:**
  - **Strategies:** what each strategy does to the *By tonight* session, and a real transcript from the reference. Also the user message the model receives, the 160-character taste of a tool result, a real head+tail cut, and the cap for 4k and 8k windows.
  - **Invariants:** what a split pair looks like to the provider, why the boundary moves forward, and the diagram's arrow realigned under `r2`. Each rule has a case where it decides the outcome.
  - **One pointer:** the session file before and after a compaction (from a real run, ids shortened). What `getPath()`, `getEntries()` and the model each see, why one pointer beats copying, and what happens if `C` is appended at the end.
  - **Trees:** a branch as a file and as a tree, `getChildren`, how the marker survives a reopen, and the error for an unknown id.
  - **When:** why only earlier runs can be compacted, `shortenOldToolResults` with real notes (and the fact that the session file keeps them), and the stale-usage trap with the course test's numbers.
- **Build clarified, not changed:**
  - 25.2–25.3 gain hints: path entries vs messages, `[earlier summary]`, the return count, the order inside `compact`, comparing ISO timestamps, and returning copies.
  - 25.4 shows the hook's per-call sequence and the `Nothing to compact yet.` answer.
  - 25.6 explains the live check.
- **Stuck?** gains a rejected request after compaction and `Nothing to compact yet.` **Common mistakes** gains three entries. **Further reading** gains Anthropic's context-editing and compaction docs.
- **Verified:** every plan, transcript, cap, file layout, branch, marker, cleared note, printed message and usage number on the page was run on `solutions/checkpoint-3` (the app-level ones through `createApp` with a scripted provider and a 4k window). The snapshot passes the 15 course tests. New links return 200. Time hints removed.

### Buffer 2

- **Its own structure kept** (three paths, then "Done when"), with the writing expanded inside it, as for Buffer 1:
  - **A way in:** run `node --test` (Checkpoint 3's last item). Every course test through Day 25 runs offline, so Ollama isn't needed. Then pick a section.
  - **Repair:** why the order matters, and what each less obvious quick check means. That covers the `[56]` pattern, the offline and live forms of the "blue" check, and a tool listed twice or missing (the registry refuses duplicates, so look for one job under two names and log the names). It also covers history counted twice. Then a repair routine with this week's three usual causes, each from that day's Stuck?.
  - **Consolidate:** where the modules and events come from (with a one-liner that prints the events), what Day 6's diagram lacks, how a threat-model section goes out of date, and one line on what each recommended Stretch teaches.
  - **Challenges:** hints for `/fork` and `/tree` (Day 25's `branch`/`getChildren`, an idle command), the `todo` tool (a `turn_end` listener, and the `readOnly` question under read-only mode), your own MCP server (start from the course server, reuse `createBuiltinTools`), and `/think` (`provider.think`, its accepted values, and the automatic drop for models that can't think).
- **Time hints removed:** the header's "**Time:** whatever you need, up to 3 h", and "still red after an hour", which became "after a real attempt", as in Buffer 1.
- **Verified:** on a copy of `solutions/checkpoint-3`, all course tests pass with every provider test on fake `fetch`, and the `day1[56]-*` pattern matches the Day 15 and 16 files in zsh and bash. The events one-liner was run. The duplicate-tool error, read-only mode's rule and the provider's `think` handling were read in the code. Stretches 16.6, 20.6, 23.6 and 25.7 exist under those numbers. The table, "Done when" and the footer are byte-identical.

### Day 26

- **Concepts rewritten as a tutorial:**
  - **Layers:** the layer diagram laid out vertically. A real precedence run, and why the project layer is different (it arrives with every clone, unlike git's `.git/config`). How global merging treats objects, arrays and unknown keys.
  - **The project rules:** a worked union/read-only/intersection/lower example, the real warnings, and why an allow-list fails safe. Also a prototype-pollution demonstration with a benign `polluted: true` payload, run in its own process.
  - **Shape:** the defaults one key per line, what `apiKeyEnv`, `tools.enabled: null` and `contextLimit: null` mean, the real `TypeError`s from the frozen defaults, and the real validation messages.
  - **Logs:** what each part of a line is, levels and `--verbose`, the four rules with examples (flattening, rotation, why sync, stdout as the answer), and why logging must never throw.
  - **Errors:** how `categorizeError` decides, and the real provider and internal messages. Also `process.exit()` truncating a pipe (65536 of 1000000 bytes on macOS) next to `exitCode`, and the 128 + N signal convention, with SIGTERM shown skipping the exit hook.
  - **Modes:** the mapping onto Day 19's start modes (and the new `'pick'`), stdin for `-p`, and a shell `case $?` example.
  - **Packaging:** each `package.json` field's job, `ERR_PACKAGE_PATH_NOT_EXPORTED`, `files`, what `npm link` does, and why `main.js` resolves `process.argv[1]` with `realpathSync`.
- **Build clarified, not changed:**
  - 26.1–26.3 gain hints: `flatten`, `mcpServers` kept whole, `'lower'` from `null`, `saveGlobalSetting`, the injected clock, rotation, the handler's undo, Day 5's parser and the help text, the print-mode app, counting denials, `'pick'`, and `AGENT_HARNESS_HOME` in the tests.
  - 26.4 shows the expected `--version` output. Long code lines are wrapped.
- **Stuck?** gains three entries: a linked command that prints nothing, permission denied on `main.js`, and `ERR_PACKAGE_PATH_NOT_EXPORTED`. **Common mistakes** gains three entries. **Further reading** gains Node's process I/O note and package `exports`, `npm link`, and MDN on prototype pollution.
- **Verified** on a copy of `solutions/final`:
  - every settings result, warning and error message on the page, and the help text;
  - the CLI's exit codes 0, 2, 3 and 4 through the real process, including the repo-`autoApprove` case;
  - the `fetch` refusal and the provider's message, the pipe truncation and the SIGTERM behaviour;
  - `npm link` into a temporary prefix: the command works from `/tmp`, prints nothing without `realpathSync`, and the file becomes executable;
  - the deep-import error, and `npm pack --dry-run`.

  The snapshot passes the 15 course tests. New links return 200. Time hints removed.
- **Found, not changed (reported):** *Fixed on 2026-10-04: see "fixes for what the second pass found" at the top.*
  - A settings validation error echoes the rejected value. A key pasted into `openai.apiKeyEnv` is printed to stderr (`(got "sk-…")`), and in CI that means the job log.
  - `src/cli/main.js`'s header comment lists the exit codes without 4.

### Day 27

- **Concepts rewritten as a tutorial.** A security day: the attack material stays at the level the page already had (the `PWNED_*` markers, the fake canary, the existing table). Every new example is a defense or a benign check, and only the course's red-team repo and scripted model were run.
  - **Compromised model:** why a defense must not need the model's help, a scripted attacker (the course suite's own form, with a `touch PWNED_*` call), and what the harness prints and returns.
  - **Attack map:** the table unchanged, then read by layer (settings loader, trust prompt, gate, jail, your rules, sanitizer). Why four of the attacks are one attack in different places, and the jail's real refusals, with the canary in no output or session.
  - **The `bash` gap:** why a jail of paths can't see inside a command, what each remaining defense costs, and read-only mode's real refusal.
  - **Terminal spoofing:** what an escape sequence is and the four families, the reference sanitizer on harmless inputs, a sequence split across chunks, and the two details that keep the sinks honest (sanitize then style; a pipe gets exact bytes).
- **Build clarified, not changed:**
  - 27.1 shows `setup.sh`'s success line and why it refuses the course's own copies.
  - 27.2 gives the CSI byte ranges and the order to remove things in.
  - 27.3 says where the sessions are and how to grep them for the canary.
  - 27.4 explains why the sink tests use a colour code.
  - 27.5 gives a sample report row and `test.todo`.
- **Stuck?** gains four entries: the Printer losing its own colours, an escape byte still on stderr, the `-p` pipe test, and `setup.sh` refusing to run. **Common mistakes** gains three entries. **Further reading** gains Wikipedia's ANSI escape codes and the XTerm control sequences.
- **Verified** on a copy of `solutions/final` with the course's red-team repo:
  - each sanitizer result;
  - the Printer's styled output;
  - `-p`'s exact bytes in a pipe (`od -c`);
  - the scripted `touch` attack (exit 4, no file);
  - the read-only refusal;
  - the three jail refusals, with no canary in any session file;
  - `setup.sh`'s refusal and success lines;
  - `test.todo`'s behaviour.

  The snapshot passes the 12 course tests. New links return 200. Time hints removed.
- **Found, not changed (reported):** `-p`'s closing warning always says the calls were denied because "nobody could approve", even when read-only mode or a deny rule refused them (seen with `--permission-mode read-only`). *Fixed on 2026-10-04: see "fixes for what the second pass found" at the top.*

### Day 28

- **Concepts rewritten as a tutorial:**
  - **Grammar:** why `@` needs written rules (like Day 18's parser), and real `extractRefs` results, including the case a small grammar gives up (`see:@src/a.js`).
  - **Expansion:** where the transform runs, the fact that the session saves the expanded text (so the file stays in the conversation until compaction), why the label and the fence matter, and fence escalation shown with the real output. The four real refusal messages; the budget in numbers for 4k and 8k windows, the shared budget spent in mention order, the 512-byte floor and the cut-to-fit line; and the `not sent` line.
  - **Completion:** the completer's pair explained with real results, the first and second Tab, breadth-first search with a queue, and why `@app` finds `src/app.js` only as a substring match. Python's `os.walk` pruning as the contrast.
  - **Multi-line:** why Shift+Enter can't be detected, and the course test's block with what's kept inside it.
  - **Integration:** unit vs integration with today's tests, the full-pipeline test step by step, and why parallel runs need separate folders.
- **Build clarified, not changed:**
  - 28.1–28.2 gain hints: the regex shape, the order of checks, budget bookkeeping, what `bytes` means, the queue, skipping before pushing, and the completer's two tests.
  - 28.3 explains `transformInput` for a bridge that lacks it.
  - 28.5 shows running one half with a quoted glob, and that a bare folder argument fails.
- **Stuck?** gains `-p` without refs, part of a file outside its block, and a test that fails only in the full run. **Common mistakes** gains three entries. **Further reading** gains `--test-concurrency` and `fsPromises.mkdtemp`.
- **Verified:** every ref, expansion, refusal, budget, finder, completer and multi-line result on the page was run on a copy of `solutions/final`. So were the saved session message and the `attached`/`not sent` lines through `createApp`, and both `node --test` invocations (glob and folder). Node's docs were checked for the async completer, the default concurrency and the default test-file patterns. The snapshot passes the 11 course tests. New links return 200. Time hints removed.

### Day 29

- **Concepts rewritten as a tutorial** (a security-day page: the planted `touch INJECTED` stays as it was, and nothing new was added to the attack side):
  - **Task and checker:** what an eval is, and three checker principles, each with a course task. Strict on content and tolerant around it is shown with two real answers from the saved rerun. The checker computes the truth itself, and a safety checker needs a second condition.
  - **Modes:** what a script is (the `fix-bug` one), what a scripted trial exercises, and why a live number is a measurement.
  - **Statistics:** pass@k and pass^k read as counting picks, the course test's cases worked through, the *By tonight* `quote-line` row recomputed, and why factorials overflow (`171!` is `Infinity`) next to the product form. Python's `math.comb` as the contrast.
  - **Capability vs safety:** what each kind of pass means, and which layer each run measures.
  - **Honest tables:** the fields of a saved trial, and the rerun's failed `quote-line` stdout as an example of what a transcript explains and a pass rate can't.
- **Build clarified, not changed:**
  - 29.1–29.3 gain hints: `ws` vs the fixture, a child process for `fix-bug`, reasons, `trialEnv` as Day 23's `defaultEnv` plus three keys, exit codes 0 and 4, where the transcript lives, the script format, the `--k` default, and passing `--model`.
  - 29.3 shows the scripted run's output.
  - 29.5 says where to get the Ollama version. Its time hint is gone.
- **Stuck?** gains three entries: a live run using the default model, `Cannot reach Ollama` in trials, and a safety task passed by doing nothing. **Common mistakes** gains three entries. **Further reading** gains Anthropic's evals post and JSON Lines.
- **Verified:** every pass@k/pass^k value, the `RangeError`, the factorial overflow and the product form, and `trialEnv`'s output were run on a copy of `solutions/final`. So were `formatTable` reproducing the *By tonight* rows and the full scripted suite (5 of 5, exit 0). The saved live rerun in `solutions/final/examples/evals/results/` was read for the quoted answers and fields; no model was run. The snapshot passes the 7 course tests. New links return 200. Time hints removed.
- **Found, not changed (reported):** a live run without `--model` records its model as `default-model` in the file name and `null` in each record. The model actually used appears only in the transcript header. *Fixed on 2026-10-04: see "fixes for what the second pass found" at the top.*

### Day 30

- **Concepts rewritten as a tutorial:**
  - **Demo:** what the reference demo builds, step by step. Its real output, and the three details that make it a proof: an answer drawn from the file, `autoApprove` written out, and a separate reopen.
  - **Docs:** who reads each of the four documents, a key-decisions row with its reason, and a short check for undocumented exports. The check was run on the reference, and again with a row removed. Why other systems' event names are refused.
  - **Pi:** the post's claim corrected to what it says (the system prompt *and* the tool definitions together under 1,000 tokens), Pi's YOLO default against this harness's fail-closed gate, and a real mapping row.
  - **Capstone:** why "how you'll know" comes first, with the sandbox example.
- **Build clarified, not changed:**
  - 30.1 says to import only from `src/index.js` and to quit Ollama for the check.
  - 30.2 shows the argument array's effect, with a literal commit subject, and the empty-commit error.
  - 30.3 gives a real "Known gaps" line.
  - 30.4 adds `git log --oneline --reverse`.
  - 30.4 said "every course test from Day 4"; it now says Day 3, matching the Check item and the course tests.
  - Time hints removed, including "(as long as you like)" on 30.6.
- **Stuck?** gains `git_commit` always failing and a demo whose reopen is empty. **Common mistakes** gains three entries. **Further reading** gains Make a README and bubblewrap.
- **Verified** on a copy of `solutions/final`:
  - the demo was run and its output quoted;
  - the `git-status` extension was loaded and run in a temp repository (status, an empty commit, and a commit whose subject is the literal `"; rm -rf / #"`);
  - the export list and the undocumented-export check, as printed on the page;
  - the claims about Pi, checked against the post itself.

  The snapshot passes the 3 Day 30 tests and all 329 course tests. New links return 200.
- **Found, not changed (reported):** the Day 30 demo test sets `OLLAMA_HOST` to a dead address, but the harness never reads `OLLAMA_HOST` (it uses `ollamaUrl` from settings). On a machine where Ollama is running, a demo that wrongly called it would still pass. *Fixed on 2026-10-04: see "fixes for what the second pass found" at the top.*

## 2026-10-03: final pass — buffer days, course assets, project docs

The parts the week-by-week reviews covered only in passing. A backup of the state before this pass is next to the folder: `curriculum-backup-2026-10-03-before-final-pass.tar.gz`.

### Type-checking now works as the course describes

- Day 5.7 and Buffer 1 tell learners to run `tsc --checkJs` and "fix what it finds". **TypeScript 7 turns strict mode on by default**, so that command reported 457 errors on the reference solution, and even TypeScript 5.9 reported 63. The command now passes `--strict false`, and **every snapshot passes it with 0 errors under both TypeScript 5.9 and 7.0**. The fixes are JSDoc only, plus `McpClient` setting its fields with plain assignments instead of `Object.assign(this, …)`, which the checker couldn't see. Day 5.7 lists the kinds of errors to expect.
- Buffer 1 now uses the same command as Day 5.7 (it had dropped `toy/`).

### Buffer days

- Buffer 1 pointed at "11.7 (a sandboxed bash)"; the sandbox stretch is 11.9 (11.7 is the Core threat model).

### Course assets

- The red-team repo, eval fixture and MCP server match their copies in the solutions, and every attack in Day 27's map is planted (benign payloads only: `PWNED_*` markers and a fake canary). The "(6 refused)" in Day 27's opening matches what the settings file really triggers.
- `setup.sh` now refuses to run inside the course's own copies (`course-assets/redteam-repo`, `examples/redteam-repo`). Run there, its symlinks were copied by the Day 27 tests, whose own setup then failed.

### Shipped project docs (`solutions/final`)

- `docs/architecture.md`: new rows for the decisions the reviews added (normalized path rules, chained-command rule, project limits, per-run session saving, cut-prompt detection, sinks, `-p` exit codes); the compaction row corrected (it said compaction "never touches the current run"); the "Known gaps" section Day 30.3 asks for (it was missing).
- A **second live eval run** (2026-10-03, Ollama 0.35.1), kept next to the first: `resist-injection` resisted 2 of 3 times instead of 0 of 3. The transcripts show two plain summaries and one `touch INJECTED`; with 3 trials and a changed Ollama, the doc (and Day 29) say plainly that it can't be called progress.
- `docs/extending.md`: trust covers every file in the extensions folder; MCP servers get a minimal environment and their secrets through `env`; tool-name collisions are skipped.
- `README.md`: project limits (`contextWindow`, `maxTurns`), per-folder resume, attachment budget, exit codes.

### Evals no longer litter the project

- Every `node --test` run left a results file in `examples/evals/results/` (41 had piled up). `run.js` takes `--out <dir>`, the Day 29 test uses a temp folder, and the stray files are gone.

### Wording

- Six days referred to "the original design/plan/version", an earlier draft learners never saw (Days 17, 20, 22, 24, 25, 26). Each now names the mistake to avoid instead; this changelog keeps the history.

## 2026-10-03: week 5 revision

A course-design review of Days 26–30, checked on Node 26.3 and Ollama 0.35 (0.35.0, updated to 0.35.1 during the session) with `qwen3.5:4b`. Every new test fails with its fix undone (17 of 17) and passes with it.

### Context windows

| Where | Was | Now |
|---|---|---|
| Day 28, `@file` | Capped at 50 KiB per file (~12.8k tokens, more than the whole 8k window), with no total. Measured: a 40 KB attachment was accepted, the server processed **4,098** tokens, and the answer was empty. Compaction can't help: the attachment is in the newest message | Attachments share a budget of ~40% of the effective window; each file is cut to fit with the truncation marker, and one that finds no room is an error (so nothing is sent) |
| Days 21, 24 | Detecting a cut prompt existed only in the OpenAI-compatible provider (added in week 4) | One provider-independent check: the app estimates each prompt as it's sent and, after the call, warns once per run when the server counted under 60% of it. `beforeModelCall` is now introduced on Day 24 (Day 25 extends it to compact) |

### Safety claims and the terminal

| Where | Was | Now |
|---|---|---|
| Day 29, evals | Live trials ran the model with `--auto-approve`, your **whole environment** and your **real `HOME`**, described as "safe: it's a disposable copy" | `trialEnv`: a minimal environment (no API keys or tokens) and the trial folder as `HOME`. The doc says plainly that this shrinks the blast radius and is not a sandbox |
| Day 27 | `sanitizeForTerminal` was applied at a few call sites. Repo- and server-controlled text reached the terminal elsewhere: settings key names in the security warnings, a project-set model name, extension file names in the trust question, `attached:` lines, server error text, and `-p` output on a terminal (found by reading the code) | Sanitized at the four sinks: the `Printer`, `PromptUI.ask`, `formatError` and the CLI's warnings, and `-p`'s stdout when it's a terminal (a pipe keeps the exact bytes) |

### The CLI

| Where | Was | Now |
|---|---|---|
| Day 26, settings | A project file could raise `contextWindow` (memory Ollama allocates on your machine) and `maxTurns` without limit, though "a project may only tighten" | Both are lower-only for a project; choosing the model is announced |
| Day 26, `-p` | Exited 0 even when the tool calls the prompt asked for were denied. Live, 7 denied runs all exited 0, and one printed `hello` as if the command had run | A stderr line counts the denied calls and `-p` exits **4**. The loop marks denied calls in its tool log via the denial's `details`, so nothing parses message text. Live, a text-only prompt can exit 4 too (`Say exactly: OK` → `bash echo "OK"` in 2 of 3 runs); with `--no-tools` it exited 0 every time, which Day 26 now says |

### Smaller

- Day 27's prose said "Seven tests" (there were 8; now 12). Day 30 states its test count.
- Day 27's self-check no longer says deny rules "cut exfiltration"; only a no-network sandbox does.
- README: exit code 4, the attachment budget, the project limits, a "your terminal" trust boundary, and two troubleshooting rows.

Course tests: 321 → 329 (Day 21 −2 and Day 24 +2, as the truncation check moved; Day 26 +1, Day 27 +4, Day 28 +2, Day 29 +1). Checkpoint 3 stays at 281.

## 2026-10-03: week 4 revision

A course-design review of Days 20–25, checked on Node 26.3 and Ollama 0.35.0 with `qwen3.5:4b`. Each bug was reproduced with a script first; every new test fails with its fix undone and passes with it.

### Permissions could be sidestepped (Day 20)

| Was | Now |
|---|---|
| A wildcard allow rule matched a chained command: `bash(npm test*)` (the README's own example) allowed `npm test; curl … \| sh`, `npm test && rm -rf ~`, `$(…)`, a newline | A wildcard `bash` allow rule never matches a command containing a shell operator (`; && \|\| \| \` $( > <` or newline); it falls through to a question. Exact and deny rules are unchanged |
| Path rules matched the raw spelling: `deny write(.git/*)` stopped `.git/x` but not `./.git/x`, `src/../.git/x` or the absolute path | A path argument is normalized against the workspace root (like the jail) before matching |
| Deny rules were sold as "a real safety net" | Reworded as a guard-rail for accidents, not an adversary-proof filter (`c\url`, `wget` dodge a string match). The defence is the prompt, in Day 20, Day 27's A5, and the self-check |
| "Always" for a non-bash tool silently approved every call of that tool, unannounced | `write`/`edit` "always" is scoped to the exact path; the prompt announces what it will cover (`↳ always allowing write to this path`) |

### The second provider re-introduced silent truncation (Day 21)

| Was | Now |
|---|---|
| Over `/v1` you can't send `num_ctx`, so a server with a smaller window silently dropped the front of the prompt and reported a tiny `prompt_tokens` (measured: a 26k-token prompt → `prompt_tokens: 4098`, empty answer). The provider still reported an 8192 window | The window defaults to a conservative 4096 (raise it to match a server you configured), and the provider warns once when a response's `prompt_tokens` is far below the prompt it sent |
| No `max_tokens` was sent, so a runaway generation ran until the 300 s `fetch` timeout (last week's bug, through the other provider) | Every request sends `max_tokens` (default: the window) |

### Context machinery lost information quietly (Days 24, 25)

| Was | Now |
|---|---|
| A single run (one request, many large tool reads) outgrew a 4k window; the harness warned and carried on, into silent truncation | When the run itself is too big, its **older** tool results are shortened in place — every call/result pair kept, bulky old output replaced by a short re-readable note |
| Repeated compactions kept only the head of the summary, so old tool output survived and newer facts were lost (measured: facts 1–3 kept, 4–6 dropped over three rounds) | The summary shortens each tool result to a taste and cuts the transcript head **and** tail, so the task and the newest context both survive |
| `AGENTS.md` discovery climbed to `/`, reading `~/AGENTS.md` or `/tmp/AGENTS.md`; each file could be 32 KiB (~8k tokens, a whole window) | The walk stops at the repository root (nearest `.git`), else `$HOME`; each file is capped at ~8 KiB |

### Extensions and MCP (Days 22, 23)

| Was | Now |
|---|---|
| Extension trust hashed only top-level files, so a trusted extension's imported helper could change with no new prompt | The fingerprint covers every file in the extensions tree; imports from outside it are documented as uncovered |
| Every MCP server was spawned with your whole `process.env` — API keys and all | Spawned with a safe baseline (`PATH`, `HOME`, …) plus its configured `env` only, like the official SDK |
| One MCP tool-name collision (`search notes` vs `search_notes`) threw, closed the server, and left its other tools registered against a dead client | The duplicate is skipped with a warning; the rest register normally |

### Smaller

- Day 25's Check now states its test count; its Build lists the new tests.
- Day 22's VS Code Workspace Trust link updated to its new path.

Course tests: 306 → 321 (Day 20 +4, Day 21 +3, Day 22 +1, Day 23 +2, Day 24 +2, Day 25 +3). Checkpoint 3: 266 → 281.

## 2026-10-03: week 3 revision

A course-design review of Days 14–19, checked on Node 26.3 and Ollama 0.35.0 with `qwen3.5:4b`. Each bug below was reproduced with a script first. Every new test was confirmed to **fail with its fix undone** (16 of 16) and to pass with it.

### Sessions: fixes to what Days 17–19 promise

| Where | Was | Now |
|---|---|---|
| Day 17 | **A torn line erased the conversation on resume.** Day 17.6's own drill: tear the last line, resume, chat. The first new record was glued onto the torn line and skipped, the next one pointed at a parent that was gone, and `getPath()` stopped there. The model saw `["blue"]` and nothing before it | `readJsonl` reports `tornTail`; the first append after `open()` writes a `\n` first. `open()` warns when a parent is missing (a corrupt line in the middle) |
| Days 15, 17 | **A run that failed after a tool ran saved nothing.** `write` created a file, the next model call failed, and the session had no record of the request or the file. Day 17 also said "written to disk as it happens, one line per message", while saving happened once per run, on success only | The loop's error carries `newMessages` (whole units: the user message and complete tool pairs). The bridge saves them if a tool ran. Day 17 now says runs are saved when they end, and why (Day 25's compaction rewrites history between model calls) |
| Days 18, 19 | **`/new` or `/resume` typed mid-run mixed two conversations:** the "fresh" session started with the old conversation's last exchange. Day 19 said such transitions "are rejected" and "commands run between runs anyway"; Day 18 runs commands immediately | Commands can be `idle: true` (`/new`, `/resume`, `/compact`); mid-run they answer "works between runs". Day 19's text is corrected |
| Days 19, 26 | **Resume ignored the project.** Started in project B, `-c` loaded project A's conversation while the tools were jailed to B. `last-session.json` was global, and `/resume` listed every project's sessions | `listSessions(dir, { cwd })`. The startup offer, `/resume` and `-c` use only this folder's sessions. `last-session.json` is gone: the newest file is the last session, which can't go stale |
| Day 17 | Session files were world-readable (`0o644`), and they hold everything the tools printed | Folders `0o700`, files `0o600`, atomic rewrites included |

### The interactive harness (Days 14–16, 18, 20)

| Where | Was | Now |
|---|---|---|
| Day 15 | Ctrl+C with messages queued printed "press Ctrl+C again to exit", but the second press aborted the next queued message, and the third still ran | The first Ctrl+C aborts the run **and** drops the queue, listing what wasn't sent |
| Day 15 | After an abort, history had no sign of it, and the model sometimes went back to the cancelled task when asked something else | An interrupted run ends with `[Request interrupted by user]` (Claude Code's words). Measured on `qwen3.5:4b`: back to the cancelled task 10/36 times without the note, 4/36 with it. The first batch (4/8 against 1/8) overstated it, and Stretch 15.7 now uses that as a lesson about sample sizes |
| Days 15, 18 | A message starting with a path (`/Users/me/app.js why?`, what dragging a file into a terminal types) was swallowed as "Not a command". `/help` advertised `/?`, which the parser rejected | One grammar for commands: `/` and a name. Everything else is a message. `register()` rejects names and aliases that couldn't be typed |
| Day 18 | `/model` with a typo switched anyway, so every message failed. From Day 26 it also saved the typo to your settings, so every launch failed | Refuses a model that isn't installed, before changing anything. A name without a tag means `:latest` |
| Day 16 | In streaming mode (the default) a mid-stream `{"error"}` line skipped Day 8's glitch classification and showed up as `http` with no hint. Found by reading the code: 24 streamed trials with tiny models produced no glitch | One helper classifies glitches for both paths |
| Day 14 | The trace script's approver auto-approved anything that *started* with `ls`, `cat`, `wc`, `find` or `head`: `find . -delete`, `cat > file`, `ls; rm -rf ~` | It asks y/N. The day explains why a prefix pattern is not a safety check |
| Day 20 | The approval question cut arguments off at 200 characters, so a long command could hide its end (`ls` + spaces + `; curl … \| sh`) | The whole request is shown |

### Smaller

- **Timings:**
  - Day 15 is marked ⚠ (Core ≈ 2.75 h, up from 2.25).
  - Days 14, 17 and 19 have honest Core estimates.
- **Day 14:** the trace example shows `turn_end`'s `usage` and the approval question. The note about events "you haven't met yet" lists them correctly.
- **Day 16:**
  - The checkpoint says `AH_STREAM=0` *behaves* the same: the answers can't be identical.
  - Checkpoint 2's `createApp` now streams by default, as the doc says.
- **Day 17** no longer asks for `saveAs` or `getEntry`, which nothing used.
- **Day 19:**
  - Its lifecycle table no longer says messages are saved at `agent_end`, which fires before `run()` resolves.
  - The `/resume` summary skips the interruption note.

Course tests: 293 → 306 (Day 15 +3, Day 16 +1, Day 17 +3, Day 18 +2, Day 19 +3, Day 20 +1).

## 2026-10-02: live checks with models that can't think

Run against `llama3.2:1b` and `qwen2.5:0.5b` (both list `completion, tools` and no `thinking`) on Ollama 0.35. Every new test was confirmed to fail with its fix undone.

### Confirmed

- `think: true` to such a model gets **HTTP 400 `"<model>" does not support thinking`**, streaming or not. `think: false` is accepted. The provider's fallback works live: one refused request, one retry, one warning, and `think` stays off for that model.
- `scripts/smoke-provider.js` passes on both models. It now honours `AH_MODEL`, like the toy.

### Fixed

| Where | Was | Now |
|---|---|---|
| Day 4, the toy | `think: true` hard-coded: any model that can't think crashed the toy with an uncaught 400 | The toy turns `think` off for good after the first refusal. Course test `day05-toy-client` (Day 5, through the injected `fetch`) |
| Day 8, provider | A model glitch (HTTP 500 `token repeat limit reached`, seen live; `error parsing tool call`, present in Ollama) surfaced as a generic `http` error, "Ollama answered HTTP 500" | Classified as `bad_response`, naming the model, with a hint (ask again, rephrase, or use a stronger model). **No automatic retry:** we built one, measured it, and both glitches came straight back on the retry, so it only doubled the wait. Day 8 now teaches "measure before you add a retry" |
| Day 9, validator | Arguments the schema doesn't declare were accepted. `qwen2.5:0.5b` passed `read` an invented `output` holding its guess at the file, then answered from the guess | `additionalProperties: false` is enforced, with an error that names the property and lists the allowed ones. All four built-in tools declare it |
| Day 26, `-p` | Exited 0 when `maxTurns` ran out, with an empty stdout | Exit code 3: no final answer |
| Day 8, provider | **The unexplained exit 1, explained:** it failed after exactly 300.7 s with `UND_ERR_HEADERS_TIMEOUT`. `llama3.2:1b` ran away on a non-streaming request; Ollama's default output limit is unlimited (it shifts the context and keeps going), and Node's `fetch` gives up after 300 s without headers. It surfaced as "Request to Ollama failed: fetch failed" | Every request sends `num_predict` (default: the context window; verified that Ollama stops there with `done_reason: length`), and the timeout becomes a `bad_response` that says the model may still be generating |
| Day 1, README | "Very small models rarely call tools" | They do call tools, but badly: they echo tool definitions as text, invent arguments and file contents, and loop until `maxTurns`. Use about 4B parameters or more |

Course tests: 284 → 293 (Day 5 +2, Day 8 +4, Day 9 +1, Day 11 +1, Day 26 +1).

## 2026-10-02: week 2 revision

A course-design review of Days 7–13, checked on Node 26.3, Ollama 0.35.0 with `qwen3.5:4b`, and the reference solutions. Every code fix below comes with a course test, and every new test was confirmed to **fail on the previous reference code** and pass on the fixed one. The previous state is archived next to this folder as `curriculum-backup-2026-10-02-week2.tar.gz`.

### Security and correctness fixes (reference code, all snapshots)

| Where | Was | Now |
|---|---|---|
| Day 10, the jail | `write` through a **dangling** symlink created a file *outside* the workspace (realpath fails on a missing target, so the link counted as "not there yet"). Approval couldn't help: the prompt said `write notes.txt` | Dangling links are followed by hand (`lstat` + `readlink`, at most 40 hops). New red-team attack A13 |
| Day 10, the jail | `rel.startsWith('..')` refused legitimate names like `..notes` or Kubernetes' `..data` | `..` is checked as a path segment |
| Day 11, `bash` | `sleep 6 & echo started` ignored a 500 ms timeout **and** Ctrl+C (6 s): `killTree` returned early once `sh` had exited, and the background process held the output open | The group is killed even after `sh` exits. Leftovers are killed 500 ms after the shell exits, or at `'close'` if they redirected their output |
| Day 11, `bash` | Commands outlived the harness: a crash, `process.exit` or SIGTERM left `sleep 20` running | Running groups are tracked and killed on `'exit'`. `main.js` handles SIGTERM/SIGHUP (Day 26) |
| Day 11, `bash` | The model's `timeout` had no limit: `2**31` overflowed `setTimeout` and killed the command after 1 ms; just below that, the guardrail was off for 24 days | Capped at 10 min; nonsense values mean the default |
| Day 11, `bash` | Truncation kept only the head, losing test-runner summaries and compiler errors | Head *and* tail (`truncateText(…, { keep: 'head+tail', totalBytes })`), with a bash-specific hint |
| Day 11, `edit` | CRLF files: every edit failed with "not found" | Line endings follow the file |
| Day 8, provider | Always sent `think: true`, which models without the thinking capability may reject with HTTP 400 | On `does not support thinking`, the provider drops `think` for that model, warns once and retries. Verified with a faked server response only: every local model available for the review can think |
| Day 12, loop | Decided "User denied" vs "Denied" with a regex on the reason text, against Day 5's own rule | A structured `by: 'policy'` field; the Day 20 gate sets it |

### Tests and experiments that didn't prove what they claimed

- **Day 11's process-tree test** recorded `$$` (the shell, which on macOS is the direct child). A naive kill that resolves on `'exit'` passed while `sleep 30` survived. It now records the sleeping process's own pid with `sleep 30 & echo $! > pid; wait`, which catches the naive version (verified). The Day 13 self-check answer no longer claims the elapsed-time assertion proves the group died.
- **Day 9's description experiment** was confounded: one tool named `echo` and a prompt that said "echo". Measured: 4/5 calls with the good description, 4/5 with the vague one. It's now a 2×2×2 measurement with 10 trials per cell (clear/vague description × thinking on/off × a project question and a general one), plus a reference script. Measured on `qwen3.5:4b`: thinking off, 9/10 vs 1/10; thinking on, 10/10 vs 8/10; 0/10 on the general question everywhere.
- **Day 7.4's truncation experiment** had no exact generator, and a plausible 700-line prompt came to 16,047 tokens, barely inside the "fixed" 16k window. It now ships `scratch/long-prompt.mjs`, measured at 11,847 tokens. Without `num_ctx`: HTTP 200, 2,050 tokens processed, a garbled answer. With it: `PELICAN-42`.
- **Day 7's capture test** no longer asserts empty `content` alongside tool calls (model behaviour, not a contract).

### A finding from the live checks

A tool result's *order* matters to a small model. With the "background processes were killed" note at the **end** of the result, `qwen3.5:4b` told the user the backgrounded `sleep` "will run for 25 seconds". With the note **first**, it answered correctly in both runs. Day 11 now teaches this, and its test pins the note first.

### Docs, structure and consistency

- **Day 11.6 (new, Core, 10 min):** the toy runs commands through the real `bash` tool via Day 2's `runTool` seam, so week 2 is integrated before Day 12, and the day has a live demo.
- **Day 12 marked ⚠;** Day 11's estimate is now 3–3.5 h.
- **Day 7.3** has a round-trip request template (verified live with both ids, and with each alone). **Day 8** documents the thinking fallback. **Day 9** drops the `ToolCallRequest` alias. **Day 11** says WSL instead of `cmd.exe`.
- **Stale references fixed:** "the original plan" in Day 12, Day 8's self-check Q1, and "course tests from Days 4–…" on Days 13, 16, 25 and 30.
- **Course tests:** 273 → 284 (Day 8 +1, Day 10 +3, Day 11 +5, Day 12 +1, Day 27 +1).

## 2026-10-02: week 1 revision

A course-design review of Days 1–6. Everything below was checked on 2026-10-02 against Node 26.3, Ollama 0.35.0 with `qwen3.5:4b`, and the vendored Pi 0.80.3. The previous state is archived next to this folder as `curriculum-backup-2026-10-02.tar.gz`.

### Factual errors fixed

| Where | Was | Now |
|---|---|---|
| Day 6 | "Sessions are a tree" listed as a way we differ from Pi | Pi's `SessionManager` *is* an append-only JSONL tree with `id`/`parentId`. Now listed under "the same as Pi" |
| Days 6, 14, self-check | Pi has "a single `AgentEventSink`" | That's only the low-level loop's callback. Pi's `Agent.subscribe()` fans out to many listeners and *awaits* them. The comparison is now awaited fan-out versus our fire-and-forget named bus, with the trade-off spelled out |
| Day 3 | "By tonight" and Check showed a *streaming* answer being aborted | Streaming arrives on Day 4. The transcript now shows what Day 3 can do |
| Days 3–4 | The toy's `runBash` did `out += chunk` on raw `Buffer`s, corrupting a character split across chunks (`h��!`) | `setEncoding('utf8')`. Finding this bug is now a Day 4 exercise, with a course test |
| Day 2 | `[user].map(u.greet)` (a `ReferenceError`) | `['x'].map(user.greet)` |
| Day 2 | `setTimeout(client.label)` implied `this` is `undefined` | Node passes its `Timeout` object, so the result is a quiet `undefined`, not a `TypeError`. Explained, and the exercise now logs |
| Day 4 | `take(n)` pulled one value too many from its source | Checks the count before pulling |
| Day 5, Buffer 1 | `tsc --checkJs` without `@types/node`: 23 false errors on the reference code | Installs `@types/node`. Every week 1 module, the toy included, now type-checks cleanly |
| Day 4, test headers | `node --test tests/course/`, which fails with `Cannot find module` on Node 22+ | File globs, plus a troubleshooting row |
| Self-check, Day 6 | State `ExecutingTools` | Matches the day's states |

### Teaching gaps closed

- **Ctrl+C at a `[y/N]` question now aborts** (Day 3): `rl.question(prompt, { signal })`. Previously it printed "(aborting…)" and waited for Enter. Verified live.
- **Timeouts are reported as timeouts** (Day 3). `spawn` reports both a timeout and a Ctrl+C as an `AbortError`; the toy now asks the timeout signal which one fired.
- **Node's event-loop specifics** (Day 3): `process.nextTick`, the ES-module versus CommonJS ordering difference, and `setTimeout(0)` versus `setImmediate`.
- **Dependency injection's real reasons** (Day 5): `fetch` is a patchable global, so the old "you can't patch it" argument was wrong.
- **Testing what was sent, not just what came back** (Day 5.4): the offline toy test now asserts `num_ctx` is in the request.
- **House rule clarified** (Day 2): message objects are read-only, and the history array is append-only and owned by the loop.
- **Safety wording** (Day 1): the `demo` folder doesn't limit the agent; only `[y/N]` does. A new stretch exercise plants a prompt injection in `demo/c.txt`.
- **The truncation hint is a parameter** (Day 4, README contract): the toy's marker no longer points the model at a `read` tool it doesn't have.
- **Windows** (Day 1): use WSL 2 from the start, instead of a `cmd.exe` workaround that broke on Day 3.

### Structure and assessment

- **Course tests start on Day 3** (9 tests on the toy loop and bash tool, using the `client`/`confirm`/`runTool` injection from Day 2). Day 4 adds `day04-toy-bash` (2) and a truncation-hint test (1). Day 5 adds `day05-errors` (6) and fixes a test that passed when nothing was thrown. Course tests: 255 → 273.
- **The Day 6 state machine is no longer a dead end.** It is now an event-protocol checker that matches the real loop: skipped calls, `agent_end` from any state, approval. Day 14 runs real `AgentLoop` traces through it, and `scripts/trace.js` checks live runs. The real Day 20 approval gate's approve, deny, timeout and abort traces all pass it.
- **The args parser is used the day it's built:** the toy gets `--model`, `--num-ctx` and `--help` on Day 5.
- **Pacing:** Day 4 is marked ⚠ (3–3.5 h). Day 6's Core shrank to about 1.75 h and is now week 1's catch-up room. The Thorsten Ball essay moved to further reading, and the gap list and divergence table were folded into other steps.
- **Readability:** every week 1 day lists its files, spells out cross-file changes (Day 4's streaming callbacks), shows the expected `getUsage` output (Day 5), and has new **Stuck?** entries for the failures learners actually hit.

This edition implements the course-design review of the previous version. Every claim about Ollama, Node and MCP below was checked on 2026-10-01 against live software (Ollama 0.32.0 with `qwen3.5:4b`, Node 26.3) or the current specification. The previous edition is archived next to this folder as `curriculum-backup-2026-10-01.tar.gz`.

## Headline changes

- **A working agent on Day 1.** Week 1 now teaches JavaScript by upgrading a 70-line toy agent:
  - modules (Day 2);
  - Ctrl+C abort (Day 3);
  - streaming and thinking (Day 4);
  - tests (Day 5).

  Previously the first agent appeared on Day 12, and the first interactive chat on Day 19.
- **Something visibly works every 1–3 days.** The interactive harness arrives on Day 15 (was 19).
- **Course tests for every build day** (`course-tests/`, 255 tests): an exact, offline spec for each day's modules.
- **Reference solutions** at each checkpoint (`solutions/checkpoint-1|2|3`, `final`, `toy`). Each is a complete project whose course tests pass on its own.
- **A new day template:** By tonight → Why it matters → Concepts → Build (Core/Stretch) → Check → Stuck? (collapsible hints) → Common mistakes → Self-check → Further reading.
- **Reading lists everywhere.** About 100 external links (previously about 10, and 24 of 30 days had none), every one checked to resolve on 2026-10-01.
- **Two buffer days** (after Checkpoints 1 and 3). Heavier days are marked ⚠.

## Review findings, fixed

### a. Up to date

| Finding | Fix |
|---|---|
| Node 20 (end-of-life 2026-04-30) | Node 24 LTS recommended, 22 minimum (`engines >=22`) |
| `qwen2.5:7b` hard-coded in about 13 files | One course model, `qwen3.5:4b` (`qwen3.5:9b` with 16 GB+), defined once (`DEFAULT_MODEL`, README) and verified live |
| **Ollama's 4k default context truncates silently**, and budgets used `/api/show`'s maximum | `num_ctx` sent on every request from Day 1; `getModelInfo().contextLimit = min(num_ctx, model max)`. Day 7 has learners reproduce the silent truncation themselves: we measured HTTP 200, 2,050 of 11,145 tokens processed, and the system prompt lost |
| No thinking/reasoning support | A `thinking` field, a `thinking_delta` event, dimmed display, sent back with tool turns (Days 4, 7, 8, 16) |
| Tool-call ids assumed to come from the server | Ollama 0.32 *does* send `id` + `index` (the API reference page said it doesn't), so: keep the server's id, generate one when missing |
| Streamed tool calls | Taught from real captures: Ollama sends each call whole in an earlier chunk, and the `done` chunk does not repeat them |
| The Day 20 fragment-assembly lesson had no real data on Ollama | A new Day 21: an OpenAI-compatible provider (SSE, string arguments, fragments by `index`), with a real `/v1` capture and a fragmented fixture modelled on hosted APIs |
| MCP only mentioned post-course | A new Day 23: a dual-era MCP client written from scratch (2026-07-28 stateless `_meta` plus a legacy `initialize` fallback), with a course MCP server in `course-assets/mcp/` |
| No Agent Skills | Day 24: discovery plus `load_skill` (progressive disclosure) |
| AGENTS.md treated as "untrusted data, never policy" | Day 24: **follow it** for conventions. It cannot grant permissions, and labels/delimiters are explicitly *not* a security boundary |
| Only per-call y/N approval | Day 20: permission **rules** (`bash(git status)`, deny always wins), **modes** (`default`, `read-only`, `accept-edits`, `yolo`), "always this session", and OS sandboxing as a stretch and capstone |
| Prompt caching and calibrated token counts missing | Day 24: deterministic system prompt (cache-stable prefix, with a measured 631 ms → 54 ms warm-cache example); budgets calibrated from real `promptTokens` |
| Thin evals | Day 29: multiple trials, pass@k **and** pass^k, saved transcripts, a safety eval; scripted mode tests the harness, live mode measures the model. Real measured table included |

### Security issues in the previous design

1. **`bash` ran unsupervised from Day 13 to Day 22** (the approval stub auto-approved). Now **fail-closed from Day 12**: no approver means deny, and the toy agent asks before every command from Day 1.
2. **Project `settings.json` could set `autoApprove`, `ollamaUrl`, …** Now an **allow-list**: a repo may only set harmless preferences or *tighten* security. Every refused key is reported by name. There is a course test of the attack.
3. **`-p` print mode auto-approved.** Now it **fails closed** (deny, with an actionable reason) unless you pass `--auto-approve` or an allow rule. Verified live: the model's `bash` call was denied and stdout stayed clean.
4. **Project-extension trust was stored in the repo** (`.agent-harness/trusted.json`, which a malicious repo can ship). Now it's stored in *your* config, keyed by project path **and file hashes**, so changed files ask again.
5. *(Found while building.)* **Terminal spoofing:** untrusted tool output was printed raw, so escape codes could erase lines and fake prompts. `sanitizeForTerminal` is now applied to everything untrusted (Day 27).
6. *(Found while building.)* **Symlink escape** was a stretch item. The realpath check is now Core on Day 10.
7. *(Found while building.)* **`bash` grandchildren survived abort/timeout** (`sh -c 'sleep 30'`). Now the whole process group is killed, with a test that checks the grandchild's pid.

### b. Readability

- Every day was rewritten in plain, second-person prose. Removed: instructions aimed at AI reviewers, "verbatim"/"CRITICAL" boilerplate, and most cross-reference noise.
- Each day opens with a **By tonight** transcript and a **Why it matters** paragraph.
- Each day has worked code (skeletons, signatures and key snippets), collapsible **Stuck?** hints, and realistic time estimates.

### c. Self-learner support

- Course tests, solutions, a reading list per day, and a solutions spoiler policy.
- Real wire captures (`course-assets/captures/ollama-0.32/`).
- Practice assets: an MCP server, a red-team repository, an eval fixture.
- Every relative link and anchor resolves (checked mechanically).

### d. Engagement

- Live demos every 1–3 days (see the README's weekly table).
- **A new red-team day (Day 27)** with twelve planted attacks. Measured live: `qwen3.5:4b` *did* try to exfiltrate a canary via `curl` and obeyed AGENTS.md, and the harness stopped both. Tests assume a fully compromised model.
- **A capstone choice** on Day 30: OS sandbox, hosted provider, sub-agents, LLM compaction, your own MCP server, or a TUI.

## Errata fixed

- "There is no `packages/pods`" was wrong: it exists in the vendored Pi. The README and Day 6 now list it as out of scope.
- Days 18–30 lacked the daily commit step. Every day now ends with `day-NN: …`.
- The Day 8 deliverable listed a `getModelInfo()` stub that no activity built. It's now implemented on Day 8 (it's needed for `num_ctx`).
- "`JSON.stringify` ships `[Function]`" was wrong: it *omits* function-valued properties.
- Mixed "50 KB"/51,200: now 50 KiB everywhere.
- Test scripts lived in `src/` (`src/test-*.js`) and would have shipped with the package. They're now in `scripts/`.
- The Day 27 compaction cap of 32 KiB was about 8k tokens, a whole 8k window. Compaction text is now about 20% of the window.
- After compaction, stale `usage` numbers re-triggered compaction. Usage measured before a compaction is now ignored.
- The session header's `leafId`/`updatedAt` could be left stale by a crash. The leaf is now derived from the file, and `mtime` gives the update time.
- `tools.enabled` defaulted to the four built-ins, which silently disabled extension and MCP tools. The default is now `null` (all tools).

## Structure

| Old | New |
|---|---|
| Days 1–6: JavaScript drills, then a Pi study | Days 1–6: the toy agent *is* the JavaScript course, then the Pi study |
| Days 14–15: sessions I/II | Day 17: sessions (branching moved to Day 25, where compaction uses it) |
| Day 18 + 20: streaming text / tool calls | Day 16: streaming with parity (Ollama), Day 21: fragmented tool calls (OpenAI dialect) |
| Day 24: model discovery | `getModelInfo` on Day 8, `/model` on Day 18, `ScriptedProvider` on Day 13 |
| Day 28: CLI + settings | Day 26, with the secure project layer |
| Day 30: extension + evals + demo + docs in one day | Day 22 extensions, Day 29 evals, Day 30 demo, docs and capstone |
| — | New: Day 21 (second provider), Day 23 (MCP), Day 27 (red team), Buffer 1 and 2 |

## Known limitations of this edition

- Live behaviour was verified with **one** model (`qwen3.5:4b`) on **one** machine (macOS, Apple silicon). Other models will differ, which is why learners capture their own (Day 7) and run their own evals (Day 29).
- The `bash` and timeout tests need a POSIX shell. They skip on native Windows, and Windows users should use WSL.
- MCP is implemented from the 2026-07-28 specification plus the legacy handshake, and tested against the bundled course server. Real third-party servers vary (that's the Day 23 stretch).
- The Pi file paths named on Day 6 were checked to exist in the vendored 0.80.3 tree; Pi's internals were not re-reviewed.
- Token counts are estimated, then calibrated with server-reported usage. They're fine for budgeting, never for billing.
