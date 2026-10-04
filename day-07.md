# Day 7 — Wire Formats and Message Schemas

**Phase:** Week 2 — Provider & tools

## By tonight

```
fixtures/
├── chat.json            non-streaming answer (with thinking)
├── stream.ndjson        streaming answer
├── chat-tools.json      a tool call
└── stream-tools.ndjson  streamed tool calls (two, in parallel)
```

You have captured exactly what Ollama sends, **seen the silent context truncation with your own eyes**, filled in the internal ↔ Ollama mapping table from those captures, and written `src/shared/message-schemas.js`, the one vocabulary the rest of the harness speaks.

## Why it matters

The toy used Ollama's field names everywhere (`tool_calls`, `function.arguments`, `role: 'tool'`). A real harness has **one internal vocabulary** and one small translator per provider, so swapping or adding a provider (Day 21) touches nothing else. You can only write that translator well if you know the wire *from evidence*. Docs lag behind servers: while this course was being built, the API reference said tool calls have no `id`, but a live server sends one.

## Concepts

### 1. The wire is a provider's private dialect

**"The wire" is what actually crosses the network.** When the harness talks to Ollama, it sends JSON over HTTP, and the field names in that JSON are Ollama's choice. Other servers make different choices for the same ideas: Day 21's OpenAI-compatible provider meets a second set. That JSON is the *wire format*, the provider's private dialect.

