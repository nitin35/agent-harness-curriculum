# Day 5 — Errors, Validation and Tests

**Phase:** Week 1 — Hello, agent

## By tonight

```
$ node --test
✔ -v means --version (never verbose)
✔ isAbortError: true for a user abort and a timeout, false for everything else
✔ abort during the first of two calls: the second is skipped, and both are answered
…
ℹ tests 49        ← the 44 course tests from Days 3–5, plus your own
ℹ pass 49
ℹ fail 0

$ node toy/main.mjs --nope
Unknown option: --nope

Usage: node toy/main.mjs [options]
…
```

Two things are on that screen. A test suite, part of it written by you, runs green in about a second, and some of those tests check the toy's client **without a network**. And a mistyped flag no longer crashes the toy with a stack trace: it gets a clear message, the usage, and exit code 2. Behind both sit two modules the real harness keeps: an error vocabulary (`src/shared/errors.js`) and a hand-written command-line parser (`src/cli/args-parser.js`).

## Why it matters

In four days the toy has learned to act, to stop when asked, and to stream its answer. All of that was built for the good days. Today is about the bad ones.

An agent fails constantly. The server is down, a file is missing, the model sends broken JSON, the user mistypes a flag. Some of those failures are **bugs** in your code, and the right response is to find out loudly and fix them. Others are **expected**: they happen to correct programs, and they should flow back to the model or the user as information they can act on. A harness that confuses the two either crashes over a missing file or quietly hides its own bugs. Telling them apart is the first half of today.

The second half is proving that things work. So far you've run the course's tests. Today you write your own, including tests for the toy's client that run with no network at all. Tests that run in a second, on any machine, are what separate a harness you can trust from a demo that worked once. And the modules you write today, the error classes and the command-line parser, come with you into the real harness next week.

## Concepts

### 1. Two kinds of failure

**Some failures are bugs, and some are the world.** Here's a small function from a sign-up form that shows both kinds:

```js run
function parseAge(text) {
  if (typeof text !== 'string') {
    throw new TypeError(`parseAge expects a string, got ${typeof text}`);   // our bug
  }
  const age = Number(text);
  if (!Number.isInteger(age) || age < 0) {
    return { ok: false, error: `"${text}" is not an age` };                // the user's typo
  }
  return { ok: true, age };
}

parseAge('42')        // → { ok: true, age: 42 }
parseAge('twelve')    // → { ok: false, error: '"twelve" is not an age' }
parseAge(42)          // TypeError: parseAge expects a string, got number
```

`parseAge(42)` means some *code* called the function wrongly. That's a **programmer error**: the code is wrong, and the fix is to change the code. `parseAge('twelve')` means the code is fine but the *world* isn't as hoped: a person typed something odd. That's an **operational error**. It happens in correct programs, so the program has to handle it, here by returning a result the form can show to the user.

The same split runs through the harness:

| | Programmer error | Operational error |
|---|---|---|
| Examples | wrong argument shape, a broken invariant, a duplicate tool name | Ollama down, model missing, file not found, bad tool arguments from the model |
| What to do | **throw**, loudly and early | **return** it as data the caller can act on, or throw a *categorized* error with a hint |
| In the harness | `TypeError`, `Error` | `ToolResult { isError: true }`, `ProviderError` |

**Throw programmer errors at once.** A bug found at the point where it happens, with a stack trace, is cheap to fix. A bug that limps on shows up later, far from its cause, where it's expensive to find. On Day 9, registering two tools with the same name is a bug in whoever wired them up, so the registry throws:

```js
function registerTool(tools, tool) {
  if (tools.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered`);
  tools.set(tool.name, tool);
}
```

**Return operational errors as data.** An agent harness has an unusual extra caller: the model. It makes mistakes all the time, and it can recover from most of them if it's told what went wrong. If it asks to read a file that doesn't exist, that isn't a crash. It's information the model can act on, for example by trying another path. So a tool turns the failure into a result. Here is a sketch of Day 10's `read` tool:

```js
import { readFile } from 'node:fs/promises';

async function readTool({ path }) {
  try {
    return { content: await readFile(path, 'utf8'), isError: false };
  } catch (err) {
    if (err.code === 'ENOENT') return { content: `File not found: ${path}`, isError: true };
    throw err;                         // anything unexpected is still allowed to surface
  }
}

