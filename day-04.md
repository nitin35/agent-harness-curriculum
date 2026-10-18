# Day 4 — Streams and Bytes: Make It Stream ⚠

**Phase:** Week 1 — Hello, agent

## By tonight

```
you> what's the newest file in this folder?
agent> (dim) The user wants the newest file. I can use ls -t…        ← thinking, streamed live
  run `ls -t | head -1`? [y/N] y
The newest file is toy/main.mjs.                                     ← the answer, streamed token by token
```

No more waiting in silence. Text appears as the model produces it, and the model's **thinking** shows dimmed, so you can watch it reason before it answers. Big command output is now cut **safely**, at a character boundary, with a note telling the model what it missed. Along the way you write your first two real harness modules, `src/shared/ndjson.js` and `src/tools/truncate.js`, and you fix a bug you wrote yesterday without knowing it.

## Why it matters

Yesterday you made Ctrl+C work, so you can stop the toy whenever you like. Today you fix the other thing you probably wrote in your Day 1 notes: the wait. A model that thinks for 20 seconds before saying anything feels broken, even when it's working perfectly. The fix is **streaming**: asking the model to send its answer in small pieces as it writes them, and showing each piece the moment it arrives.

Streaming has a catch, and it's the real subject of today. The pieces arrive as **chunks of bytes that know nothing about lines or characters**. A chunk can end in the middle of a line, or even in the middle of a single character, and code that assumes otherwise works perfectly on English test data and breaks on the first `é`. Today you learn to put the pieces back together correctly. The same ideas also fix the `out.slice(0, 4000)` from Day 1, which can cut a character in half.

This is a heavier day, with three new ideas that build on each other. Generators give you a way to consume values that arrive over time. Bytes and characters explain why chunks are dangerous. NDJSON framing puts the two together. Take them in order, and run the examples as you go.

## Concepts

### 1. Iterators and generators

Before you can consume a stream, you need a way to talk about "values that come one at a time". JavaScript's answer is the iterator, and the easiest way to make one is a generator. Neither is async yet. Concept 2 adds the waiting.

**An iterator hands out values one at a time.** It is an object with a `next()` method, and each call returns `{ value, done }`. An *iterable* is anything that can give you an iterator, through a method stored under the special key `Symbol.iterator`. Arrays, strings, `Map`s and `Set`s are all iterable, which is why `for...of` (Day 2) works on them. This is what `for...of` does behind the scenes:

```js run
const it = ['a', 'b'][Symbol.iterator]();
it.next()             // → { value: 'a', done: false }
it.next()             // → { value: 'b', done: false }
it.next()             // → { value: undefined, done: true }
```

`for...of` calls `next()` until `done` is `true`. Spread (`[...x]`) and array destructuring use the same protocol.

**A generator writes an iterator for you.** A function declared with `function*` doesn't run its body when you call it. It returns a *generator object*. The body runs only when someone asks for the next value, and it pauses at each `yield`:

```js run
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

Read that as a conversation between two parties. Each `next()` call says "give me one more". The generator runs from where it last stopped up to its next `yield`, hands over that value, and freezes, with all its local variables intact, until it's asked again. A `for...of` loop makes the conversation visible:

```js run
function* producer() {
  for (let i = 1; i <= 2; i++) {
    console.log(`producer: making ${i}`);
    yield i;
  }
  console.log('producer: done');
}

for (const n of producer()) console.log(`consumer: got ${n}`);
// → producer: making 1
// → consumer: got 1
// → producer: making 2
// → consumer: got 2
// → producer: done
```

The two take turns, and the **consumer is in charge**. The producer never makes value 2 until the consumer has finished with value 1. This is called a *pull* model: values are pulled out by the consumer, not pushed at it. The pause should look familiar from Day 3. An `async` function pauses at `await` until a *promise* resumes it. A generator pauses at `yield` until its *consumer* resumes it.

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

Check the count before asking for the next value. If you check after, `take(3, source)` pulls a fourth value and throws it away. With a network stream, that's a read you didn't need.

**`yield*` passes on every value of another iterable.** `yield* [1, 2]` does the same as `yield 1;` followed by `yield 2;`. You'll use it in 4.2.

**Stopping early runs the generator's cleanup.** When a `for...of` loop ends early (a `break`, a `return` or an exception), it calls the generator's `return()` method. The paused `yield` then behaves like a `return` statement: the generator stops where it was, and its `finally` blocks run on the way out:

```js run
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

