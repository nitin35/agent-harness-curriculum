# Day 21 — A Second Provider: the OpenAI-Compatible Dialect

**Phase:** Week 4 — Power & context · **Size:** one sitting

## By tonight

```
$ AH_PROVIDER=openai-compatible node src/cli/main.js
> Read the file package.json and tell me the package name.
  The file content shows the package.json with the name field set to "agent-harness".
agent> The package name is **agent-harness**.
```

It looks like any other run, and that's the point. The environment variable on the first line picks a different provider, so this conversation went over a different API, with different field names and a different stream format. The indented line is the model's reasoning, which this dialect sends as `delta.reasoning`, and the answer after `agent> ` arrived the same way it always has.

The **same** harness (loop, tools, sessions, approvals) now talks to any server that speaks the OpenAI Chat Completions dialect: Ollama's `/v1`, LM Studio, vLLM, llama.cpp's server, and many hosted APIs. You didn't touch the loop.

## Why it matters

Everything you've built since Day 8 has talked to the model through one interface: `chat()`, `chatStream()` and the `ChatResponse` they return. You've been told that this boundary keeps every provider's quirks inside `src/provider/`. Until there's a second provider, that's only a claim.

So today does two things. **First, it proves your seam.** If adding a provider needs changes above `src/provider/`, the boundary leaked, and today you find out. A leak usually looks harmless where it starts: a field name read in the loop, a check on a provider-specific error string in the UI. Each one means the next provider has to touch that code too.

**Second, it's where streamed tool calls get hard.** Ollama sends each call whole. OpenAI-style servers send a call's `arguments` as a **JSON string cut into fragments**, and only the first fragment carries the `id` and `name`. Day 16's assembler was built for this; today it earns its keep.

## Concepts

### 1. The dialect, side by side

Same ideas, different words. Day 7 called the wire a provider's private dialect. This is the second one, next to the first:

| | Ollama native (`/api/chat`) | OpenAI-compatible (`/v1/chat/completions`) |
|---|---|---|
| Stream framing | NDJSON | **SSE**: `data: {…}` lines, blank line between events, `data: [DONE]` at the end |
| Text | `message.content` | `choices[0].delta.content` |
| Reasoning | `message.thinking` | `delta.reasoning` (Ollama) or `delta.reasoning_content` (some servers) |
| Tool call | whole object, `arguments` is an **object** | fragments by `index`; `arguments` is a **string** |
| Tool result you send | `{ role: 'tool', tool_name, tool_call_id }` | `{ role: 'tool', tool_call_id }` |
| End reason | `done_reason` | `finish_reason` (`"tool_calls"`, `"stop"`, `"length"`) |
| Usage | `prompt_eval_count`, `eval_count` | `usage.prompt_tokens` / `completion_tokens` (stream: ask for `stream_options.include_usage`) |
| Context window | send `options.num_ctx` | **no standard field**: configure the server (for Ollama: `OLLAMA_CONTEXT_LENGTH=8192 ollama serve`) |
| Auth | none | `Authorization: Bearer <key>` (the key comes from an env var, never a file) |

Every row is something the new provider translates, in both directions, so nothing above it ever sees these names.

Here is the same tool pair in this dialect. Day 8's `toWireMessages` produced Ollama's shape. This provider's version turns the same two messages into:

```js run
[
  { role: 'assistant', content: '',
    tool_calls: [{ id: 'call_1', type: 'function',
                   function: { name: 'read', arguments: '{"path":"package.json"}' } }] },   // a STRING
  { role: 'tool', tool_call_id: 'call_1', content: '{"name":"agent-harness"}' },   // no tool_name
]
```

Two things changed: `arguments` became a JSON string (`JSON.stringify`), and the result is matched to its call by `tool_call_id` alone. Everything above `src/provider/` still sees the same `AgentMessage`s.

Your real captures: [`course-assets/captures/ollama-0.32/openai-compat-stream.sse`](course-assets/captures/ollama-0.32/openai-compat-stream.sse). Ollama's `/v1` actually sends the arguments string **whole**, so the fragmented case is tested with a hand-made fixture modelled on hosted APIs.

One row of the table hides two risks, because in this dialect you can't send `num_ctx`. (We measured both on Ollama 0.35.)
- If the server's window is smaller than you think, it **silently drops the front of the prompt** (Day 7) and reports a small `prompt_tokens`. A 26k-token prompt came back with `prompt_tokens: 4098` and an empty answer.
- With no `num_ctx` there is no output cap either, so a runaway generation never stops, until it hits the 300 s `fetch` timeout you met on Day 8.

