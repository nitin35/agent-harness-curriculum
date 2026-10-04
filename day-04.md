# Day 4 — Streams and Bytes: Make It Stream ⚠

**Phase:** Week 1 — Hello, agent

## By tonight

```
you> what's the newest file in this folder?
agent> (dim) The user wants the newest file. I can use ls -t…        ← thinking, streamed live
  run `ls -t | head -1`? [y/N] y
The newest file is toy/main.mjs.                                     ← the answer, streamed token by token
```

Text appears as the model produces it, the model's **thinking** shows dimmed, and big command output is cut **safely**. You also write your first two real harness modules, `src/shared/ndjson.js` and `src/tools/truncate.js`, and fix a bug you wrote yesterday without knowing it.

## Why it matters

A model that thinks for 20 seconds before saying anything feels broken. Streaming fixes that, but streamed bytes arrive in **chunks that know nothing about lines or characters**. Today you learn to frame them correctly. You also fix the `out.slice(0, 4000)` from Day 1, which can cut a character in half.

This is a heavier day, with three new ideas that build on each other. Generators give you a way to consume values that arrive over time. Bytes and characters explain why chunks are dangerous. NDJSON framing puts the two together.

## Concepts

### 1. Iterators and generators

**An iterator hands out values one at a time.** It is an object with a `next()` method, and each call returns `{ value, done }`. An *iterable* is anything that can give you an iterator, through a method stored under the special key `Symbol.iterator`. Arrays, strings, `Map`s and `Set`s are all iterable, which is why `for...of` (Day 2) works on them. This is what `for...of` does behind the scenes:

```js
const it = ['a', 'b'][Symbol.iterator]();
it.next()             // → { value: 'a', done: false }
it.next()             // → { value: 'b', done: false }
it.next()             // → { value: undefined, done: true }
```

`for...of` calls `next()` until `done` is `true`. Spread (`[...x]`) and array destructuring use the same protocol.

**A generator writes an iterator for you.** A function declared with `function*` doesn't run its body when you call it. It returns a *generator object*. The body runs only when someone asks for the next value, and it pauses at each `yield`:

```js
function* count() {
  console.log('starting');
  yield 1;
  console.log('after 1');
  yield 2;
}

const g = count();    // nothing is printed: the body hasn't started
g.next()              // logs: starting   → { value: 1, done: false }
g.next()              // logs: after 1    → { value: 2, done: false }
g.next()              // → { value: undefined, done: true }
```

**Generators are lazy, so they can be infinite.** A generator does no work until it's asked, so a `while (true)` inside one is fine, as long as the consumer stops asking:

```js
function* naturals() {
  let n = 1;
  while (true) yield n++;
}
```

To take a few values from it, write a generator that passes values through and stops after `n` of them:

```js
function* take(n, iterable) {
  if (n <= 0) return;
  for (const x of iterable) {
    yield x;
    if (--n === 0) return;   // stop *before* pulling one more value from the source
  }
}

[...take(3, naturals())]     // → [1, 2, 3]
```

Check the count before asking for the next value. If you check after, `take(3, source)` pulls a fourth value and throws it away; with a network stream, that is a read you didn't need.

**`yield*` passes on every value of another iterable.** `yield* [1, 2]` does the same as `yield 1;` followed by `yield 2;`. You'll use it in 4.2.

**Stopping early runs the generator's cleanup.** When a `for...of` loop ends early (a `break`, a `return` or an exception), it calls the generator's `return()` method. The generator stops where it paused, and its `finally` blocks run:

```js
function* lines() {
  try {
    yield 'first';
    yield 'second';
  } finally {
    console.log('cleanup');  // runs even though the consumer stopped early
  }
}

for (const line of lines()) {
  console.log(line);
  break;
}
// → first
// → cleanup
```

That `finally` is your cleanup hook. In concept 4 it closes a network stream when the reader stops early.

