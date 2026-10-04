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

You have an error vocabulary for the whole harness (`src/shared/errors.js`), a hand-written CLI parser that the toy already uses (`src/cli/args-parser.js`), your own tests, and a toy client tested **without a network**.

## Why it matters

An agent fails constantly: the server is down, a file is missing, the model sends broken JSON. Some failures are **bugs** to fix; others are **expected**, and should flow back to the model or the user as data. Telling the two apart, and proving behaviour with tests that run in a second, is what separates a harness you can trust from a demo.

## Concepts

### 1. Two kinds of failure

**Some failures are bugs, and some are the world.** A *programmer error* means the code is wrong: a function was called with the wrong arguments, or something that must never happen did. The fix is to change the code. An *operational error* means the code is fine, but the world isn't as hoped: the server is down, the file doesn't exist, the model sent garbage. Those happen in correct programs, so the program has to handle them.

| | Programmer error | Operational error |
|---|---|---|
| Examples | wrong argument shape, a broken invariant, a duplicate tool name | Ollama down, model missing, file not found, bad tool arguments from the model |
| What to do | **throw**, loudly and early | **return** it as data the caller can act on, or throw a *categorized* error with a hint |
| In the harness | `TypeError`, `Error` | `ToolResult { isError: true }`, `ProviderError` |

**Throw programmer errors at once.** A bug found at the point where it happens, with a stack trace, is cheap to fix. A bug that limps on shows up later, far from its cause. On Day 9, registering two tools with the same name is a bug in whoever wired them up, so the registry throws:

```js
function registerTool(tools, tool) {
  if (tools.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered`);
  tools.set(tool.name, tool);
}
```

**Return operational errors as data.** In an agent, the model is a "caller" too. If it asks to read a file that doesn't exist, that isn't a crash. It is information the model can act on: it can try another path. So a tool turns the failure into a result. Here is a sketch of Day 10's `read` tool:

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

Notice how it recognises the failure: Node's file errors carry a `code` (`'ENOENT'`, "no such file or directory"), and the tool checks that, not the message text.

**Errors carry a category for the person at the keyboard.** The harness's top level (Day 26) talks to the user differently depending on the error's **category**:
- `user` (a bad flag or setting): print the message and a usage hint;
- `provider` (network or model): print an actionable hint, such as *"is Ollama running?"*;
- `internal` (a bug): write the stack to a log file and print a short message.

### 2. Custom error classes and `cause`

**Subclass `Error` so code can tell failures apart.** A plain `Error` has a message, and code shouldn't make decisions by reading messages. An error *class* can carry a recognisable type and extra fields. This is the base class for the whole harness:

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

**Route on the type or the category, never on message text.** Messages get reworded; types and fields are a contract:

```js
if (err.message.startsWith('Unknown option')) …   // ✗ breaks the day someone rewords the message
if (err instanceof UsageError) …                  // ✓
if (err.category === 'user') …                    // ✓
```

**`cause` keeps the original failure when you add context.** A low-level error like `fetch failed` doesn't tell the user what was being attempted. Wrap it in an error that does, and pass the original along as `cause`:

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

Nothing is lost. `err.cause.message` is `'fetch failed'`, and `err.cause.cause.code` is `'ECONNREFUSED'` (Day 3). If the error goes uncaught, Node prints the whole chain, custom fields included:

```
ProviderError: Cannot reach Ollama
    at …
  category: 'provider',
  hint: 'Is Ollama running? Try: ollama serve',
  kind: 'unreachable',
  [cause]: [TypeError: fetch failed] {
    [cause]: … ECONNREFUSED …
```

Python contrast: `cause` is `raise … from err`, which sets `__cause__`.

### 3. `try / catch / finally`

**`finally` always runs.** A `try` block runs your code. If something in it throws, `catch` receives the thrown value. `finally` runs last, *whatever happened*: after a normal finish, after a `return`, after a `throw` and after a `break`. Even a `return` inside `try` waits for it:

```js
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

**JavaScript has no destructors, so `finally` is your cleanup.** An open file, a timer, a child process or a stream reader does **not** clean itself up when a function exits early. If you start something, stop it in a `finally`:

```js
async function chatWithDots(client, messages) {
  const timer = setInterval(() => process.stdout.write('.'), 100);   // a progress indicator
  try {
    return await client.chat(messages, []);
  } finally {
    clearInterval(timer);          // stop the dots: on success, on failure, and on abort
  }
}
```

Without the `finally`, a failed `chat` would leave the interval running forever, and the program would never exit. You've already relied on this: Day 4's `readNdjson` cancels its reader in a `finally`.

C++ contrast: `finally` does what RAII did for you. Python contrast: it's `try/finally`, without `with`.

**Catch what you expect, and rethrow the rest.** A `catch` that swallows everything turns bugs into silence. The Day 3 loop caught `AbortError` and rethrew anything else; `readTool` above catches `ENOENT` and rethrows anything else. Today's `toy/main.mjs` does the same with the `user` category.

**Anything can be thrown.** `throw 'oops'` is legal: the caught value is then a string, with no `name` and no stack. Always throw `Error` objects. And code that inspects a caught value must not assume it's an object. That's why `isAbortError(err)` reads `err?.name`: with `undefined`, plain `err.name` would itself throw a `TypeError`.

### 4. `node:test` and `node:assert/strict`

**A test is a function that throws when something is wrong.** Node has a test runner built in. `test(name, fn)` registers a test. The test passes if `fn` returns (or its promise resolves) without throwing, and fails if it throws (or rejects). An assertion is a function that throws when its check fails:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncateText } from '../src/tools/truncate.js';