**Inside the harness, the vocabulary is fixed** ([message shapes](README.md#message-and-tool-shapes)):
- roles are `system`, `user`, `assistant` and `tool_result`;
- a tool call is `{ id, name, arguments }`, with `arguments` **always a plain object**;
- reasoning lives in `thinking`.

A short conversation in the harness's vocabulary looks like this:

```js
{ role: 'user', content: 'What files are in /tmp?' }
{ role: 'assistant', content: '',
  toolCalls: [{ id: 'call_1', name: 'bash', arguments: { command: 'ls /tmp' } }] }
{ role: 'tool_result', toolCallId: 'call_1', toolName: 'bash', content: 'a.txt\nb.txt', isError: false }
```

Ollama speaks its own dialect. Mapping between the two is the provider's job, and only the provider's.

**Why translate at the edge?** If wire names leak into the loop, the session file and the UI, then each of them has to know every provider's dialect, and adding a provider means changing all of them. Worse, many differences fail silently. Ollama sends a tool call's arguments as an object, but OpenAI-style servers send them as a JSON *string*. Code written for one reads the other wrongly, with no error at all:

```js
const args = '{"command":"ls"}';         // arguments, as an OpenAI-style server sends them
args.command                             // → undefined: no error, just a missing command
JSON.parse(args).command                 // → 'ls'
```

So the provider converts at the boundary, once, and everything past it can rely on one shape. Day 8 writes that translator for Ollama. Day 21 writes a second one, and nothing else changes. C++ contrast: it's the adapter pattern, converting a third-party library's structs into your own types at the edge of your code.

### 2. What Ollama actually sends

**Start from a real capture.** This is the course's `chat-tools.json`, trimmed (the thinking text is long):

```json
{
  "model": "qwen3.5:4b",
  "message": {
    "role": "assistant",
    "content": "",
    "thinking": "The user wants me to use the bash tool twice …",
    "tool_calls": [
      {
        "id": "call_tgzmiyhh",
        "function": { "index": 0, "name": "bash", "arguments": { "command": "ls -la /tmp" } }
      }
    ]
  },
  "done": true,
  "done_reason": "stop",
  "prompt_eval_count": 302,
  "eval_count": 178
}
```

Things to notice:
- the call's name and arguments sit inside `function`, and `arguments` is an **object**;
- the call has an `id`, even though the API reference said it wouldn't;
- `done_reason` is `"stop"`, even though the model called a tool. To know whether it did, look for `tool_calls`, not for a special reason;
- the prompt asked for two calls, and this time the model made one. Models don't always follow instructions about parallel calls.

From the captures in [`course-assets/captures/ollama-0.32/`](course-assets/captures/ollama-0.32/), re-checked against Ollama 0.35:

| Question | Ollama + `qwen3.5:4b` |
|---|---|
| Non-stream body | one JSON object: text at `message.content`, reasoning at `message.thinking`, then `done: true`, `done_reason`, `prompt_eval_count` and `eval_count` |
| Thinking | on by default for thinking models. Send `think: true/false` explicitly (some models take `"low"/"medium"/"high"`). A model *without* the thinking capability may reject `think: true`; Day 8 handles that |
| Tool calls | `message.tool_calls[]` = `{ id: "call_…", function: { index, name, arguments } }`. `arguments` is an **object** (OpenAI sends a JSON *string*) |
| Parallel calls | yes: several entries, each with its own `id` and `index` |
| Stream body | NDJSON (no `data:` prefixes): `done: false` chunks, then one `done: true` chunk |
| Streamed tool calls | **each call arrives whole in its own chunk; the final `done` chunk does not repeat them** |
| Tool result you send | `{ role: "tool", content, tool_name }`. Ollama also accepts `tool_call_id`, so send both |
| `content` alongside tool calls | usually empty; some models write a sentence first. Handle both |

The streamed capture, `stream-tools.ndjson`, shows the parallel case: 43 lines, with the two calls on lines 40 and 41, each whole in its own chunk, and a final `done` line that carries neither.

**The same conversation, on the wire.** Concept 1's three messages, as you'll send them back to Ollama in 7.3:

```json
{ "role": "user", "content": "What files are in /tmp?" }
{ "role": "assistant", "content": "", "tool_calls": [
  { "id": "call_1", "function": { "index": 0, "name": "bash", "arguments": { "command": "ls /tmp" } } }
] }
{ "role": "tool", "tool_name": "bash", "tool_call_id": "call_1", "content": "a.txt\nb.txt" }
```

Compare it with concept 1. `tool_result` became `tool`. The flat `{ id, name, arguments }` became `{ id, function: { index, name, arguments } }`. The names are `snake_case` instead of `camelCase`. And `isError` has no place on the wire: the model learns that a call failed only from the text of its result.

Older servers may leave out the `id`. The provider then **generates** one, because the harness needs ids to pair results with calls.

### 3. The context window you actually get

**A model reads a limited number of tokens.** A *token* is a piece of text, often part of a word; English averages roughly four characters per token. The *context window* is how many tokens the model can work with at once. The system prompt, the tool list, the whole conversation and the reply being written all share it.

**Three numbers, and they're not the same:**
- what the model *can* handle: `POST /api/show` reports it (`qwen35.context_length: 262144` for the course model);
- what the server is *running with*: `ollama ps` shows it in its `CONTEXT` column, and it's **4096** on most laptops unless you ask for more;
- what you *asked for*: `options.num_ctx` on the request.

**When a prompt doesn't fit, nothing fails.** Ollama answers **HTTP 200** and quietly drops the beginning of the prompt. That's where the system prompt and the tool list live, so the model answers a question it only half saw. You'll watch it happen in 7.4, where the model loses a secret it was given in the system prompt. The one visible sign is in the numbers: `prompt_eval_count`, the tokens the server actually read, comes back far smaller than the prompt you sent.

That's why every request sends `num_ctx` (Day 1's toy already did), why Day 8's provider budgets with the window you will *actually* get, `min(num_ctx, the model's maximum)`, and why Day 24 warns when `prompt_eval_count` looks too small.

### 4. JSDoc typedefs as the schema language

**A schema written as types.** `src/shared/message-schemas.js` contains no code at all, only JSDoc `@typedef`s: the shapes that every other module agrees on. `@typedef` and `@property` give you C-struct or Python-`TypedDict`-style shapes, written in comments that your editor checks. Here is one, `ToolCall`:

```js
/**
 * A tool call requested by the model.
 * @typedef {object} ToolCall
 * @property {string} id
 * @property {string} name
 * @property {Record<string, unknown>} arguments   always a plain object inside the harness
 * @property {string} [parseError]                  set when the wire arguments weren't valid JSON
 */
