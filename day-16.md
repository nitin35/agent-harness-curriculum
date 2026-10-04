# Day 16 — Streaming, and Checkpoint 2 ⚠ heavier day

**Phase:** Week 3 — Interactive harness · **Checkpoint 2**

## By tonight

```
> Which file in the toy folder is the largest? Use bash.
The user wants the largest file… I'll use find with sizes…           ← thinking, dim, live
  ⚙ bash {"command":"find toy -type f | xargs ls -lS | head -1"}
  allow bash …? [y/N] y
  · ✓ -rw-r--r--  1 you  staff  2310 toy/agent.mjs
agent> The largest file is toy/agent.mjs (2.3 KB).                    ← token by token
```

The real harness streams thinking and answers live, tool calls work exactly as before, and Ctrl+C mid-stream stops it cleanly.

## Why it matters

You did streaming on the toy (Day 4). Now it goes into the provider *interface*, without breaking anything built since. The rule for today is **parity**: a streamed turn must end in the **same** `ChatResponse` as a non-streamed one and go through **the same** tool loop. Two loops would mean two behaviours, and bugs that only show up live.

## Concepts

### 1. `chatStream` is an async generator

**A second way to talk to the model, with the same ending.** `chat()` (Day 8) returns one `ChatResponse` when the reply is complete. `chatStream()` yields the reply in pieces as it arrives, then yields the complete `ChatResponse` at the end. An async generator (Day 4) is the natural shape: the caller writes one `for await` loop and receives each piece when it's ready.

```js
async *chatStream(messages, tools, { signal } = {}) {
  // POST with stream: true … then for await (const chunk of readNdjson(res.body)) { … yield events … }
  yield { type: 'done', response };   // the assembled ChatResponse
}
```