await readTool({ path: 'notes/missing.md' })
// → { content: 'File not found: notes/missing.md', isError: true }
```

Notice how it recognises the failure. Node's file errors carry a `code` (`'ENOENT'` means "no such file or directory"), and the tool checks that, not the message text. Notice too what it *doesn't* catch. A permission error or a full disk isn't something this tool expects, so it lets those through.

**Errors carry a category for the person at the keyboard.** When an error does reach the top of the harness (Day 26), what to tell the user depends on the error's **category**:
- `user` (a bad flag or setting): print the message and a usage hint;
- `provider` (network or model): print an actionable hint, such as *"is Ollama running?"*;
- `internal` (a bug): write the stack to a log file and print a short message.

To attach a category to an error, you need errors that can carry fields. That's the next concept.

### 2. Custom error classes and `cause`

**Subclass `Error` so code can tell failures apart.** A plain `Error` has a message, and code shouldn't make decisions by reading messages. An error *class* can carry a recognisable type and extra fields. Here's a small one for the bank account from Day 2:

```js run
class InsufficientFundsError extends Error {
  constructor(balance, amount) {
    super(`Cannot withdraw ${amount}: the balance is ${balance}`);
    this.name = 'InsufficientFundsError';
    this.shortBy = amount - balance;           // a field the caller can use
  }
}

const err = new InsufficientFundsError(20, 50);
err instanceof InsufficientFundsError    // → true
err instanceof Error                     // → true
err.shortBy                              // → 30
String(err)
// → 'InsufficientFundsError: Cannot withdraw 50: the balance is 20'
```

A caller can now write `if (err instanceof InsufficientFundsError)` and offer to move `err.shortBy` from savings, without ever parsing the message.

The harness has one base class that all its errors extend:

```js
export class HarnessError extends Error {
  constructor(message, { category = 'internal', cause, hint } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'HarnessError';
    this.category = category;
    if (hint) this.hint = hint;
  }
}
```

Line by line:
- `extends Error` makes every `HarnessError` a real `Error`, with a message and a stack trace.
- `super(…)` runs `Error`'s own constructor, and a subclass must call it before it touches `this`. The second argument passes the `cause` on, but only when there is one. `new Error('x', { cause: undefined })` would create a `cause` property that holds `undefined`, and error printouts would show it.
- `this.name` is what printouts start with. Without it, a subclass still prints as plain `Error: …`.
- `category` and `hint` are this project's own fields.

```js
const err = new HarnessError('Cannot reach Ollama', { category: 'provider', hint: 'Try: ollama serve' });
err instanceof HarnessError        // → true
err instanceof Error               // → true
String(err)                        // → 'HarnessError: Cannot reach Ollama'
err.category                       // → 'provider'
```

**Each subclass fixes its category and adds its own fields.** A subclass calls `super` with its category, then sets its name and fields. This is `UsageError` from 5.1:

```js
export class UsageError extends HarnessError {
  constructor(message, { token, cause } = {}) {
    super(message, { category: 'user', cause });
    this.name = 'UsageError';
    this.token = token;                // the command-line word that was wrong
  }
}
```

**Route on the type or the category, never on message text.** Messages get reworded, while types and fields are a contract:

```js
if (err.message.startsWith('Unknown option')) …   // ✗ breaks the day someone rewords the message
if (err instanceof UsageError) …                  // ✓
if (err.category === 'user') …                    // ✓
```

**`cause` keeps the original failure when you add context.** A low-level error rarely says what was being attempted. `JSON.parse` complains about "position 1", not about which file it was reading. So catch it, throw a new error that says what you were doing, and pass the original along as `cause`:

```js run
function loadSettings(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error('Could not read settings.json', { cause: err });
  }
}