Every generator so far has had its next value ready the moment you asked. A stream doesn't.

### 2. Async generators and `for await`

The next piece of a model's answer may not have arrived yet, so we need a generator that can also *wait*.

**An async generator yields values over time.** An `async function*` combines the two kinds of pause you now know. It can `await` inside its body, which pauses it until a promise settles. And it can `yield`, which pauses it until the consumer asks for more. Because its values may not be ready yet, its `next()` returns a *promise* of `{ value, done }`, not the object itself:

```js run
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function* countdown(from) {
  for (let n = from; n > 0; n--) {
    await delay(10);
    yield n;
  }
}

const it = countdown(2);
const first = it.next();
console.log(first);                  // → Promise { <pending> }   not the value: it isn't ready yet
await first                          // → { value: 2, done: false }
await it.next()                      // → { value: 1, done: false }
await it.next()                      // → { value: undefined, done: true }
```

The first `next()` starts the generator and returns a pending promise at once. The generator runs until `await delay(10)`, and the promise fulfils with `{ value: 2, done: false }` only when it reaches `yield 2`. Each later `next()` resumes it from that `yield`.

**`for await...of` awaits each `next()` for you.** That's the whole job of `for await`. These two loops do the same thing:

```js
for await (const n of countdown(3)) {
  console.log(n);
}

const it = countdown(3);
while (true) {
  const { value, done } = await it.next();
  if (done) break;
  console.log(value);
}
```

Here's the friendly version running, half a second between values:

```js run
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function* countdown(from) {
  for (let n = from; n > 0; n--) {
    await delay(500);
    yield n;
  }
}

for await (const n of countdown(3)) console.log(n);   // 3, 2, 1, half a second apart
```

**While the generator waits, the event loop is free.** An `await` inside the generator pauses the generator and the loop that's consuming it, and nothing else. Timers, I/O and Ctrl+C handlers keep running in the meantime, exactly as Day 3 described:

```js run
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function* slowNumbers() {
  yield 1;
  await delay(100);
  yield 2;
}

setTimeout(() => console.log('timer: the event loop is free while the generator waits'), 50);
for await (const n of slowNumbers()) console.log('got', n);
// → got 1
// → timer: the event loop is free while the generator waits
// → got 2
```

That's what makes streaming compatible with yesterday's abort. While the toy waits for the next chunk of an answer, readline can still notice Ctrl+C.

**The rules from concept 1 still hold.** Nothing runs until the consumer asks, and the generator never runs ahead of the loop: while the loop body is busy with one value, the generator stays paused. An early `break` still runs the generator's `finally`, and `for await` waits for that cleanup to finish, even if the cleanup itself `await`s something, before the code after the loop runs. 4.1 has you prove it. And if the generator throws, the error comes out of the `for await` line, where an ordinary `try/catch` around the loop handles it.

Python contrast: Python's `async def` with `yield`, and `async for`, work the same way.

**This is the shape of a streaming reply.** A model's answer arrives as a series of pieces over several seconds, and an async generator turns that into something you consume with one loop. Today's `readNdjson(stream)` is an async generator: it yields each record from Ollama as soon as its line is complete, and the toy reads them with `for await`. Day 16's `chatStream` is one too.

What arrives in those pieces is bytes, though, and bytes are where streaming gets dangerous.

### 3. Bytes versus strings

The danger has nothing to do with async code. It's about the difference between the text you see and the bytes that carry it.