```

How to read it:
- Square brackets around a name, `[parseError]`, mark the property as optional.
- `Record<string, unknown>` means "an object with string keys, whose values you must check before you use them".
- A union of string literals, such as the `Role` type `'system'|'user'|'assistant'|'tool_result'`, says that a value must be exactly one of those strings (Day 6's union syntax).

**Other files import the types, not values.** They write `/** @typedef {import('./message-schemas.js').AgentMessage} AgentMessage */`. That line exists only for the type checker: Node never loads anything for it. The file ends with `export {};` to say plainly that it is a module. Without any `import` or `export`, TypeScript can read a file as a plain script and turn every typedef into a global name, visible everywhere without an import.

With `// @ts-check` at the top of a file, your editor holds objects to the shape:

```js
/** @type {ToolCall} */
const call = { id: 'call_1', name: 'bash' };
// ✗ Property 'arguments' is missing in type '{ id: string; name: string; }'
//   but required in type 'ToolCall'.
```

## Build

**Files today:** `fixtures/` (your captures), `scratch/long-prompt.mjs`, `notes/day-07.md` and `src/shared/message-schemas.js`.

### 7.1 Non-stream and stream captures — Core

```bash
curl -s http://localhost:11434/api/chat -d '{
  "model": "qwen3.5:4b", "stream": false, "options": {"num_ctx": 8192},
  "messages": [{"role": "user", "content": "What is 2+2? Answer in one word."}]
}' > fixtures/chat.json

curl -s http://localhost:11434/api/chat -d '{
  "model": "qwen3.5:4b", "stream": true, "think": false, "options": {"num_ctx": 8192},
  "messages": [{"role": "user", "content": "Say hello in exactly three words."}]
}' > fixtures/stream.ndjson
```

`-d` sends the text after it as the request body, which makes the request a `POST`. `-s` keeps curl quiet, and `>` saves the response to a file.

Inspect them with `head -1`, `tail -1` and `wc -l`. Where is the text? Where is the thinking? Which line has `done: true`? To read a long JSON file comfortably, pretty-print it: `python3 -m json.tool fixtures/chat.json`, or `node -p "JSON.stringify(require('./fixtures/chat.json'), null, 2)"`.

### 7.2 Tool-call captures — Core

Save this request as `fixtures/tools-request.json`:

```json
{
  "model": "qwen3.5:4b",
  "stream": false,
  "options": { "num_ctx": 8192 },
  "messages": [
    {
      "role": "user",
      "content": "What files are in /tmp and what is in /etc/hosts? Use the bash tool, two separate calls."
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "bash",
        "description": "Run a shell command and return stdout and stderr",
        "parameters": {
          "type": "object",
          "properties": { "command": { "type": "string", "description": "The command to run" } },
          "required": ["command"]
        }
      }
    }
  ]
}
```

`tools` is the same catalogue your toy has sent since Day 1: a name, a description and a JSON Schema for the arguments. The model reads it to decide what it may call.

```bash
curl -s http://localhost:11434/api/chat -d @fixtures/tools-request.json > fixtures/chat-tools.json
sed 's/"stream": false/"stream": true/' fixtures/tools-request.json > /tmp/stream-req.json
curl -s http://localhost:11434/api/chat -d @/tmp/stream-req.json > fixtures/stream-tools.ndjson
# Which lines carry tool calls? Is the last line one of them?
grep -n tool_calls fixtures/stream-tools.ndjson
```

`-d @file` reads the body from a file. The `sed` line makes a streaming copy of the same request.

Write down: is there an `id`? An `index`? Are `arguments` an object or a string? Did you get one call or two?

### 7.3 Round trip — Core

Send the conversation back with a tool result in it. Save this as `scratch/round-trip.json` and put in the `id` from your `chat-tools.json`. There is no `tools` list this time, so the model has to answer from the result:

```json
{
  "model": "qwen3.5:4b",
  "stream": false,
  "think": false,
  "options": { "num_ctx": 8192 },
  "messages": [
    { "role": "user", "content": "What files are in /tmp? Use the bash tool." },
    {
      "role": "assistant",
      "content": "",
      "tool_calls": [
        {
          "id": "call_PUT_YOUR_ID_HERE",
          "function": { "index": 0, "name": "bash", "arguments": { "command": "ls /tmp" } }
        }
      ]
    },
    {
      "role": "tool",
      "tool_name": "bash",
      "tool_call_id": "call_PUT_YOUR_ID_HERE",
      "content": "a.txt\nb.txt"
    }
  ]
}
```