Python contrast: this is nearly identical to Python generators, down to `yield`, laziness and `yield from` (JavaScript's `yield*`). JavaScript's `return()` plays the part of Python's `close()`.

### 2. Async generators and `for await`

**An async generator yields values over time.** An `async function*` can `await` inside its body and `yield` values as they become ready. Each `next()` call returns a promise, and `for await...of` awaits each one for you:

```js
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function* countdown(from) {
  for (let n = from; n > 0; n--) {
    await delay(500);
    yield n;
  }
}

for await (const n of countdown(3)) console.log(n);   // 3, 2, 1, half a second apart
```

The rules from concept 1 still hold. Nothing runs until the consumer asks, and an early `break` still runs the generator's `finally`. 4.1 has you prove it.

**This is the shape of a streaming reply.** A model's answer arrives as a series of pieces over several seconds, and an async generator turns that into something you consume with one loop. Today's `readNdjson(stream)` is an async generator: it yields each record from Ollama as soon as its line is complete, and the toy reads them with `for await`. Day 16's `chatStream` is one too.

### 3. Bytes versus strings

**Strings and bytes are different things.** A JavaScript string is a sequence of UTF-16 *code units*, and `length` counts those units. Files, pipes and sockets carry *bytes*, and text travels through them encoded as UTF-8, which uses 1 to 4 bytes per character. In Node, a `Buffer` holds bytes. (`Buffer` is Node's subclass of `Uint8Array`, the standard byte array.)

```js
'é'.length                     // → 1
Buffer.byteLength('é')         // → 2
Buffer.from('é')               // → <Buffer c3 a9>
'→'.length                     // → 1
Buffer.byteLength('→')         // → 3
'🙂'.length                    // → 2   one character, but two UTF-16 units
Buffer.byteLength('🙂')        // → 4
```

ASCII characters take 1 byte each, so English text hides the difference. Accents, arrows, CJK text and emoji don't.

Python contrast: Python 3 also keeps `str` and `bytes` apart, but `len('🙂')` is 1 in Python, because it counts code points. C++ contrast: a JavaScript string is closer to a `std::u16string` than to a `std::string` of UTF-8 bytes.

**A chunk can end in the middle of a character.** A stream delivers bytes in chunks of whatever size the network or the pipe chose, and the chunk boundaries know nothing about characters. Decode each chunk on its own, and a character that straddles two chunks turns into two `�` (U+FFFD, the *replacement character*):

```js
const bytes = Buffer.from('hé!');              // <Buffer 68 c3 a9 21>
const first = bytes.subarray(0, 2);            // 68 c3   ends halfway through é
const second = bytes.subarray(2);              // a9 21
first.toString() + second.toString()           // → 'h��!'
```

**A streaming decoder fixes it.** Use one `TextDecoder` for the whole stream, and pass `{ stream: true }` on every call. It holds back an unfinished character until the next chunk completes it:

```js
const decoder = new TextDecoder();
decoder.decode(first, { stream: true })        // → 'h'    c3 is held back, waiting for the rest of é
decoder.decode(second, { stream: true })       // → 'é!'
decoder.decode()                               // → ''     end of input: flush anything still held
```

Node's own streams can do this for you: `stream.setEncoding('utf8')` gives the stream its own streaming decoder, and its `'data'` events deliver strings instead of `Buffer`s.

**`out += chunk` is a decoder per chunk in disguise.** When you add a `Buffer` to a string, JavaScript calls `toString()` on that one chunk, so a split character becomes `��`, exactly as above. Your Day 3 `runBash` does that, and 4.4 makes it fail in front of you.

**Budgets are in bytes, so measure and cut in bytes.** `String.prototype.slice` counts UTF-16 units, which makes it wrong in two ways. It can keep far more bytes than you meant, and it can cut an emoji in half:

```js
const s = 'é'.repeat(3000).slice(0, 4000);
s.length                                       // → 3000
Buffer.byteLength(s)                           // → 6000   a "4000" budget that kept 6000 bytes
'🙂🙂'.slice(0, 1)                             // → '\ud83d'   half an emoji, which prints as �
```

To measure, use `Buffer.byteLength(s)`. To cut, turn the text into bytes with `Buffer.from(s)`, take `buf.subarray(0, n)`, then **back up** to the start of a character. UTF-8 makes that possible. Every byte that *continues* a character looks like `10xxxxxx` in binary (`0x80` to `0xBF`), and no character ever starts with one. So if the first byte you would drop is a continuation byte, its character began before the cut, and the cut must move left:

```js
const bytes = Buffer.from('héllo');            // <Buffer 68 c3 a9 6c 6c 6f>
let cut = 2;                                   // would keep 68 c3: half of é
while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--;
cut                                            // → 1
bytes.subarray(0, cut).toString()              // → 'h'
```

`bytes[cut] & 0xc0` keeps the top two bits of the byte, and `0x80` is `10` followed by zeros. This loop is the heart of 4.3's `truncateText`.

### 4. NDJSON framing

**With `stream: true`, Ollama answers with NDJSON**: *newline-delimited JSON*, one complete JSON object per line.

```
{"message":{"role":"assistant","content":"","thinking":"The"},"done":false}
{"message":{"role":"assistant","content":"","thinking":" user"},"done":false}
…
{"message":{"role":"assistant","content":"","tool_calls":[{"id":"call_ilgg65b6","function":{"index":0,"name":"bash","arguments":{"command":"ls -la /tmp"}}}]},"done":false}
{"message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","prompt_eval_count":302,"eval_count":106}
```

That is a real capture: [`course-assets/captures/ollama-0.32/stream-tools.ndjson`](course-assets/captures/ollama-0.32/stream-tools.ndjson). Notice two things:
- each tool call arrives **whole, in its own chunk**;
- **the final `done` chunk does not repeat the tool calls**, so you must collect them as they pass.

**The network doesn't send lines.** `response.body` is a `ReadableStream` of `Uint8Array` chunks of *any* size. One chunk can hold three lines and the start of a fourth. Another can end in the middle of a line, or in the middle of a character (concept 3). So `JSON.parse` on a chunk fails as soon as a line is split:

```js
JSON.parse('{"n"')
// SyntaxError: Expected ':' after property name in JSON at position 4 (line 1 column 5)
```

The rule: **decode incrementally, keep the partial line in a buffer, and `JSON.parse` complete lines only.** Splitting on `'\n'` does most of the work. Every piece except the last is a complete line. The last piece is whatever came after the final newline: the start of a line that hasn't finished arriving, or `''` if the chunk ended exactly on a newline:

```js
'{"n":1}\n{"n"'.split('\n')      // → ['{"n":1}', '{"n"']   the last piece is a partial line
'{"n":1}\n'.split('\n')          // → ['{"n":1}', '']        the chunk ended on a newline
```

So parse every piece but the last, and keep the last one as the start of the next line. That is what 4.2's `NdjsonParser` does:

```js
const encode = (s) => new TextEncoder().encode(s);   // a string's UTF-8 bytes, as a Uint8Array
const parser = new NdjsonParser();
parser.push(encode('{"n":1}\n{"n"'))                // → [{ n: 1 }]   the second line isn't complete yet
parser.push(encode(':2}\n'))                        // → [{ n: 2 }]
parser.flush()                                      // → []           nothing left over
```

`flush()` is for the end of the body. If the last line had no newline after it, it is still sitting in the buffer, and `flush()` parses it.

**Reading a `ReadableStream`.** You read a web stream through a *reader*. Each `read()` returns a promise of `{ done, value }`, where `value` is the next chunk:

```js
const reader = res.body.getReader();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  // value is a Uint8Array chunk: feed it to the parser
}
```

`readNdjson` wraps this loop in an async generator (concept 2), so the toy can write `for await (const chunk of readNdjson(res.body))`. If the consumer stops early, the generator's `finally` calls `reader.cancel()`. That tells `fetch` nobody will read the rest, so it can close the connection.

### 5. The truncation contract

**Tool output has to fit.** A command can print megabytes, and everything a tool returns goes into the conversation, which must fit in the model's context window (Day 1). So the harness caps it. The README's [truncation contract](README.md#tool-output-truncation-contract) caps tool output at **32 KiB of UTF-8**, never splits a character, and ends with a marker that says what was cut and how to see more:

```
...[truncated: showing 32768 of 120004 bytes. Use read with offset/limit or a narrower command to see more.]
```

**The marker is for the model.** A silent cut would leave the model believing it had seen everything. The marker says how much it didn't see, and what to do about it. This is 4.3's `truncateText` with a tiny budget:

```js
truncateText('héllo world', 5, { hint: 'Run a narrower command to see more.' })
// → { content: 'héll\n...[truncated: showing 5 of 12 bytes. Run a narrower command to see more.]',
//     truncated: true, byteLength: 12, shownBytes: 5 }

truncateText('héllo world', 2).shownBytes      // → 1   2 bytes would split é, so only 'h' is kept
```

**The advice at the end is a parameter.** The real harness has a `read` tool (Day 10), so that's the default. The toy has no `read` tool, so it passes its own advice. Never point the model at a tool it doesn't have. (Day 11 adds a second mode for command output, which keeps the head *and* the tail.)

### 6. Backpressure (advanced)

**A stream produces only as fast as you read.** A `ReadableStream` keeps a small queue. When the queue is full, it stops asking its source for more, and it starts again when you `read()`. Over a network, TCP passes the same pressure back to the sender. So if you `await` each `read()`, a fast producer can't run far ahead of you: the stream waits.

**So consume a response as it arrives.** `await res.text()` waits for the whole body and holds all of it in memory before you see a single character. For a model's reply, that's the 20-second silence streaming exists to fix. Never buffer a whole response "for convenience". Stretch 4.6 lets you watch backpressure happen.

## Build

**Files today:** `scratch/generators.js`, `src/shared/ndjson.js`, `src/shared/constants.js`, `src/tools/truncate.js`, `scratch/split-utf8.mjs`, and the four toy modules.

### 4.1 Generators and cleanup — Core

In `scratch/generators.js`:

1. Write `take(n, iterable)` and an infinite `fib()`. Prove laziness with `[...take(10, fib())]`, and count how many values `fib()` actually produced.
2. Show that `break` in `for…of` stops early, and that `.forEach` can't.
3. Write `async function* ticks(n, ms)` that yields a timestamp every `ms` milliseconds. Consume it with `for await`, `break` after two ticks, and log inside a `finally` in the generator to prove the cleanup ran.

### 4.2 `src/shared/ndjson.js` — Core

This is your first real harness module. Its API:

```js
export class NdjsonParser {
  /**
   * @param {Uint8Array} chunk
   * @returns {unknown[]} every record whose line just completed
   */
  push(chunk) { … }

  /** @returns {unknown[]} the trailing record if the body had no final newline, else [] */
  flush() { … }
}

/**
 * A getReader() loop; cancel the reader in finally.
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {AsyncGenerator<unknown>}
 */
export async function* readNdjson(stream) { … }
```

Some hints:
- **`push`:** keep a private `#buffer` string and one `#decoder = new TextDecoder()`. Append `decoder.decode(chunk, { stream: true })`, split on `'\n'`, keep the last piece as the new buffer, and parse the rest (skipping blank lines).
- **`flush`:** call `decode()` with no argument to empty the decoder, then parse whatever is left in the buffer, if it isn't blank.
- **`readNdjson`:** wrap concept 4's reader loop in `try/finally`. `yield*` the records each `push(value)` returns, and `yield*` what `flush()` returns once the stream is done. Cancel the reader in the `finally`.

Copy the course tests and make them pass:

```bash
cp ../agent-harness-curriculum/course-tests/day-04/*.test.js tests/course/
node --test tests/course/day04-ndjson.test.js
```

They split a line in the middle, split `é` and `→` across chunks, feed one byte at a time, and check that `break` cancels the stream.

### 4.3 `src/tools/truncate.js` — Core

First create `src/shared/constants.js`. You'll add to it all course. Each default lives in one place, so changing it means changing one line:

```js
export const DEFAULT_MODEL = 'qwen3.5:4b';
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
export const DEFAULT_CONTEXT_WINDOW = 8192;   // sent as num_ctx on every request
export const TRUNCATE_MAX_BYTES = 32 * 1024;
export const FILE_REF_MAX_BYTES = 50 * 1024;  // @file attachments (Day 28)
export const DEFAULT_MAX_TURNS = 20;
```

Then write `truncateText(text, maxBytes = TRUNCATE_MAX_BYTES, { hint } = {})`, returning `{ content, truncated, byteLength, shownBytes }`:
- Short text passes through untouched.
- Long text becomes the longest whole-character prefix of at most `maxBytes` bytes, then a newline, then the marker.
- `hint` defaults to `'Use read with offset/limit or a narrower command to see more.'`.

Measure and cut as concept 3 does: `Buffer.from(text)`, back up from `maxBytes` to a character boundary, and decode the kept bytes with `.toString('utf8')`. The marker's two numbers are the bytes you kept and the text's total bytes.

`node --test tests/course/day04-truncate.test.js` must pass, including the 3- and 4-byte character cases.

### 4.4 Find the bug you wrote on Day 3 — Core

Your `runBash` does `out += chunk`. Each `chunk` is a `Buffer`, and `+=` turns each one into a string *on its own*: a fresh decoder per chunk, exactly what concept 3 warns about. Prove it. Create `scratch/split-utf8.mjs`:

```js
// Writes "hé!" with the two bytes of "é" in separate chunks, 100 ms apart.
process.stdout.write(Buffer.from([0x68, 0xc3]));
setTimeout(() => process.stdout.write(Buffer.from([0xa9, 0x21])), 100);
```

Then run it through your tool:

```bash
node --input-type=module -e "
  import { runBash } from './toy/bash-tool.mjs';
  console.log(await runBash('node scratch/split-utf8.mjs'));
"
```

You get `h��!`. Fix it with two lines before the `'data'` handlers, `child.stdout.setEncoding('utf8')` and `child.stderr.setEncoding('utf8')`, then run the command again. Why does each stream need its own decoder? Write the answer in your notes.

### 4.5 Stream the toy — Core

Thread two callbacks, `onText` and `onThinking`, from the REPL down to the client.

**1. `toy/ollama.mjs`:** `chat(messages, tools, { signal, onText = () => {}, onThinking = () => {} } = {})` streams, and still returns the whole reply at the end. Ask for thinking, but not every model can think: a model without that capability answers HTTP 400 `"<model>" does not support thinking`. Keep a `let think = true` next to the client's other settings (in the closure), and turn it off for good the first time you hear that:

```js
const post = () => fetch(`${url}/api/chat`, {
  method: 'POST',
  signal,
  body: JSON.stringify({ model, messages, tools, stream: true, think, options: { num_ctx: numCtx } }),
});
let res = await post();
if (!res.ok && think) {
  const text = await res.text();
  if (!/does not support thinking/.test(text)) {
    throw new Error(`Ollama answered ${res.status}: ${text}`);
  }
  think = false;                       // this model can't think: stop asking, and ask again
  res = await post();
}
if (!res.ok) throw new Error(`Ollama answered ${res.status}: ${await res.text()}`);

const reply = { role: 'assistant', content: '', thinking: '', tool_calls: [] };
for await (const chunk of readNdjson(res.body)) {
  const m = chunk.message ?? {};
  if (m.thinking) {
    reply.thinking += m.thinking;
    onThinking(m.thinking);
  }
  if (m.content) {
    reply.content += m.content;
    onText(m.content);
  }
  if (m.tool_calls) reply.tool_calls.push(...m.tool_calls);   // collect as they pass!
}
return reply;
```

How it works:
- **`post` is a function,** so the same request can be sent twice: once with `think: true`, and again without it if the model can't think. Because `think` lives in the closure, the client remembers the answer for every later request.
- **A response body can be read only once.** That's why the 400's text is read into `text` and reused for the error message.
- **Every piece is used twice.** It is passed to `onThinking` or `onText` at once, so the screen updates, and added to `reply`, so the history still gets one whole assistant message at the end.

**2. `toy/loop.mjs`:** accept `onText` and `onThinking` in `runTurns`'s options and pass them on: `client.chat(messages, [bashToolSpec], { signal, onText, onThinking })`.

**3. `toy/main.mjs`:** print `agent> ` before the run, thinking dimmed and the answer normally. Switch styles when the stream changes from thinking to text, and stop printing `result.text` at the end, because it has already streamed:

```js
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
let thinking = false;
output.write('\nagent> ');
const result = await runTurns({
  client, messages, confirm, signal: controller.signal,
  onThinking: (s) => {
    if (!thinking) {
      thinking = true;
      output.write(DIM);
    }
    output.write(s);
  },
  onText: (s) => {
    if (thinking) {
      thinking = false;
      output.write(`${RESET}\n`);
    }
    output.write(s);
  },
});
output.write(RESET);
if (result.aborted) output.write('\n(aborted)');
```

`DIM` and `RESET` are *escape sequences*: bytes that start with the escape character (`\x1b`) and that the terminal reads as commands, not as text to show. `\x1b[2m` switches to dim text and `\x1b[0m` switches every style off. Writing `RESET` after the run, aborted or not, means the next prompt is never left dim. (On Day 27 you'll meet escape sequences again, from an attacker's side.)

**4. `toy/bash-tool.mjs`:** replace `out.slice(0, 4000)` with `truncateText(out, 4000, { hint: 'Run a narrower command to see more.' }).content`.

Now ask something that needs a tool and watch it stream. Run `node --test tests/course/*.test.js` one last time (all of Days 3 and 4), then commit `day-04: streaming toy + ndjson + truncate`.

### 4.6 Backpressure demo — Stretch

Build a `ReadableStream` with a `pull()` producer that counts what it has made, and a consumer that reads one chunk every 50 ms. Print produced against consumed. The producer stays just ahead of the consumer, because the stream only pulls when you read.

## Check

- [ ] `node --test tests/course/*.test.js` passes 26 tests: Day 3's 9, plus ndjson (8), truncate (7) and toy-bash (2)
- [ ] The toy streams thinking (dimmed) and the answer live, and still runs tools
- [ ] `runBash` decodes with `setEncoding`, and cuts output with `truncateText`, never `slice`
- [ ] Commit `day-04: streaming toy + ndjson + truncate`

Solution: [`solutions/toy/`](solutions/toy/), and `src/shared/ndjson.js` and `src/tools/truncate.js` in [`solutions/checkpoint-1/`](solutions/checkpoint-1/).

## Stuck?

<details><summary>My parser throws a <code>SyntaxError</code> from <code>JSON.parse</code></summary>

The message depends on where the line was cut: `Unterminated string in JSON`, `Unexpected end of JSON input`, `Expected ',' or '}' after property value`, and others. Whichever it is, you're parsing a partial line. Parse only the pieces *before* the last `\n`; the last piece goes back into the buffer.
</details>

<details><summary>The multi-byte test shows <code>�</code></summary>

Use **one** `TextDecoder` for the whole stream and pass `{ stream: true }` to every `decode(chunk, …)` call. In `flush()`, call `decode()` with no argument to empty it.
</details>

<details><summary>truncate: <code>shownBytes</code> is right, but the prefix has a broken character</summary>

After `subarray(0, cut)`, back up: `while (cut > 0 && (bytes[cut] & 0xC0) === 0x80) cut--`. Check the byte **at** `cut`, the first byte you are dropping. If it is a continuation byte, the character it belongs to started before the cut.
</details>

<details><summary>Tool calls disappeared after I switched to streaming</summary>

You read them from the final `done` chunk. Ollama sends each one in an earlier chunk, so collect them as they arrive.
</details>

<details><summary>Nothing prints until the answer is complete</summary>

Check that `runTurns` passes `onText` and `onThinking` through to `client.chat`, and that the request says `stream: true`.
</details>

<details><summary><code>Ollama answered 400: "…" does not support thinking</code></summary>

The model has no thinking capability, and your client asked for it. Add the retry from 4.5: on that 400, set `think = false` and send the request again.
</details>

<details><summary><code>TypeError: Body is unusable: Body has already been read</code></summary>

A response body can be read only once. You probably called `await res.text()` twice: once to check the 400, then again for the error message. Read it once into a variable, as 4.5 does.
</details>

<details><summary>Everything after the answer stays dim</summary>

A `DIM` was written without a matching `RESET`. Write `RESET` after every run, including an aborted one. To fix a terminal that's already dim, run `printf '\033[0m'`.
</details>

## Common mistakes

- Calling `JSON.parse` on every chunk ("a chunk is a line"). It fails the moment a line spans two chunks.
- A new decoder per chunk, which corrupts exactly the characters your tests use. `out += chunk` on `Buffer`s is the same mistake in disguise.
- Budgeting bytes with `string.length`.
- Reading tool calls from the final `done` chunk, where Ollama doesn't repeat them.
- Calling `await res.text()` and splitting the result. It parses correctly, but nothing appears until the whole reply has arrived: that isn't streaming.

## Self-check

1. Why can't you `JSON.parse` each chunk of an NDJSON stream?
2. Why does `String.prototype.slice` break a byte budget?
3. What does `{ stream: true }` on `TextDecoder.decode` do at a chunk boundary, and what did `out += chunk` do instead?
4. Where do streamed tool calls appear, and why does that matter?

Answers: [self-check-answers.md](self-check-answers.md#day-4).

## Further reading

- javascript.info, [Generators](https://javascript.info/generators) · [Async iteration and generators](https://javascript.info/async-iterators-generators): patient, beginner-friendly chapters with exercises
- Joel Spolsky, [The Absolute Minimum Every Software Developer Absolutely, Positively Must Know About Unicode and Character Sets](https://www.joelonsoftware.com/2003/10/08/the-absolute-minimum-every-software-developer-absolutely-positively-must-know-about-unicode-and-character-sets-no-excuses/): the classic introduction to bytes, characters and encodings
- MDN, [Iterators and generators](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Iterators_and_generators) · [`for await…of`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/for-await...of)
- MDN, [Using readable streams](https://developer.mozilla.org/en-US/docs/Web/API/Streams_API/Using_readable_streams) · [Streams concepts](https://developer.mozilla.org/en-US/docs/Web/API/Streams_API/Concepts) (chunks, queues and backpressure) · [`TextDecoder`](https://developer.mozilla.org/en-US/docs/Web/API/TextDecoder)
- Node.js, [`Buffer`](https://nodejs.org/api/buffer.html) · [`readable.setEncoding`](https://nodejs.org/api/stream.html#readablesetencodingencoding) · [NDJSON spec](https://github.com/ndjson/ndjson-spec)
- Ollama, [Streaming](https://docs.ollama.com/capabilities/streaming) · [Thinking](https://docs.ollama.com/capabilities/thinking)
- Wikipedia, [ANSI escape code](https://en.wikipedia.org/wiki/ANSI_escape_code): what `\x1b[2m` and its relatives mean

---
← [Day 3](day-03.md) · [Curriculum home](README.md) · Next: [Day 5 — Errors, validation and tests](day-05.md) →