try {
  loadSettings('{oops');
} catch (err) {
  console.log(err.message);          // → Could not read settings.json
  console.log(err.cause.name);       // → SyntaxError
}
```

Nothing is lost. The new message says what failed, and `err.cause` still holds the exact original error for anyone debugging. The harness does the same when Ollama can't be reached:

```js
try {
  await fetch('http://localhost:11434/api/version');
} catch (err) {
  throw new ProviderError('Cannot reach Ollama', {
    kind: 'unreachable',
    cause: err,
    hint: 'Is Ollama running? Try: ollama serve',
  });
}
```

On the `ProviderError` this throws, `.cause.message` is `'fetch failed'`, and `.cause.cause.code` is `'ECONNREFUSED'` (Day 3). If the error goes uncaught, Node prints the whole chain, custom fields included:

```
ProviderError: Cannot reach Ollama
    at …
  category: 'provider',
  hint: 'Is Ollama running? Try: ollama serve',
  kind: 'unreachable',
  [cause]: [TypeError: fetch failed] {
    [cause]: … ECONNREFUSED …
```

Python contrast: `cause` is `raise … from err`, which sets `__cause__`, and subclassing `Error` is like subclassing `Exception`. C++ contrast: it's like deriving from `std::exception`, with `cause` playing the part of `std::nested_exception`.

Throwing is half of error handling. The other half is what happens on the way out: who catches the error, and what gets cleaned up.

### 3. `try / catch / finally`

**The three blocks, in order.** A `try` block runs your code. If something in it throws, the rest of the `try` is skipped and `catch` receives the thrown value. `finally` runs last, *whatever happened*. Here is the same function run once with a failure and once without:

```js run
function flow(fail) {
  try {
    console.log('1 try starts');
    if (fail) throw new Error('boom');
    console.log('2 try ends');
  } catch (err) {
    console.log('2 catch:', err.message);
  } finally {
    console.log('3 finally');
  }
  console.log('4 after');
}

flow(true);           // 1 try starts, 2 catch: boom, 3 finally, 4 after
flow(false);          // 1 try starts, 2 try ends, 3 finally, 4 after
```

**`finally` runs even when the function is leaving.** It runs after a normal finish, after a `throw`, after a `break`, and after a `return`. A `return` inside `try` waits for it:

```js run
function demo() {
  try {
    console.log('working');
    return 'result';
  } finally {
    console.log('cleanup');
  }
}

demo()                             // logs: working, then cleanup   → 'result'
```

One trap follows from this. A `return` or a `throw` *inside* `finally` replaces whatever was already on its way out, including an error, which then disappears without a trace:

```js run
function swallowed() {
  try {
    throw new Error('the real problem');
  } finally {
    return 'everything is fine';     // ✗ the error above is silently thrown away
  }
}

swallowed()                        // → 'everything is fine'
```

So keep `finally` blocks to cleanup, and never `return` from one.

**`finally` works with `await` too.** In an `async` function, a `finally` after an `await` runs when the awaited work settles, however it settles. The caller doesn't wait around for it; the cleanup happens later, when the function resumes:

```js run
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function job() {
  try {
    console.log('1 before await');
    await delay(10);
    console.log('3 after await');
  } finally {
    console.log('4 finally');
  }
}

const done = job();
console.log('2 the caller carries on');
await done;
```

**JavaScript has no destructors, so `finally` is your cleanup.** An open file, a timer, a child process or a stream reader does **not** clean itself up when a function exits early. If you start something, stop it in a `finally`. Here a progress indicator prints dots while a slow task runs:

```js
async function withDots(task) {
  const timer = setInterval(() => process.stdout.write('.'), 100);   // a progress indicator
  try {
    return await task();
  } finally {
    clearInterval(timer);          // stop the dots: on success, on failure, and on abort
  }
}
```

Without the `finally`, a failed task would leave the interval running forever, and since a live timer keeps Node running (Day 3), the program would never exit. Notice the `return await` too. As Day 3 showed, a plain `return task()` would leave the `try` before the task settled. Here that would mean clearing the dots too early, and a rejection would skip any `catch`. You've already relied on cleanup like this: Day 4's `readNdjson` cancels its reader in a `finally`.

C++ contrast: `finally` does the job RAII did for you, by hand. Python contrast: it's `try/finally`, without `with`.

**Catch what you expect, and rethrow the rest.** A `catch` that swallows everything turns bugs into silence. The Day 3 loop caught `AbortError` and rethrew anything else, and `readTool` above catches `ENOENT` and rethrows anything else. Today's `toy/main.mjs` does the same with the `user` category.

**Anything can be thrown.** `throw 'oops'` is legal. The caught value is then a string, with no `name` and no stack. Always throw `Error` objects. And code that inspects a caught value must not assume it's an object. That's why `isAbortError(err)` reads `err?.name`: with `undefined`, plain `err.name` would itself throw a `TypeError`.

Code that throws when something is wrong is also exactly what a test is made of.

### 4. `node:test` and `node:assert/strict`

**A test is a function that throws when something is wrong.** Node has a test runner built in. `test(name, fn)` registers a test. The test passes if `fn` returns without throwing, and fails if it throws. An **assertion** is a function that throws when its check fails, so a test is mostly a list of assertions. Here's a complete test file for a small function:

```js
// tests/initials.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

const initials = (name) => name.split(' ').map((w) => w[0].toUpperCase()).join('');

test('initials of a two-word name', () => {
  assert.equal(initials('ada lovelace'), 'AL');
});

test('initials of a one-word name', () => {
  assert.equal(initials('plato'), 'P');
});
```

Run it with `node --test`, and each test gets a line: `✔` for a pass, `✖` for a failure, with the expected and actual values printed underneath.

**An async test passes or fails when its promise settles.** If `fn` is `async`, it returns a promise, and the runner *waits* for it. The test passes if the promise fulfils and fails if it rejects. That's how a test can check slow work:

```js
test('the client reports an unreachable server', async () => {
  await assert.rejects(client.chat(messages, []), ProviderError);
});
```

`assert.rejects(promise, check)` returns a promise of its own. It fulfils if `promise` rejects in the expected way, and rejects (with an `AssertionError`) if it doesn't. So the `await` in front of it is not optional. Leave it out, and the test function returns at once, before the check has run. The runner sees a function that finished without throwing, and marks the test `✔`. When the check fails a moment later, there's no test left to fail:

```
✔ the client reports an unreachable server (0.6ms)
ℹ Error: Test "the client reports an unreachable server" … generated asynchronous activity after the
  test ended. This activity created the error "AssertionError [ERR_ASSERTION]: Missing expected
  rejection." and would have caused the test to fail, but instead triggered an unhandledRejection event.
```

It's Day 3's forgotten `await`, with a test runner watching. The rule is the same as everywhere else: every promise a test creates must be `await`ed inside it.

**The assertions you'll use most:**
- `assert.equal(actual, expected)` compares with `===`. For objects that means *the same object* (Day 2), so two lookalike objects fail with `Values have same structure but are not reference-equal`.
- `assert.deepEqual(actual, expected)` compares structure: same keys, same values, all the way down. Use it for objects and arrays.
- `assert.match(string, /regex/)` checks text against a pattern.
- `assert.throws(fn, check)` and `await assert.rejects(promise, check)` expect a failure. The `check` can be a class, a regex, or a function.
- `assert.ok(value)` checks that a value is truthy.

The `/strict` in the import matters. It makes `equal` and `deepEqual` the strict versions, which never coerce (`'1'` is not `1`).

**Table-driven tests.** When the same check runs over many inputs, write the inputs as data and make a sub-test per row with `t.test()`:

```js
test('byte lengths', async (t) => {
  const rows = [
    { input: 'a', bytes: 1 },
    { input: 'é', bytes: 2 },
    { input: '🙂', bytes: 4 },
  ];
  for (const { input, bytes } of rows) {
    await t.test(`'${input}' is ${bytes} bytes`, () => {
      assert.equal(Buffer.byteLength(input), bytes);
    });
  }
});
```

Each row is reported on its own line, so a failure names the input that broke:

```
▶ byte lengths
  ✔ 'a' is 1 bytes
  ✔ 'é' is 2 bytes
  ✔ '🙂' is 4 bytes
✔ byte lengths
```

Adding a case is now one line of data, which makes it much more likely that you'll add the awkward ones.

**Running tests:**
- `node --test` with no arguments finds and runs every `*.test.js` file in the project.
- To run some files only, pass the files or a glob: `node --test tests/course/day05-*`. A bare directory (`node --test tests/course/`) does **not** work on Node 22+.
- There is no config file and no framework.

Python contrast: `node:test` plays the role of `unittest` or `pytest`, and `assert.deepEqual` is like `assertEqual` on nested data.

The toy's client is harder to test than a pure function, because it talks to a server.

### 5. Dependency injection is how you fake things in tests

A test that talks to a real server is slow, fails when the server is down, and can't easily make the server misbehave on purpose. So tests replace the server with a fake. Day 2 showed the way to make that possible: injecting `confirm` and `runTool` into `runTurns`. Today you do the same for the network. The client takes `fetch` as an option, and defaults it to the real one:

```js
// production: nobody passes fetch, so the default, the real one, is used
export function createOllamaClient({ model, fetch = globalThis.fetch }) { … }

// a test: pass a fake
const client = createOllamaClient({ model: 'm', fetch: fakeFetch });
```

**A fake `fetch` is a function that returns a `Response`.** `Response` is the same class real `fetch` gives you, and you can build one yourself, with a body and a status:

```js
const fakeFetch = async (url, init) => new Response('{"version":"0.0.0-test"}', { status: 200 });

const res = await fakeFetch('http://localhost:11434/api/version');
res.ok                             // → true
await res.json()                   // → { version: '0.0.0-test' }

new Response('model not found', { status: 404 }).ok   // → false
```

The fake is `async`, so it returns a promise of a `Response`, exactly as the real `fetch` does, and the client can't tell the difference.

**The body can also be a stream.** That's how 5.4 fakes a streamed reply. `new ReadableStream({ start(controller) { … } })` calls `start` once, straight away. Inside it, `controller.enqueue(chunk)` adds a chunk for the reader to receive, and `controller.close()` says there will be no more. Forget the `close()`, and the client's reader loop waits for a next chunk that never comes, so the test hangs. And because the fake receives `init`, it can record what the client sent, so a test can check both directions.

**Why pass `fetch` in, when it's a global you *could* patch with `t.mock.method(globalThis, 'fetch')`?**
- **It's explicit.** The signature says what the module talks to.
- **Nothing shared leaks.** A patched global affects every test in the file until someone restores it.
- **It works for imports too.** You *can't* reassign an imported binding: imports are live, read-only views of another module (Node's `mock.module()` is still experimental):

  ```js
  import { runBash } from './toy/bash-tool.mjs';
  runBash = async () => 'fake';    // TypeError: Assignment to constant variable.
  ```

Every test from Day 8 on uses this pattern, and Day 3's course tests already did.

The last piece of today is the toy's first real interface to the outside world: its command line.

### 6. The command line: `process.argv`, flags and exit codes

**Your program receives its arguments as an array of strings.** `process.argv` holds the path to `node`, the path to your script, and then every word typed after it. So the arguments themselves are `process.argv.slice(2)`:

```js
// node toy/main.mjs --model qwen3.5:9b --num-ctx 16384
process.argv.slice(2)              // → ['--model', 'qwen3.5:9b', '--num-ctx', '16384']
```

Every value is a string, even `'16384'`. Converting and checking it is your job (Day 2's *converting on purpose*), and a value that doesn't convert is an operational error, the user's typo, not a bug.

**Flags follow conventions that users expect.** A long flag is written `--model`, and a short one `-m`. A flag that takes a value accepts it as the next word (`--model qwen3.5:9b`) or after an `=` (`--model=qwen3.5:9b`). A word that isn't a flag is a *positional* argument. A lone `--` means "everything after this is positional, even if it starts with a dash". 5.5's parser implements exactly these rules.

**Exit codes tell scripts what happened.** When a program ends, it returns a number to whoever started it. `0` means success, and anything else means failure. By a long-standing convention, `2` means "you used the command wrongly", which is what 5.6 returns for a bad flag. In a shell, `echo $?` prints the last exit code. Day 26 adds the harness's full list of codes.

**Errors go to stderr.** `console.log` writes to *standard output* (stdout), and `console.error` writes to *standard error* (stderr). Both appear in your terminal. But when someone pipes your program into another one, only stdout goes down the pipe, so error messages on stderr can't corrupt the real output. Day 26's `-p` mode depends on this.

## Build

The order is deliberate. First the error classes, because the parser throws them. Then a short exercise in telling failures apart, and two rounds of writing tests. Last, the parser itself, and the toy's first flags, which use everything before them.

**Files today:** `src/shared/errors.js`, `src/cli/args-parser.js`, `notes/day-05.md`, `tests/truncate.test.js`, `tests/toy-ollama.test.js`, `toy/ollama.mjs` and `toy/main.mjs`.

### 5.1 `src/shared/errors.js` — Core

Write these and keep them; the whole harness uses them. All four classes extend `HarnessError`.

| Export | Shape | Category |
|---|---|---|
| `HarnessError` | `(message, { category, cause, hint })` | defaults to `'internal'` |
| `UsageError` | `(message, { token })`; `token` is the offending argv word | `'user'` |
| `ValidationError` | `(message, { field, category = 'user' })` | `'user'` by default |
| `ProviderError` | `(message, { kind, status?, cause?, hint? })`; `kind` is `'unreachable'`, `'model_not_found'`, `'bad_response'` or `'http'` | `'provider'` |
| `isAbortError(err)` | `true` when `err?.name` is `'AbortError'` or `'TimeoutError'` | — |

Concept 2 shows `HarnessError` and `UsageError`. `ValidationError` and `ProviderError` follow the same pattern: call `super` with the category, then set `name` and the class's own fields. `isAbortError` recognises both kinds of cancellation you met on Day 3.

Copy the day's course tests and make `day05-errors` pass:

```bash
cp ../agent-harness-curriculum/course-tests/day-05/*.test.js tests/course/
node --test tests/course/day05-errors.test.js
```

### 5.2 Classify failures — Core

In `notes/day-05.md`, classify each of these as a programmer or an operational error, and say whether it should throw or return a result:
- Ollama refuses the connection;
- the model sends `{"path": ` (broken JSON);
- two tools are registered with the same name;
- `read` is called on a missing file;
- the user passes `--nope`;
- `run()` is called while it is already running.

For each, ask concept 1's question: is this a bug in our code, or something the world did? Then ask who can act on it: the developer, the user, or the model. A few are less obvious than they look. The broken JSON came from the model, not from your code, and the `--nope` came from a person, so think about who sees the result.

### 5.3 Test bootcamp: your own truncate tests — Core

The course tests have been telling you whether your code works. Now you write the tests yourself, for the truncator you wrote yesterday. In `tests/truncate.test.js`, write your own cases as a **table** of `{ input, maxBytes, shownBytes }` rows, one `t.test()` per row (concept 4 shows the pattern). Include an emoji at the boundary. Break one assertion on purpose, read the diff in the output, then fix it.

### 5.4 Test the toy client offline — Core

Give `createOllamaClient` a `fetch` option, defaulting to `globalThis.fetch`. Then, in `tests/toy-ollama.test.js`, check **both sides of the boundary**: what comes back, *and* what was sent.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOllamaClient } from '../toy/ollama.mjs';

test('chat() joins streamed chunks, and asks for the context window it was given', async () => {
  const lines = [
    '{"message":{"content":"Hel"},"done":false}\n',
    '{"message":{"content":"lo"},"done":true}\n',
  ];
  const sent = [];
  const fakeFetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(new ReadableStream({
      start(c) {
        for (const s of lines) c.enqueue(new TextEncoder().encode(s));
        c.close();
      },
    }));
  };
  const client = createOllamaClient({ model: 'm', numCtx: 16384, fetch: fakeFetch });
  const reply = await client.chat([{ role: 'user', content: 'hi' }], []);

  assert.equal(reply.content, 'Hello');
  assert.equal(sent[0].options.num_ctx, 16384);   // the guard against Ollama's silent 4k truncation
  assert.equal(sent[0].stream, true);
});
```

The fake builds a stream that delivers the two NDJSON lines and then closes, which is what Ollama's body does (concept 5). `sent` records each request body, which is how the test sees what the client asked for. Notice the `await` in front of `client.chat`: as concept 4 explains, without it the assertions would run against a promise, long before the reply was put together.

The test must pass **with your Wi-Fi off**. The `num_ctx` assertion is the important one: forgetting to send it produces no error anywhere, only a model that quietly forgets its instructions.

The day's course tests include `day05-toy-client.test.js`, which uses the same seam to check Day 4's thinking fallback: a fake server refuses `think` once, and the client must retry without it and keep it off.

### 5.5 `src/cli/args-parser.js` — Core

The harness's real CLI parser, written by hand. Node has a built-in one, `util.parseArgs`, but writing your own once teaches you exactly what the conventions in concept 6 mean, and it gives you a module whose every decision is yours and pinned by a test. Its API:

```js
/**
 * @typedef {object} FlagDef
 * @property {string} name           the key in `values`, e.g. 'version'
 * @property {string} long           e.g. '--version'
 * @property {string} [short]        e.g. '-v'
 * @property {'boolean'|'string'} type
 * @property {boolean} [repeatable]  string flags only: collect every occurrence into an array
 * @property {string} [description]  shown by getUsage()
 * @property {string} [valueName]    shown by getUsage() (default 'value')
 */
export function parseArgs(argv, flags) { … }   // → { values, positionals }
export function getUsage(flags, info) { … }    // → help text listing every form
export { UsageError } from '../shared/errors.js';
```

Requirements:
- boolean and string flags, in short (`-v`) and long (`--version`) form, written as `--flag=value` or `--flag value`;
- repeatable string flags collect into an array, and everything after `--` is positional;
- an unknown flag, or a string flag missing its value, throws a `UsageError` naming the token.

With the course test's flags (they're the ones listed in the help text below), it behaves like this:

```js
parseArgs(['--model=qwen3.5:9b', '-V', 'hello'], SPEC)
// → { values: { model: 'qwen3.5:9b', verbose: true }, positionals: ['hello'] }

parseArgs(['--extension', 'a.js', '--extension=b.js'], SPEC).values.extension   // → ['a.js', 'b.js']
parseArgs(['--nope'], SPEC)        // UsageError: Unknown option: --nope   (err.token is '--nope')
parseArgs(['--model'], SPEC)       // UsageError: Option --model needs a value
```

A plan that works: build a `Map` from every form (`'--model'`, `'-v'`, …) to its `FlagDef`. Then walk `argv` with an index, so a string flag can consume the next word:
- `--` ends parsing, and everything after it is positional;
- a word that doesn't start with `-` is positional;
- otherwise, split `--flag=value` at the first `=`, look the flag up, and set `true` for a boolean, or the value for a string.

**A fixed decision, pinned by a test: `-v` is `--version`, never verbose.** Verbose is `--verbose` (short form `-V`).

`getUsage` lists one flag per line: its forms joined by `, `, then ` <valueName>` for string flags (default `<value>`), then the description. For the course test's flags, it prints:

```
Usage: agent-harness [options]

Options:
  -v, --version        Print the version and exit
  -V, --verbose        Debug logging
  --model <value>      Model to use
  --extension <value>  Load an extension file (repeatable)
  -h, --help           Show this help
```

Make `node --test tests/course/day05-args-parser.test.js` pass.

### 5.6 The toy's first flags — Core

Put the parser to work today. Give `toy/main.mjs` three flags, and pass the values to `createOllamaClient({ model, numCtx })`:

| Flag | Meaning |
|---|---|
| `--model <name>` | the model (default `$AH_MODEL`, then `qwen3.5:4b`) |
| `--num-ctx <tokens>` | the context window; a whole number of at least 1024, else throw a `ValidationError` with `field: 'num-ctx'` |
| `-h, --help` | print the usage and exit 0 |

Read the flags before creating anything else, so a typo is reported before the toy opens readline or talks to Ollama. On an error whose `category` is `'user'`, print its message and the usage, then `process.exit(2)`. Rethrow anything else: that's a bug, and it should crash loudly. The routing is a few lines:

```js
let options;
try {
  options = readOptions(process.argv.slice(2));   // your function: parseArgs, then check the values
} catch (err) {
  if (err.category !== 'user') throw err;        // a bug: let it crash
  console.error(`${err.message}\n\n${USAGE}`);
  process.exit(2);
}
```

Try it:

```bash
node toy/main.mjs --nope            # Unknown option: --nope + usage, exit code 2
node toy/main.mjs --num-ctx lots    # --num-ctx must be a whole number…, exit code 2
node toy/main.mjs --model qwen3.5:9b --num-ctx 16384
```

Now run `node --test`: every test, the course's and yours, is green. Commit `day-05: errors, tests, args-parser`.

### 5.7 `tsc --checkJs` — Stretch

Install the TypeScript compiler **and Node's type definitions**. Without `@types/node`, `tsc` doesn't know `node:child_process`, `Buffer` or `ReadableStream`, and reports dozens of errors that aren't bugs.

```bash
npm i -D typescript @types/node
npx tsc --allowJs --checkJs --noEmit --strict false --target es2022 --module nodenext \
  $(find src toy -name '*.js' -o -name '*.mjs')
```

`--strict false` matters: **TypeScript 7 turns strict mode on by default**, and then it reports hundreds of "parameter implicitly has an `any` type" errors on JSDoc'd JavaScript like this course's. The reference solutions pass this exact command with **0 errors** under TypeScript 5.9 and 7.0, so yours can too. (Want more? Try `--strict` once for fun, and read what it would take.)

Fix what it finds. Expect things like an `unknown` value used without checking its shape, a string where a literal type such as `'boolean' | 'string'` was wanted, an options parameter `{ signal } = {}` with no `@param` type, or fields set with `Object.assign(this, …)` that the checker can't see. A JSDoc annotation (or plain `this.x = x` assignments) usually settles them. (Node 24 can also run `.ts` files directly through type stripping. This course stays with JSDoc so you see plain JavaScript.)

## Check

That's the end of week one. The toy acts, stops when asked, streams, and now fails well: bugs crash loudly where they happen, while the world's failures come back as messages someone can act on. You can also prove it. You have tests of your own, a client tested with no network, and a habit of checking what was sent as well as what came back. The error classes and the parser are the first pieces of the real harness that you'll keep using every day from here on.

Tomorrow you stop building for a day and read. [Day 6](day-06.md) walks through Pi, a serious open-source harness, and you write down the design of your own before you start building it on Day 7.

Before you move on, check:

- [ ] `src/shared/errors.js` exports all five, and `node --test tests/course/day05-errors.test.js` passes
- [ ] `notes/day-05.md` has your classification
- [ ] `tests/truncate.test.js` (yours, table-driven) and `tests/toy-ollama.test.js` (offline, and checks the request too)
- [ ] `src/cli/args-parser.js`, and `node toy/main.mjs --nope` exits with code 2
- [ ] `node --test` is fully green: 44 course tests plus yours
- [ ] Commit `day-05: errors, tests, args-parser`

Solution: `src/shared/errors.js` and `src/cli/args-parser.js` in [`solutions/checkpoint-1/`](solutions/checkpoint-1/), and `toy/main.mjs` in [`solutions/toy/`](solutions/toy/).

## Stuck?

<details><summary><code>--model=a=b</code> parses wrong</summary>

Split on the **first** `=` only: `token.indexOf('=')`, then `slice`.
</details>

<details><summary>How do I tell <code>--model value</code> from <code>--model --other</code>?</summary>

You don't have to. The course spec takes the next word as the value, whatever it looks like; "missing" means the end of argv, nothing more. Write that rule in the file's header comment. (Node's `util.parseArgs` is stricter: it rejects a value that looks like a flag. Compare the two once yours works.)
</details>

<details><summary><code>assert.throws</code> passes but checks nothing</summary>

Give it a validator: `assert.throws(fn, UsageError)`, or `assert.throws(fn, (err) => { assert.equal(err.token, '--nope'); return true; })`.
</details>

<details><summary><code>ReferenceError: Must call super constructor in derived class before accessing 'this'</code></summary>

In a subclass's constructor, `super(…)` must come first. Set `this.name` and the other fields after it.
</details>

<details><summary><code>TypeError: Class constructor HarnessError cannot be invoked without 'new'</code></summary>

Classes must be created with `new`: `throw new UsageError(…)`, not `throw UsageError(…)`.
</details>

<details><summary>A test shows ✔, but the file fails with "generated asynchronous activity after the test ended"</summary>

A promise in the test wasn't awaited. The usual culprit is `assert.rejects(…)` without `await`. The test function returned before the check ran, so the runner had already marked it passed when the check failed (concept 4). Write `await assert.rejects(…)`.
</details>

<details><summary>A test hangs and never finishes</summary>

Something it awaits never settles. With a fake streaming body, check that `start` calls `c.close()` after the last chunk: without it, the client waits for more data forever. Run with `node --test --test-timeout=5000` to turn a hang into a failure that names the test.
</details>

<details><summary>An error vanished: the function returned normally, though something inside it threw</summary>

Look for a `return` inside a `finally` block. It replaces whatever was leaving the function, including a thrown error (concept 3). Keep `finally` to cleanup only.
</details>

<details><summary>My error prints as <code>Error: …</code>, not with its class name</summary>

The subclass never set `this.name`. Add `this.name = 'UsageError'` (or whichever class it is) in the constructor, after `super(…)`.
</details>

<details><summary><code>--num-ctx 16384</code> arrives as a string</summary>

Every argv value is a string. Convert with `Number(value)`, then check `Number.isInteger(n)`: `Number('lots')` is `NaN`, which is not an integer.
</details>

<details><summary><code>node --test tests/course/</code> fails with <code>Cannot find module</code></summary>

On Node 22+, `node --test` takes files or glob patterns, not directories. Use `node --test` (everything) or `node --test tests/course/*.test.js`.
</details>

## Common mistakes

- `catch (e) { return undefined; }`. It turns bugs into quiet `undefined`s that fail somewhere else, much later, with no stack trace pointing back here. It makes the crash in front of you go away, which feels like fixing it.
- Deciding what to do by reading `err.message`, instead of checking `instanceof`, `category` or `code`. Messages are written for people and get reworded. Types and codes are a contract. The message is the first thing you see when you print an error, so it's the obvious thing to test.
- `assert.equal` on objects instead of `deepEqual`. `equal` compares identity, so two objects with the same contents still fail. The name sounds like "are these equal?", and for objects that question is the one `deepEqual` answers.
- `assert.rejects` without `await`. The test returns before the check runs, so it passes no matter what. A passing test gives you no reason to look closer, so the missing `await` stays.
- Tests that hit the real network. They're slow, they fail when the server is down, and they can't make the server misbehave on purpose. Inject a fake instead. On your own machine the server is usually running, so they pass, and nothing reminds you that they depend on it.
- Testing only what comes back, never what was sent. Some of the worst bugs, like a missing `num_ctx`, are in the request, and the reply still looks fine. The reply is what you read, so it's what you think of checking.

## Self-check

1. Programmer error or operational error: which one throws, and what does the other become?
2. `fetch` is a global you *could* patch in a test. Why inject it anyway?
3. Why must `finally` be taught explicitly to a C++ programmer?
4. What does `-v` mean in this project, and where is that decision pinned?

Answers: [self-check-answers.md](self-check-answers.md#day-5).

## Further reading

- javascript.info, [Error handling, "try...catch"](https://javascript.info/try-catch) · [Custom errors, extending Error](https://javascript.info/custom-errors): patient, beginner-friendly chapters with exercises
- Node.js, [Test runner](https://nodejs.org/api/test.html) (see [subtests](https://nodejs.org/api/test.html#subtests)) · [`assert`](https://nodejs.org/api/assert.html) · [Errors](https://nodejs.org/api/errors.html) (including the `code` values such as `ENOENT`)
- MDN, [`Error.cause`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error/cause) · [`try…catch`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/try...catch)
- Node.js, [`util.parseArgs`](https://nodejs.org/api/util.html#utilparseargsconfig): the built-in you are re-implementing. Compare it with yours once yours works.

---
← [Day 4](day-04.md) · [Curriculum home](README.md) · Next: [Day 6 — Read Pi, design your harness](day-06.md) →