`curl -s http://localhost:11434/api/chat -d @scratch/round-trip.json`. Does the answer mention `a.txt` and `b.txt`? Then try it once with only `tool_name` and once with only `tool_call_id`, and note whether either one alone is enough.

### 7.4 See the silent truncation — Core

1. `curl -s http://localhost:11434/api/show -d '{"model":"qwen3.5:4b"}' | grep context_length` shows the model's maximum.
2. Run a chat **without** `num_ctx`, then `ollama ps`. What does `CONTEXT` say?
3. Build a prompt of about 12k tokens with a secret in the **system** message. Create `scratch/long-prompt.mjs`:

   ```js
   // Writes two requests for the same ~12k-token prompt:
   // one with the server's default window, one asking for 16k.
   import fs from 'node:fs';

   const line = (i) => `Line ${i + 1}: the quick brown fox jumps over the lazy dog.`;
   const lines = Array.from({ length: 700 }, (_, i) => line(i)).join('\n');
   const request = (options) => ({
     model: 'qwen3.5:4b',
     stream: false,
     think: false,
     ...(options && { options }),
     messages: [
       {
         role: 'system',
         content: 'The secret code word is PELICAN-42. If asked for the code word, reply with it exactly.',
       },
       {
         role: 'user',
         content: `${lines}\n\nWhat is the secret code word? Reply with the code word only.`,
       },
     ],
   });
   fs.writeFileSync('scratch/long-default.json', JSON.stringify(request()));
   fs.writeFileSync('scratch/long-16k.json', JSON.stringify(request({ num_ctx: 16384 })));
   ```

   `...(options && { options })` adds an `options` field only when there are options. When `options` is `undefined`, the `&&` gives `undefined`, and spreading `undefined` into an object adds nothing. So the first request has no `options` at all, and the server uses its default window.

4. Run it, send each file, and compare `prompt_eval_count` and the answer:

   ```bash
   node scratch/long-prompt.mjs
   curl -s http://localhost:11434/api/chat -d @scratch/long-default.json
   curl -s http://localhost:11434/api/chat -d @scratch/long-16k.json
   ```

   To see the HTTP status as well, add `-w '\nHTTP %{http_code}\n'` to a `curl` command.

What we measured (Ollama 0.35, `qwen3.5:4b`, 16 GB Mac): without `num_ctx`, **HTTP 200**, `prompt_eval_count: 2050` and the answer `thequickbrownfoxjumpsoverthelazydog`. With `num_ctx: 16384`, `prompt_eval_count: 11847` and `PELICAN-42`. Record your numbers in `notes/day-07.md`. This is why your provider sends `num_ctx` on **every** request and budgets with the real window (Day 8).

### 7.5 Fill in the mapping table — Core

In `notes/day-07.md`, filled in **from your captures**:

| Internal (harness) | Ollama wire |
|---|---|
| roles `system` / `user` / `assistant` / `tool_result` | ? |
| assistant `toolCalls[] = { id, name, arguments }` | ? |
| assistant `thinking` | ? |
| tool result → which call it answers | ? (`tool_name`? `tool_call_id`?) |
| `arguments` plain object | ? (object or string?) |
| `usage = { promptTokens, completionTokens }` | ? |
| `finishReason` | ? |

Compare it with concept 2 and the [course captures](course-assets/captures/ollama-0.32/). **If yours disagree, yours win.** Note the difference in `docs/architecture.md`.

### 7.6 `src/shared/message-schemas.js` — Core