It yields exactly the five [`StreamEvent`](README.md#message-and-tool-shapes) shapes: `thinking_delta`, `text_delta`, `tool_call_start`, `tool_call_delta` and `done`. Day 4's `readNdjson` does the framing.

**What a real stream turns into.** The course's `stream-tools.ndjson` capture (Day 7), fed through the reference `chatStream` in 7-byte chunks, yields 45 events:

```
thinking_delta  "The"
thinking_delta  " user"
…               (40 thinking_delta events in all)
tool_call_start { id: 'call_ilgg65b6', name: 'bash' }
tool_call_delta { id: 'call_ilgg65b6', argsDelta: '{"command":"ls -la /tmp"}' }
tool_call_start { id: 'call_bfxc8z8k', name: 'bash' }
tool_call_delta { id: 'call_bfxc8z8k', argsDelta: '{"command":"cat /etc/hosts"}' }
done            { response: { content: '', toolCalls: [ls -la /tmp, cat /etc/hosts],
                  finishReason: 'tool_calls', usage: { promptTokens: 302, completionTokens: 106 }, … } }
```

The deltas are for the screen. The `done` event's `response` is for the loop: it's a complete `ChatResponse`, exactly what `chat()` would have returned.

### 2. Assembling tool calls

**Tool calls don't always arrive in one piece.** There are two kinds of server:
- **Ollama** (your captures): each call arrives **whole, in its own chunk**, and the `done` chunk **does not repeat them**. You emit `tool_call_start`, then one `tool_call_delta` holding `JSON.stringify(arguments)`.
- **OpenAI-style** servers (Day 21) split a call's `arguments` *string* across many deltas, and only the first carries the `id`.

One `ToolCallAssembler` serves both: `start(key, { id?, name })` returns an id (it generates one if missing), `append(key, fragment)`, then `finish()`, which **parses each call's arguments exactly once**. You can't parse JSON fragments (`{"pa` isn't JSON), so parsing belongs at the end. Broken JSON becomes a `parseError` (Day 9's policy), never a throw.

```js
const assembler = new ToolCallAssembler();
assembler.start(0, { id: 'call_1', name: 'read' });   // the first fragment carries the id
assembler.append(0, '{"pa');                          // JSON.parse('{"pa') would throw here
assembler.append(0, 'th":"no');
assembler.append(0, 'tes.txt"}');
assembler.finish()
// → [{ id: 'call_1', name: 'read', arguments: { path: 'notes.txt' } }]
```

`key` is whatever later fragments use to say which call they belong to: OpenAI-style servers send an `index`. If the stream ends with an incomplete string such as `{"path":`, `finish()` returns the call with `arguments: {}` and a `parseError` saying the JSON ended early, and the loop tells the model to retry.

### 3. Abort vs disconnect

**Two ways a stream stops early, handled in opposite ways.**
- **Abort** (the user's choice): the generator **returns** with no `done` and no error. `readNdjson`'s `finally` cancels the reader.
- **Disconnect** (the body ends without a `done: true` line): **throw** a clear `ProviderError`, e.g. *"stream disconnected before done (received 14 lines…)"*.

For the caller, an abort looks like a `for await` loop that ends early: in a test, four deltas arrived, then the loop finished, with no exception. A disconnect means the server or the network failed mid-answer, so someone has to hear about it. Cutting the course capture off after 14 lines gives the reference provider's real message:

```
ProviderError: Ollama stream disconnected before done (received 14 lines, 0 characters of text)
```

The counts help when you debug: they tell you how far the stream got before it stopped.

### 4. The loop consumes; parity holds

**The loop drains the stream, forwards the deltas, and keeps the ending.** Then everything after it is the same code as before:

```js
async #callModel(messages, tools, signal) {
  if (!this.streaming) return this.provider.chat(messages, tools, { signal });
  let response;
  for await (const ev of this.provider.chatStream(messages, tools, { signal })) {
    if (ev.type === 'text_delta') this.emit('text_delta', { content: ev.content });
    else if (ev.type === 'thinking_delta') this.emit('thinking_delta', { content: ev.content });
    else if (ev.type === 'done') response = ev.response;
  }
  if (!response) {
    if (signal?.aborted) throw signal.reason;
    throw new Error('stream ended without a done event');
  }
  return response;   // → the SAME code path as chat()
}
```

When the stream ends without `done`, there are two cases. If the signal fired, the user aborted: rethrowing the signal's reason lets the existing abort handling (Day 13) turn it into `{ aborted: true }`. Otherwise something went wrong, and it's an error.

**Parity, checked.** Run the same script once with `streaming: false` and once with `streaming: true`, and the history (`newMessages`) is identical, byte for byte. The streaming run also emitted its deltas along the way (`thinking_delta "thinki"`, `"ng it "`, `"over"`, then `text_delta "Don"`, `"e: "`, `"hi"`). The deltas changed what you saw, not what was saved.

### 5. The UI shows thinking, then the answer

**Two kinds of text, shown differently.** The bridge (Day 15) already routes `thinking_delta` to `ui.writeChunk(text, 'thinking')` (dim) and `text_delta` to `writeChunk(text, 'text')`, which prints `agent> ` before the first chunk. Thinking is shown, **saved in history, and sent back with tool turns**, but it is never "the answer".

With colour off, four chunks (two thinking, two text) come out as:

```
  The user wants the largest file.
agent> The largest file is toy/agent.mjs.
```

Thinking is indented (and dim, with colour on), so you can watch the model work. When the kind changes, the line ends, and the answer starts on its own line after `agent> `. Day 8's `toWireMessages` already sends an assistant message's `thinking` back to the server, which is what "sent back with tool turns" means.

## Build

### 16.1 `src/provider/tool-call-assembler.js` — Core

`class ToolCallAssembler` with `start(key, { id, name })` → id, `has(key)`, `idFor(key)`, `append(key, fragment)` (empty fragments are ignored) and `finish()` → `ToolCall[]`, using `parseArguments` from Day 8. Keep the calls in a `Map` so their order is preserved.

Store each call as `{ id, name, parts: [] }`, keyed by `String(key)`, so `0` and `'0'` mean the same call. A missing `id` gets one the way Day 8 generated them (`call_` plus part of a `randomUUID()`). `finish()` joins each call's parts and passes the string to `parseArguments` once.

### 16.2 `OllamaProvider.chatStream` — Core

1. POST with `buildRequest(…, { stream: true })` (which still sends `num_ctx`!). If the POST itself is aborted, `return`.
2. `for await (const chunk of readNdjson(res.body))`:
   - if `chunk.error`, throw, through Day 8's glitch check. Once streaming, the HTTP status is already 200, so a failure arrives as an `{"error": …}` line, and that includes "error parsing tool call". Reuse the same classification (one helper for both paths), or the streaming harness reports glitches as a server fault with no hint;
   - `message.thinking` → `thinking_delta`;
   - non-empty `message.content` → `text_delta`;
   - each `message.tool_calls[]` entry → assembler `start` + `tool_call_start` + `append` + `tool_call_delta`;
   - on `done: true`, remember the chunk and `break`.
3. Catch abort and `return`. With no done chunk, throw the disconnect error.
4. Yield `{ type: 'done', response }`. `finishReason` is `'tool_calls'` if there are calls, else `done_reason`; `usage` comes from the done chunk.

Accumulate `content` and `thinking` as you yield their deltas, so step 4 can build the response from them. Each Ollama tool call arrives whole, so any key that's unique per call works for the assembler (for example, the line number plus the call's `index`).

### 16.3 Loop and ScriptedProvider — Core

- `AgentLoop` gets a `streaming` option, and `#callModel` follows concept 4.
- `ScriptedProvider.chatStream` replays a script step as events (split text into a few pieces so streaming code really runs). Support `{ events: [...] }` to replay exact events, e.g. one with no `done`, and `{ chunkDelayMs, response }` for abort tests.
- In `createApp`, set `streaming: true` by default (`AH_STREAM=0` turns it off; that's handy for comparing).

For `ScriptedProvider`, a small helper that turns a `ChatResponse` into events does most of the work: thinking and text cut into a few pieces, then a start and a delta for each tool call, then `done` with the response itself. On abort, end the generator quietly, as the real provider does.

### 16.4 Course tests — Core

Copy `course-tests/day-16/`. The stream bodies are **real 0.32 capture lines**, fed in 1-, 5-, 7- and 11-byte chunks. It covers:
- text order, skipped empty deltas, the done response;
- tool calls collected from earlier chunks;
- disconnect, abort ending quietly, and an error inside the stream (glitch or not);
- assembler fragments plus parse-once;
- **parity** (identical history with and without streaming);
- stream-to-loop events, loop abort mid-stream, and a missing `done`.

### 16.5 Checkpoint 2 — Core

Run `node src/cli/main.js` and work through the list. Fix anything red (Buffer 2 comes later, so fix it now if you can):

```
Checkpoint 2 — interactive streaming harness
[ ] thinking streams dimmed, the answer streams token by token
[ ] tool calls work while streaming (approve → result → final answer)
[ ] Ctrl+C mid-stream stops generation; "aborted"; the prompt returns
[ ] a provider error (stop Ollama) prints a readable message; the prompt returns
[ ] AH_STREAM=0 behaves the same (tool calls, approvals, the answer), just not live
[ ] node --test green (all course tests Days 3–16)
```

Commit `day-16: streaming — checkpoint 2`.

### 16.6 Time to first token — Stretch

Measure *time to first token* and *tokens per second* from the events, and add them to Day 15's status line. Compare `think: true` with `think: false` on the same question. Write down what thinking costs, and what it buys you.

## Check

- [ ] Checkpoint 2 list fully ticked
- [ ] Commit `day-16: … checkpoint 2`

Solution: [`solutions/checkpoint-2/`](solutions/checkpoint-2/), the complete end-of-Day-16 project (169 course tests).

## Stuck?

<details><summary>Tool calls vanish when streaming</summary>

You built the response from the `done` chunk's `message`. Ollama put the calls in **earlier** chunks. Collect them through the assembler as they arrive.
</details>

<details><summary>The abort test hangs</summary>

Is `signal` passed to `fetch` (via `#post`)? When the request is aborted, the body stream errors, `reader.read()` rejects, and your `catch` must `return` when `isAbortError(err) || signal?.aborted`.
</details>

<details><summary>Parity test: the streamed history has an extra or a missing field</summary>

Both paths must build the assistant message with the *same* code in `run()`. `#callModel` just returns a `ChatResponse`. Check that `done.response` has `thinking` only when it isn't empty, exactly as `chat()` does.
</details>

<details><summary>The answer appears twice: once streamed, once all at once</summary>

The bridge printed `result.response` after the run, although the text had already streamed. Remember whether any `text_delta` arrived during the run, and print the response at the end only when none did.
</details>

<details><summary><code>this.provider.chatStream is not a function</code></summary>

A provider without streaming (an older fake in a test, say) met a loop with `streaming: true`. Have `#callModel` fall back to `chat()` when the provider has no `chatStream`.
</details>

## Common mistakes

- `JSON.parse` on each argument fragment.
- A second tool loop bolted onto the streaming path.
- Treating abort as an `error` event: the user didn't make a mistake.
- Printing the answer again after it has streamed.

## Self-check

1. Why parse tool arguments once at the end instead of per fragment?
2. Where must streamed tool-call assembly live so both paths share one tool loop?
3. On abort the generator returns; on disconnect it throws. What does each caller do?
4. What do you do with thinking text: show it, save it, send it back?

Answers: [self-check-answers.md](self-check-answers.md#day-16).

## Further reading

- MDN, [`AsyncGenerator`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/AsyncGenerator) · [`for await...of`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/for-await...of)
- Ollama, [Streaming](https://docs.ollama.com/capabilities/streaming) · [Thinking](https://docs.ollama.com/capabilities/thinking)

---
← [Day 15](day-15.md) · [Curriculum home](README.md) · Next: [Day 17 — Sessions on disk](day-17.md) →