So this provider defaults its window to a conservative **4096** (raise it only to match a server *you* configured) and sends **`max_tokens`** on every request. Detecting a cut prompt isn't this provider's job: on Day 24 the harness compares what it sent with the server's `prompt_tokens` after every call, for **every** provider (a cut prompt can happen on Ollama's native API too).

The table's first row is the one you'll write the most code for: a new stream format.

### 2. SSE framing

It's lines, again. SSE (*server-sent events*) is a text format for a stream of events, the same format a web page uses to receive live updates from a server, such as scores or a build log. Here is a small one from outside the harness, a football score feed:

```
: keep-alive

data: {"home": 1, "away": 0}

event: goal
data: {"team": "home", "minute": 23}

data: first line
data: second line

```

Each blank line ends one event, so this stream holds three. The line starting with `:` is a comment, which servers send now and then to keep a quiet connection open. The second event has a name, `goal`, set by its `event:` line; the others get the default name, `message`. And the last event has two `data:` lines, which join into one value with a newline between them.

Those are all the rules you need. `data:` lines accumulate; a **blank line** dispatches one event; lines starting with `:` are comments (keep-alives); line endings may be `\n`, `\r\n` or `\r`. Same rule as Day 4: decode incrementally, buffer partial lines, and act only on complete ones. `[DONE]` is not JSON; it's the end marker.

A stream that uses every rule, split across two chunks in an awkward place, and what the reference parser returns for each chunk:

```js
parser.push(encode(': keep-alive\r\ndata: {"a":1}\r\n\r\ndata: line one\ndata: li'))
// → [{ event: 'message', data: '{"a":1}' }]                 the comment is ignored; CRLF works
parser.push(encode('ne two\n\ndata: [DONE]\n\n'))
// → [{ event: 'message', data: 'line one\nline two' },      two data lines join with '\n'
//    { event: 'message', data: '[DONE]' }]
```

The half-finished `data: li` waited in the buffer until the second chunk completed it, exactly as a partial NDJSON line did on Day 4. Check for `[DONE]` *before* you parse: `JSON.parse('[DONE]')` throws `Unexpected token 'D', "[DONE]" is not valid JSON`.

Here is what a real `/v1` stream becomes. The course capture, fed through the reference provider, yields 68 `thinking_delta` events (from `delta.reasoning`), then one `tool_call_start` and one `tool_call_delta` for `bash`, then `done`. The arguments arrived as the string `'{"command":"ls /tmp/"}'` and come out as the object `{ command: 'ls /tmp/' }`.

That capture sent its tool call in one piece. Hosted servers don't, and that's the next concept.

### 3. Fragments keyed by `index`

Hosted servers cut a call into pieces. Each piece names the call it belongs to by its position, `index`. Only the first piece carries the `id` and the `name`:

```
delta.tool_calls: [{ index: 0, id: "call_A", function: { name: "read", arguments: "" } }]
delta.tool_calls: [{ index: 0, function: { arguments: "{\"pa" } }]
delta.tool_calls: [{ index: 1, id: "call_B", function: { name: "bash", arguments: "{\"comm" } }]   ← a second call, interleaved
delta.tool_calls: [{ index: 0, function: { arguments: "th\": \"src/a.js\"}" } }]
```

The key is `index`. The first time an index appears, `start` it (emitting `tool_call_start`); after that, `append` its fragments (`tool_call_delta`). At the end, `finish()` parses each call's string **once**.

Fed to the reference provider (with a fifth fragment that completes `call_B`), that stream yields:

```
tool_call_start call_A
tool_call_delta call_A  "{\"pa"
tool_call_start call_B
tool_call_delta call_B  "{\"comm"
tool_call_delta call_A  "th\": \"src/a.js\"}"
tool_call_delta call_B  "and\": \"ls\"}"
→ toolCalls: [{ id: 'call_A', name: 'read', arguments: { path: 'src/a.js' } },
              { id: 'call_B', name: 'bash', arguments: { command: 'ls' } }]
```

Keying by `id` would fail at the second line, which has no `id`. Parsing each piece would fail at once, because `{"pa` isn't JSON (Day 16).

This is exactly the case Day 16's `ToolCallAssembler` was designed for, and nothing in it changes: its `key` is now the `index`, where Ollama's provider used a key of its own. That's the seam working one level down.

With two providers that each translate their own dialect, the last piece is choosing between them.

### 4. A tiny provider factory

One function picks the provider. `createProvider({ provider: 'ollama' | 'openai-compatible', model, contextWindow, ollamaUrl, openai: { baseUrl, apiKeyEnv } })`. Today an env var picks the provider (`AH_PROVIDER`); on Day 26, settings do. Note that the API key is read from the environment variable **named** in settings. Settings files never hold secrets.

The indirection is the point. Settings say *where* the key is, and the key itself lives only in your environment:

```js
// in settings: { openai: { baseUrl: 'https://…/v1', apiKeyEnv: 'MY_KEY' } }
// in your shell: export MY_KEY=sk-…
createProvider({ provider: 'openai-compatible', openai: { apiKeyEnv: 'MY_KEY' }, env: process.env })
// → an OpenAICompatibleProvider whose apiKey is the value of $MY_KEY
```

A settings file can be committed, copied or shown in a bug report; an environment variable stays on your machine. An unknown name throws `unknown provider 'anthropic' (use 'ollama' or 'openai-compatible')`.

The factory, in `src/provider/index.js`, is the only code that knows more than one provider exists. Everything else receives "a provider" and calls the same methods on it, and the Check's `grep` confirms that no dialect names leak out of `src/provider/`.

## Build

### 21.1 `src/shared/sse.js` — Core

`class SseParser` with `push(chunk)` → `[{ event, data, id? }]` and `flush()`, plus `async function* readSse(stream)` with the same shape as `readNdjson`. Watch out for a `\r` at the very end of a chunk: it might be half of `\r\n`, so wait for the next chunk.

It's Day 4's `NdjsonParser` with a different line rule. Keep one `TextDecoder` and a text buffer, and cut complete lines off the front with a regex such as `/\r\n|\r|\n/`. Each line is either blank (dispatch the event collected so far), a comment (skip it), or `field: value`. Split at the first `:`, and drop a single space after it. `data` lines accumulate, and `event` and `id` set the event's name and id.

The trailing `\r` is Day 4's split character again, one level up. Suppose a chunk ends `data: line one\r` and the next begins `\ndata: line two\r\n\r\n`. A parser that treats the `\r` as a finished line reads the `\n` at the start of the next chunk as an empty line, and an empty line dispatches. We tried it: the naive parser returned two events, `line one` and `line two`, where the reference parser returns one event, `line one\nline two`. So a `\r` at the end of the buffer stays there until the next chunk shows what follows it.

### 21.2 `src/provider/openai-compatible.js` — Core

```js
export class OpenAICompatibleProvider {
  constructor({
    baseUrl = 'http://localhost:11434/v1',
    apiKey,
    model,
    contextWindow,
    fetch,
    onWarn,
  }) { … }
  // + max_tokens; stream_options.include_usage when streaming
  buildRequest(messages, tools, { stream }) { … }
  async chat(messages, tools, { signal }) { … }
  // SSE; fragments by index; [DONE]; abort → return
  async *chatStream(messages, tools, { signal }) { … }
  async listModels() { … }        // GET /models → data[].id
  // { contextLimit: contextWindow, maxContext: null } — be honest that you can't know
  async getModelInfo(name) { … }
  setModel(name) { … }
}
// arguments → JSON.stringify; tool_result → { role:'tool', tool_call_id }
export function toWireMessages(messages) { … }
```

Errors: 401/403 means the key was rejected; 404 means the model wasn't found; a refused connection names the base URL. Abort passes through untouched.

`chatStream` is Day 16's Ollama version with the SSE loop instead of NDJSON. For each event, stop at `[DONE]`, parse the JSON, read `choices[0].delta`, and route `reasoning`/`content`/`tool_calls`. Remember `finish_reason` and `usage` when they appear. The reference provider's messages for the three errors:

```
http://localhost:11434/v1 rejected the API key (HTTP 401)
Model 'qwen3.5:4b' not found at http://localhost:11434/v1 (…)
Cannot reach http://localhost:11434/v1 — is the server running?
```

The class has the same methods as `OllamaProvider`, and that's the whole contract: the loop, the commands and the UI call these and nothing else. Everything from Day 16 about abort carries over unchanged. An aborted stream returns quietly, and the loop turns that into `{ aborted: true }`.

### 21.3 `src/provider/index.js` and the CLI switch — Core

`createProvider(…)`; in `src/cli/main.js`, `createProvider({ provider: process.env.AH_PROVIDER ?? 'ollama' })`.

Apart from the framing helper in `src/shared/sse.js`, that one line in `main.js` is the only change outside `src/provider/` today. The loop, the tools, the sessions and the UI stay as they were.

### 21.4 Course tests — Core

Copy `course-tests/day-21/`. It covers:
- SSE framing (comments, CRLF, multi-line data, a final event with no blank line);
- the **real** Ollama `/v1` stream;
- the fragmented, interleaved stream (one start per call, four deltas, each parsed once, usage);
- the request shape including the Bearer header and `max_tokens`;
- `toWireMessages`; `chat()` with broken arguments;
- **the unchanged `AgentLoop` running on this provider**;
- an honest `getModelInfo`.