Typedefs only, no logic:
- `Role`, `ToolCall` (`id`, `name`, `arguments`, `parseError?`) and `Usage`;
- `AgentMessage`, `ToolSpec` (`name`, `description`, `parameters`: the provider's view of a tool), `ChatResponse`;
- `StreamEvent` (the five-variant union), `ModelInfo` and the `Provider` interface.

Copy the field names **exactly** from the README's [message shapes](README.md#message-and-tool-shapes). End the file with `export {};` so it is a module. Concept 4's `ToolCall` shows the format. `StreamEvent` is a union of five object types, written as `{A} | {B} | …` inside one `@typedef`. The `Provider` interface is a typedef whose properties are function types.

Then copy `course-tests/day-07/` and run `node --test tests/course/day07-*`. It checks that **your** captures have the shapes the provider will rely on. Commit `day-07: wire captures + message schemas`.

### 7.7 The OpenAI-compatible dialect — Stretch

Ollama also speaks OpenAI's format at `/v1/chat/completions`. Send the same tool request there with `"stream": true` and save it as `fixtures/openai-stream.sse`. Notice:
- the `data:` lines (SSE, not NDJSON);
- `arguments` sent as a **JSON string**;
- reasoning in `delta.reasoning`, `finish_reason: "tool_calls"`, and a final `data: [DONE]`.

Day 21 builds a provider for this dialect.

## Check

- [ ] The four fixtures are captured, and `node --test tests/course/day07-*` passes on **your** captures (or every deviation is documented)
- [ ] `notes/day-07.md`: the mapping table, the round-trip result and your silent-truncation numbers
- [ ] `src/shared/message-schemas.js` has every typedef from the README
- [ ] Commit `day-07: wire captures + message schemas`

Reference: [`course-assets/captures/ollama-0.32/`](course-assets/captures/ollama-0.32/) · `src/shared/message-schemas.js` in [`solutions/checkpoint-1/`](solutions/checkpoint-1/).

## Stuck?

<details><summary>A capture file is empty</summary>

`curl -s` hides errors, so a failed request leaves an empty file and no message. Run the same command with `-sS` instead of `-s` to see why: `Failed to connect to localhost port 11434` means Ollama isn't running (start it, or run `ollama serve`).
</details>

<details><summary>The capture contains <code>{"error":"model '…' not found"}</code></summary>

The model isn't installed under that name. Run `ollama pull qwen3.5:4b` (or check `ollama list` for the exact name), then capture again.
</details>

<details><summary>My model never produces two tool calls</summary>

That's fine: parallel calls are optional model behaviour. Note it. Your provider must still handle several calls, and the course tests check that it does.
</details>

<details><summary>I see <code>&lt;think&gt;…&lt;/think&gt;</code> inside <code>content</code></summary>

Your server or model isn't separating the reasoning out. Send `"think": true` explicitly and capture again. If it persists, note it: your provider would then need to strip the tags (a good Stretch).
</details>

<details><summary>The long prompt still gets the right answer without <code>num_ctx</code></summary>

Your machine runs a bigger default window (Ollama raises it on machines with lots of VRAM). Check `ollama ps`, then raise the line count in `long-prompt.mjs` until the prompt is clearly bigger than that window, and use a `num_ctx` that fits it.
</details>

<details><summary>The day-07 test fails on my capture</summary>

Read the assertion. If your server really does behave differently (for example, it sends string arguments), that's a finding: document it, and adjust the test, the provider, or both. Captures are the ground truth.
</details>

## Common mistakes

- Parsing the stream as SSE (looking for `data:`).
- Reading tool calls from the final `done` chunk.
- Deciding whether the model called a tool from `done_reason`. Ollama says `stop` either way; look for `tool_calls`.
- Letting wire names (`tool_calls`, `tool_name`, `done_reason`) leak past the provider into the rest of the harness.
- Trusting the API docs over your own captures.

## Self-check

1. In a non-stream response, where do the text and the reasoning live, and what marks the end?
2. How does NDJSON parsing differ from SSE parsing?
3. Which fields identify the call a tool result answers, on Ollama and on OpenAI-compatible APIs?
4. What did the silent-truncation experiment show, and what does your harness do about it?

Answers: [self-check-answers.md](self-check-answers.md#day-7).

## Further reading

- Ollama, [Chat API](https://docs.ollama.com/api/chat) · [Tool calling](https://docs.ollama.com/capabilities/tool-calling) · [Thinking](https://docs.ollama.com/capabilities/thinking) · [Context length](https://docs.ollama.com/context-length)
- MDN, [Server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events) (the format you'll meet on Day 21)
- TypeScript handbook, [`@typedef`, `@callback` and `@param`](https://www.typescriptlang.org/docs/handbook/jsdoc-supported-types.html#typedef-callback-and-param): the JSDoc tags today's schema file uses

---
← [Day 6](day-06.md) · [Curriculum home](README.md) · Next: [Day 8 — `OllamaProvider`](day-08.md) →