**Strings and bytes are different things.** Every character has a number in Unicode, its **code point**, written like `U+00E9` for `é`. A JavaScript string stores text as a sequence of 16-bit *code units* (UTF-16), and `length` counts those units, not characters. Files, pipes and sockets carry *bytes*, and text travels through them encoded as UTF-8, which uses 1 to 4 bytes per code point. In Node, a `Buffer` holds bytes. (`Buffer` is Node's subclass of `Uint8Array`, the standard byte array.)

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

**How UTF-8 lays out a character.** It helps to see the bytes in binary. The first byte of a character says how many bytes the character has, and every byte after it starts with the bits `10`:

| Character | Code point | UTF-8 bytes | In binary |
|---|---|---|---|
| `h` | U+0068 | `68` | `01101000` |
| `é` | U+00E9 | `c3 a9` | `11000011 10101001` |
| `→` | U+2192 | `e2 86 92` | `11100010 10000110 10010010` |
| `🙂` | U+1F642 | `f0 9f 99 82` | `11110000 10011111 10011001 10000010` |

A byte starting with `0` is a whole character on its own. A byte starting with `110`, `1110` or `11110` starts a character of 2, 3 or 4 bytes. A byte starting with `10` is a *continuation byte*, never the start of anything. Keep that last rule in mind: it's how you'll find a safe place to cut.

**A chunk can end in the middle of a character.** A stream delivers bytes in chunks of whatever size the network or the pipe chose, and the chunk boundaries know nothing about characters. Decode each chunk on its own, and a character that straddles two chunks turns into two `�` (U+FFFD, the *replacement character*):

```js
const bytes = Buffer.from('hé!');              // <Buffer 68 c3 a9 21>
const first = bytes.subarray(0, 2);            // 68 c3   ends halfway through é
const second = bytes.subarray(2);              // a9 21
first.toString() + second.toString()           // → 'h��!'
```

The first chunk ends with `c3`, a lead byte with nothing after it, so the decoder gives up on it and emits `�`. The second chunk starts with `a9`, a continuation byte with no lead byte before it, so it becomes a second `�`.

**A streaming decoder fixes it.** Use one `TextDecoder` for the whole stream, and pass `{ stream: true }` on every call. It holds back an unfinished character until the next chunk completes it:

```js
const decoder = new TextDecoder();
decoder.decode(first, { stream: true })        // → 'h'    c3 is held back, waiting for the rest of é
decoder.decode(second, { stream: true })       // → 'é!'
decoder.decode()                               // → ''     end of input: flush anything still held
```

The decoder can do this only because it's the *same* decoder for every chunk: it remembers the half character between calls. That's why it has to be one decoder per stream, created once, and never a new one per chunk.

Node has two families of streams, and today you use both. **Node streams**, such as `child.stdout`, deliver chunks as `'data'` events, as in Day 3's `runBash`. **Web streams**, such as a `fetch` response's `res.body`, are read with a reader (concept 4). For Node streams, `stream.setEncoding('utf8')` gives the stream its own streaming decoder, and its `'data'` events then deliver strings instead of `Buffer`s.

**`out += chunk` is a decoder per chunk in disguise.** When you add a `Buffer` to a string, JavaScript calls `toString()` on that one chunk, so a split character becomes `��`, exactly as above. Your Day 3 `runBash` does that, and 4.4 makes it fail in front of you.

**Budgets are in bytes, so measure and cut in bytes.** `String.prototype.slice` counts UTF-16 units, which makes it wrong in two ways. It can keep far more bytes than you meant, and it can cut an emoji in half:

```js
const s = 'é'.repeat(3000).slice(0, 4000);
s.length                                       // → 3000
Buffer.byteLength(s)                           // → 6000   a "4000" budget that kept 6000 bytes
'🙂🙂'.slice(0, 1)                             // → '\ud83d'   half an emoji, which prints as �
```

To measure, use `Buffer.byteLength(s)`. To cut, turn the text into bytes with `Buffer.from(s)`, take `buf.subarray(0, n)`, then **back up** to the start of a character. The table above makes that possible. Every byte that *continues* a character looks like `10xxxxxx` in binary (`0x80` to `0xBF`), and no character ever starts with one. So if the first byte you would drop is a continuation byte, its character began before the cut, and the cut must move left:

```js
const bytes = Buffer.from('héllo');            // <Buffer 68 c3 a9 6c 6c 6f>
let cut = 2;                                   // would keep 68 c3: half of é
while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--;
cut                                            // → 1
bytes.subarray(0, cut).toString()              // → 'h'
```

`bytes[cut] & 0xc0` keeps the top two bits of the byte, and `0x80` is `10` followed by zeros. So the test asks "does this byte start with `10`?". Here `bytes[2]` is `a9`, which does, so the cut moves left to 1, where `c3` starts a character. This loop is the heart of 4.3's `truncateText`.

Bytes become characters with a streaming decoder. Characters still have to become *messages*.

### 4. NDJSON framing

Any protocol that sends messages over a stream of bytes has to mark where each message ends, which is called **framing**. Some protocols put each message's length in front of it. Ollama uses the simplest scheme there is: a newline after each message.

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

```js run
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

Follow the parser's buffer through those three calls:

| Call | Buffer before | Text after decoding | Pieces after the split | Parsed | Buffer after |
|---|---|---|---|---|---|
| first `push` | `''` | `{"n":1}\n{"n"` | `{"n":1}`, `{"n"` | `{ n: 1 }` | `{"n"` |
| second `push` | `{"n"` | `{"n":2}\n` | `{"n":2}`, `''` | `{ n: 2 }` | `''` |
| `flush` | `''` | | | nothing | `''` |

The buffer always holds the start of a line that hasn't ended yet, and the newline is what moves text out of it. `flush()` is for the end of the body. If the last line had no newline after it, it is still sitting in the buffer, and `flush()` parses it.

**Reading a `ReadableStream`.** You read a web stream through a *reader*. Each `read()` returns a promise of `{ done, value }`, where `value` is the next chunk. When the stream has ended, `read()` fulfils with `done: true`:

```js
const reader = res.body.getReader();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  // value is a Uint8Array chunk: feed it to the parser
}
```

That `if (done) break` matters more than it looks. Once a stream has ended, every further `read()` fulfils at once with `done: true`. Without the `break`, the loop goes round forever, and since each `await` resumes as a microtask, it never lets a timer or Ctrl+C handler run. It's Day 3's microtask starvation, made by accident.

`readNdjson` wraps this loop in an async generator (concept 2), so the toy can write `for await (const chunk of readNdjson(res.body))`. If the consumer stops early, the generator's `finally` calls `reader.cancel()`. That tells `fetch` nobody will read the rest, so it can close the connection. The `finally` runs on every way out of the generator, including an error or an abort, so the stream is always cleaned up.

Framing handles input that arrives in pieces. The opposite problem is output too big to send at all.

### 5. The truncation contract

**Tool output has to fit.** A command can print megabytes, and everything a tool returns goes into the conversation, which must fit in the model's context window (Day 1). So the harness caps it. The README's [truncation contract](README.md#tool-output-truncation-contract) caps tool output at **32 KiB of UTF-8**, never splits a character, and ends with a marker that says what was cut and how to see more:

```
...[truncated: showing 32768 of 120004 bytes. Use read with offset/limit or a narrower command to see more.]
```

**The marker is for the model.** A silent cut would leave the model believing it had seen everything, and it would reason confidently from half the evidence. The marker says how much it didn't see, and what to do about it. This is 4.3's `truncateText` with a tiny budget:

```js
truncateText('héllo world', 5, { hint: 'Run a narrower command to see more.' })
// → { content: 'héll\n...[truncated: showing 5 of 12 bytes. Run a narrower command to see more.]',
//     truncated: true, byteLength: 12, shownBytes: 5 }

truncateText('héllo world', 2).shownBytes      // → 1   2 bytes would split é, so only 'h' is kept
```

The first call keeps `héll`: 5 bytes, because `é` takes two. The second call shows concept 3's backing-up loop at work.

**The advice at the end is a parameter.** The real harness has a `read` tool (Day 10), so that's the default. The toy has no `read` tool, so it passes its own advice. Never point the model at a tool it doesn't have: it will try to call it. (Day 11 adds a second mode for command output, which keeps the head *and* the tail.)

One last question about streams: what happens when data arrives faster than you can use it?

### 6. Backpressure (advanced)

**A stream produces only as fast as you read.** A `ReadableStream` sits between a *source*, which produces chunks, and you, the consumer. It keeps a small queue of chunks in between. When the queue is full, it stops asking its source for more, and it starts again when you `read()` and make room. This is **backpressure**: the consumer's pace pushes back on the producer. Over a network, TCP passes the same pressure back to the sender. So if you `await` each `read()`, a fast producer can't run far ahead of you: the stream waits.

It's the pull model from concept 1 again, with a small buffer in the middle. The consumer asks, and only then does the producer make more.

**So consume a response as it arrives.** `await res.text()` waits for the whole body and holds all of it in memory before you see a single character. For a model's reply, that's the 20-second silence streaming exists to fix. Never buffer a whole response "for convenience". Stretch 4.6 lets you watch backpressure happen.

## Build

The steps follow the concepts. First you try generators in a scratch file. Then you write the two modules the real harness keeps, the NDJSON parser and the truncator, with course tests to tell you when they're right. Then you find yesterday's bug, and finally you plug it all into the toy.

**Files today:** `scratch/generators.js`, `src/shared/ndjson.js`, `src/shared/constants.js`, `src/tools/truncate.js`, `scratch/split-utf8.mjs`, and the four toy modules.

### 4.1 Generators and cleanup — Core

In `scratch/generators.js`:

1. Write `take(n, iterable)` and an infinite `fib()`. Prove laziness with `[...take(10, fib())]`, and count how many values `fib()` actually produced.
2. Show that `break` in `for…of` stops early, and that `.forEach` can't.
3. Write `async function* ticks(n, ms)` that yields a timestamp every `ms` milliseconds. Consume it with `for await`, `break` after two ticks, and log inside a `finally` in the generator to prove the cleanup ran.

### 4.2 `src/shared/ndjson.js` — Core

This is your first real harness module: it lives in `src/`, not `toy/`, and you'll still be using it on Day 30. Write `NdjsonParser` first and get its tests passing, then wrap it in `readNdjson`. The parser has no async code at all, so it's much easier to test on its own. Its API:

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

They split a line in the middle, split `é` and `→` across chunks, feed one byte at a time, and check that `break` cancels the stream. The one-byte-at-a-time test is the harshest: every multi-byte character and every line is split, so a parser that passes it handles any chunking the network can produce.

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

Thread two callbacks, `onText` and `onThinking`, from the REPL down to the client. It's the same shape as yesterday's `signal`: the REPL decides what should happen, and every layer passes the decision down to the code that knows when it's time.

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

The toy now feels alive. It shows its thinking and its answer as they're written, and a long command can't flood the conversation. Underneath are the three ideas you'll keep using every time bytes arrive from somewhere else. Async generators let you consume values over time with one loop, while the event loop stays free. A streaming decoder turns bytes into text without breaking characters. Framing turns text into messages, keeping a partial line until its end arrives. You've also met your first real harness modules, and the course tests that prove them.

That closes the toy's main features. [Day 5](day-05.md) is about what happens when things go wrong: error classes, validating what comes in, and writing tests of your own.

Before you move on, check:

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

<details><summary>The toy freezes at 100% CPU after an answer, and Ctrl+C does nothing</summary>

Your reader loop is missing `if (done) break`. Once the stream has ended, every `read()` fulfils at once with `done: true`, so the loop spins forever, and because each `await` resumes as a microtask, no timer or Ctrl+C handler ever gets to run (concept 4). Kill the process from another terminal, and add the `break`.
</details>

<details><summary><code>SyntaxError: Unexpected strict mode reserved word</code> on a <code>yield</code></summary>

A `yield` sits inside a callback, as in `records.forEach((r) => { yield r; })`. `yield` only works directly in the body of the generator itself, not in a function nested inside it. Use `yield* records`, or a `for...of` loop around the `yield`.
</details>

<details><summary>Everything after the answer stays dim</summary>

A `DIM` was written without a matching `RESET`. Write `RESET` after every run, including an aborted one. To fix a terminal that's already dim, run `printf '\033[0m'`.
</details>

## Common mistakes

- Calling `JSON.parse` on every chunk ("a chunk is a line"). Chunk boundaries are chosen by the network, not by the sender, so it fails the moment a line spans two chunks. On a fast local connection each line often arrives in a chunk of its own, so the bug can hide for a long time.
- A new decoder per chunk. A decoder can complete a split character only if it saw the first half, so a fresh one per chunk corrupts exactly the characters your tests use. `out += chunk` on `Buffer`s is the same mistake in disguise. Plain ASCII decodes correctly chunk by chunk, so English-only tests never catch it.
- Budgeting bytes with `string.length`. `length` counts UTF-16 units, and one unit can stand for one, two or three bytes, so the budget is wrong for any text that isn't plain ASCII. For ASCII the two numbers are the same, which is why the mistake passes most tests.
- Reading tool calls from the final `done` chunk. Ollama sends each call once, in an earlier chunk, and doesn't repeat it at the end. The non-streaming reply has everything in one object, so it's natural to expect the last chunk to be that object.
- Calling `await res.text()` and splitting the result. It parses correctly, but nothing appears until the whole reply has arrived: that isn't streaming. With a short answer the delay is barely visible, so it can pass for streaming.
- Leaving out `if (done) break` in a reader loop. A finished stream answers every `read()` at once, so the loop never ends and never lets anything else run. A `for await` loop ends by itself, so a hand-written reader loop looks finished without the check.

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