The test of the unchanged `AgentLoop` is the seam's proof. It runs the `AgentLoop` you already have on top of the new provider, and if it passes without edits to the loop, the boundary held. It's the test I'd most like to see pass today, because it checks a decision you made thirteen days ago.

### 21.5 Live, and a diff — Core

Run the same three questions with `AH_PROVIDER=ollama` and with `AH_PROVIDER=openai-compatible`. Note any differences in `notes/day-21.md`. Pay attention to the context window: through `/v1`, the server's default applies unless you started Ollama with `OLLAMA_CONTEXT_LENGTH`. Check `ollama ps`. Commit `day-21: openai-compatible provider`.

### 21.6 A hosted model — Stretch

If you have an API key for an OpenAI-compatible hosted service, point `baseUrl` at it, export the key, and set `openai.apiKeyEnv` to the variable's **name**. Run the Day 13 e2e suite against the real model (with your Wi-Fi on), and compare its tool-call reliability with the local model. Never commit the key.

## Check

Two dialects, one harness, and only `src/provider/` knows the difference. The new provider frames its stream as SSE, assembles tool calls from fragments keyed by `index` with the Day 16 assembler, and hands the loop the same `ChatResponse` as before, so the loop, the tools, the sessions and the approvals ran on it unchanged. You've also seen what this dialect can't do: it can't ask for a context window, so it defaults to a small one and caps every reply with `max_tokens`. And its API key lives in your environment, named but never stored by your settings.

Tomorrow, [Day 22](day-22.md) lets the harness grow without its core growing, through extensions, and starts with the question that matters most about them: whose code is allowed to run.

Before you move on, check:

- [ ] `node --test tests/course/day21-*` green (10 tests)
- [ ] The same session works with both providers
- [ ] `grep -rn "choices\|finish_reason" src --include='*.js' | grep -v provider/` prints nothing (the dialect stays in its file)
- [ ] Commit `day-21: openai-compatible provider`

Solution: `src/shared/sse.js` and `src/provider/openai-compatible.js`, `index.js` in [`solutions/checkpoint-3/`](solutions/checkpoint-3/).

## Stuck?

<details><summary>Arguments come out as <code>{}</code> with a parseError</summary>

You're parsing per fragment, or you lost a fragment because you keyed by `id` (only the first fragment has one). Key by `index`, append every fragment, and parse at the end.
</details>

<details><summary>The stream never ends</summary>

Break on `data: [DONE]`. Some servers omit it and just close the body, so treat a closed body with a `finish_reason` seen as done, and a closed body with neither as a disconnect.
</details>

<details><summary><code>Unexpected token 'D', "[DONE]" is not valid JSON</code></summary>

The end marker reached `JSON.parse`. Compare `ev.data === '[DONE]'` first, and stop there.
</details>

<details><summary><code>rejected the API key (HTTP 401)</code></summary>

The key didn't arrive. Check that `openai.apiKeyEnv` holds the variable's *name*, and that the variable is exported in the shell that starts the harness (`echo $MY_KEY`). Ollama's own `/v1` needs no key.
</details>

<details><summary>Answers come back empty, and <code>prompt_tokens</code> is about 4098</summary>

The server's window is smaller than your prompt, and it cut the front (concept 1). Through `/v1` you can't ask for more: start Ollama with `OLLAMA_CONTEXT_LENGTH=8192 ollama serve`, and set this provider's `contextWindow` to match.
</details>

## Common mistakes

- Looking for `id` on every fragment. Against Ollama's `/v1` every call arrives whole, with its `id`, so the mistake only shows up on a hosted server.
- Putting the API key in a settings file. It's the obvious place for configuration, and the file is the first thing that gets committed or pasted into a bug report.
- Assuming you can request a context window over `/v1`. You can't; trust the server's, and watch `prompt_tokens`. The native API taught you to send `num_ctx`, and nothing errors when the field you'd want doesn't exist.
- Omitting `max_tokens`, so a runaway generation runs until the `fetch` timeout. The Ollama provider has sent `num_predict` on every request since Day 8, so the cap was there without your thinking about it, and this dialect needs its own.

## Self-check

1. Name four differences between the two dialects that the provider must hide.
2. Why key streamed tool calls by `index` rather than by `id`?
3. Why can't this provider report the real context window, and what should it do instead?
4. What did you have to change outside `src/provider/` today? (The right answer is: almost nothing.)

Answers: [self-check-answers.md](self-check-answers.md#day-21).

## Further reading

- WHATWG, [Server-sent events: interpreting an event stream](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation) · MDN, [Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
- Ollama, [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)

---
← [Day 20](day-20.md) · [Curriculum home](README.md) · Next: [Day 22 — Extensions with a trust boundary](day-22.md) →