test('short text passes through', () => {
  assert.deepEqual(truncateText('hi', 10), {
    content: 'hi',
    truncated: false,
    byteLength: 2,
    shownBytes: 2,
  });
});

test('rejects', async () => {
  await assert.rejects(doThing(), /expected message/);
});
```

**The assertions you'll use most:**
- `assert.equal(actual, expected)` compares with `===`. For objects that means *the same object* (Day 2), so two lookalike objects fail with `Values have same structure but are not reference-equal`.
- `assert.deepEqual(actual, expected)` compares structure: same keys, same values, all the way down. Use it for objects and arrays.
- `assert.match(string, /regex/)` checks text against a pattern.
- `assert.throws(fn, check)` and `await assert.rejects(promise, check)` expect a failure. The `check` can be a class, a regex, or a function.
- `assert.ok(value)` checks that a value is truthy.

The `/strict` in the import matters: it makes `equal` and `deepEqual` the strict versions, which never coerce (`'1'` is not `1`).

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

**Running tests:**
- `node --test` with no arguments finds and runs every `*.test.js` file in the project.
- To run some files only, pass the files or a glob: `node --test tests/course/day05-*`. A bare directory (`node --test tests/course/`) does **not** work on Node 22+.
- There is no config file and no framework.

Python contrast: `node:test` plays the role of `unittest` or `pytest`, and `assert.deepEqual` is like `assertEqual` on nested data.

### 5. Dependency injection is how you fake things in tests

Day 2 injected `confirm` and `runTool` into `runTurns`. Today you do the same for the network. The client takes `fetch` as an option, and defaults it to the real one:

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

The body can also be a `ReadableStream`, which is how 5.4 fakes a streamed reply. And because the fake receives `init`, it can record what the client sent, so a test can check both directions.

**Why pass `fetch` in, when it is a global you *could* patch with `t.mock.method(globalThis, 'fetch')`?**
- **It's explicit.** The signature says what the module talks to.
- **Nothing shared leaks.** A patched global affects every test in the file until someone restores it.
- **It works for imports too.** You *can't* reassign an imported binding: imports are live, read-only views of another module (Node's `mock.module()` is still experimental):

  ```js
  import { runBash } from './toy/bash-tool.mjs';
  runBash = async () => 'fake';    // TypeError: Assignment to constant variable.
  ```

Every test from Day 8 on uses this pattern, and Day 3's course tests already did.

### 6. The command line: `process.argv`, flags and exit codes

**Your program receives its arguments as an array of strings.** `process.argv` holds the path to `node`, the path to your script, and then every word typed after it. So the arguments themselves are `process.argv.slice(2)`:

```js
// node toy/main.mjs --model qwen3.5:9b --num-ctx 16384
process.argv.slice(2)              // → ['--model', 'qwen3.5:9b', '--num-ctx', '16384']
```

Every value is a string, even `'16384'`. Converting and checking it is your job (Day 2's *converting on purpose*).

**Flags follow conventions that users expect.** A long flag is written `--model`, and a short one `-m`. A flag that takes a value accepts it as the next word (`--model qwen3.5:9b`) or after an `=` (`--model=qwen3.5:9b`). A word that isn't a flag is a *positional* argument. A lone `--` means "everything after this is positional, even if it starts with a dash". 5.5's parser implements exactly these rules.

**Exit codes tell scripts what happened.** When a program ends, it returns a number to whoever started it. `0` means success, and anything else means failure. By a long-standing convention, `2` means "you used the command wrongly", which is what 5.6 returns for a bad flag. In a shell, `echo $?` prints the last exit code. Day 26 adds the harness's full list of codes.

**Errors go to stderr.** `console.log` writes to *standard output* (stdout), and `console.error` writes to *standard error* (stderr). Both appear in your terminal. But when someone pipes your program into another one, only stdout goes down the pipe, so error messages on stderr can't corrupt the real output. Day 26's `-p` mode depends on this.

## Build

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

For each, ask concept 1's question: is this a bug in our code, or something the world did? Then ask who can act on it: the developer, the user, or the model.

### 5.3 Test bootcamp: your own truncate tests — Core

In `tests/truncate.test.js`, write your own cases as a **table** of `{ input, maxBytes, shownBytes }` rows, one `t.test()` per row (concept 4 shows the pattern). Include an emoji at the boundary. Break one assertion on purpose, read the diff in the output, then fix it.

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

The fake builds a stream that delivers the two NDJSON lines and then closes, which is what Ollama's body does. `sent` records each request body, which is how the test sees what the client asked for.

The test must pass **with your Wi-Fi off**. The `num_ctx` assertion is the important one: forgetting to send it produces no error anywhere, only a model that quietly forgets its instructions.

The day's course tests include `day05-toy-client.test.js`, which uses the same seam to check Day 4's thinking fallback: a fake server refuses `think` once, and the client must retry without it and keep it off.

### 5.5 `src/cli/args-parser.js` — Core

The harness's real CLI parser, written by hand. Its API:

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

Read the flags before creating anything else. On an error whose `category` is `'user'`, print its message and the usage, then `process.exit(2)`. Rethrow anything else: that's a bug, and it should crash loudly. The routing is a few lines:

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

A promise in the test wasn't awaited. The usual culprit is `assert.rejects(…)` without `await`. The test finished before the check did, and the failed check arrived too late to count. Write `await assert.rejects(…)`.
</details>

<details><summary>A test hangs and never finishes</summary>

Something it awaits never settles. With a fake streaming body, check that `start` calls `c.close()` after the last chunk: without it, the client waits for more data forever. Run with `node --test --test-timeout=5000` to turn a hang into a failure that names the test.
</details>

<details><summary><code>--num-ctx 16384</code> arrives as a string</summary>

Every argv value is a string. Convert with `Number(value)`, then check `Number.isInteger(n)`: `Number('lots')` is `NaN`, which is not an integer.
</details>

<details><summary><code>node --test tests/course/</code> fails with <code>Cannot find module</code></summary>

On Node 22+, `node --test` takes files or glob patterns, not directories. Use `node --test` (everything) or `node --test tests/course/*.test.js`.
</details>

## Common mistakes

- `catch (e) { return undefined; }`, which turns bugs into quiet `undefined`s.
- Deciding what to do by reading `err.message`, instead of checking `instanceof`, `category` or `code`.
- `assert.equal` on objects (it compares identity) instead of `deepEqual`.
- `assert.rejects` without `await`.
- Tests that hit the real network: slow, flaky, and broken offline.
- Testing only what comes back, never what was sent.

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
