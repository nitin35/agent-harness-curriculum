# Day 18 — Slash Commands and `/model`

**Phase:** Week 3 — Interactive harness

## By tonight

```
> /help
  · /help (/h) — List commands
  · /session — Show the current session
  · /new — Start a fresh session (the current one is already saved)
  · /model [name] — List models, or switch to one
  · /quit (/exit, /q) — Leave (the session is already saved)
> /model
  · * 1. qwen3.5:4b
  ·   2. qwen3.5:9b-mlx
> /model 2
  · model → qwen3.5:9b-mlx
> /model qwen3.5:4bb
  · qwen3.5:4bb is not installed, so the model is still qwen3.5:9b-mlx. Pull it first (`ollama pull qwen3.5:4bb`), or pick one from /model.
> /frobnicate
  · Unknown command: /frobnicate. Try /help.
```

Every answer here starts with `  · `, the printer's system prefix, because none of it came from the model. `/help` lists five commands with their aliases in brackets. `/model` lists the installed models and marks the active one with `*`, and `/model 2` switches by number. The typo `qwen3.5:4bb` is refused before anything changes, and the reply says so: the model is *still* the one you had. The last line is what any unknown command gets, a hint instead of an error.

The harness can now talk about *itself*. Lines starting with `/` never reach the model.

## Why it matters

Since yesterday, sessions go to disk, so a conversation outlives the program. But the only way to control the harness itself is still to quit and start it again. You can't ask which session you're in, start a fresh one, or try a different model without restarting.

Every real harness has commands for this: `/help`, `/model`, `/clear`, `/resume`, `/compact`. They're also the main way extensions (Day 22) add features, and that's where a careless design shows. If the router is a chain of `if`s, every new command means editing it, and an extension can't add one at all without changing your code. The design is a **dispatch table**: adding a command means one registration, never another `if` branch in the router.

There's a second risk, and it's about timing. Commands run at once, even while a run is in flight, which is what lets `/quit` always work. But a command that swaps the session in the middle of a run would split one conversation across two files. So some commands have to wait, and the registry has to know which.

## Concepts

### 1. Routing at one boundary

Commands are for the harness; messages are for the model. `PromptUI` already emits `command { line }` for lines that follow the command rule (Day 15: `/` and a name). The bridge runs commands **immediately**, even mid-run (so `/quit` always works), and re-poses the prompt afterwards. Commands never reach the model.

"Immediately, even mid-run" works for the reason Day 15 explained. While a run is in flight, the bridge's `#run` is paused at an `await`, and the event loop keeps going, so a `command` event that arrives is handled at once, alongside the run rather than after it.

Here is the path of `/model 2`. `PromptUI` sees a command and emits `command { line: '/model 2' }`. The bridge passes the line to the command registry. The registry finds `model` and runs its handler, and the bridge prints whatever text comes back. The loop and the model are never involved, so a command costs no tokens and no waiting.

The exception is commands that change the session. `/new` mid-run would swap the session under a running conversation, and that run's messages would start the "fresh" one, because the bridge saves a run's messages when it ends (Day 17). So a command can say `idle: true`, and while a run is in flight it answers *"/new works between runs: wait for the answer, or press Ctrl+C first."* `/new`, `/resume` (Day 19) and `/compact` (Day 25) are idle commands.

Once a line is known to be a command, the registry has to find the code that handles it.

### 2. A `Map` is the dispatch table

A *dispatch table* is a table from names to the functions that handle them. It replaces a chain of `if`s with a lookup. Here is one outside the harness, a calculator whose operations live in a `Map` (Day 9):

```js run
const operations = new Map([
  ['add', (a, b) => a + b],
  ['sub', (a, b) => a - b],
  ['mul', (a, b) => a * b],
]);

function calculate(line) {
  const [name, ...rest] = line.split(' ');
  const op = operations.get(name);
  if (!op) return `Unknown operation: ${name}. Try ${[...operations.keys()].join(', ')}.`;
  return op(...rest.map(Number));
}

calculate('add 2 3')                          // → 5
calculate('mul 4 5')                          // → 20
calculate('pow 2 8')                          // → 'Unknown operation: pow. Try add, sub, mul.'
operations.set('pow', (a, b) => a ** b);     // a new operation: one line, no new branch
calculate('pow 2 8')                          // → 256
```

`calculate` never changes. Adding `pow` was one `set`, from outside the function, and the "unknown" message lists whatever is in the table, so it stays correct by itself. The command registry is the same idea:

```js
if (name === 'help') { … } else if (name === 'model') { … } else if …   // ✗ a branch per command

const def = commands.get(name);                                       // ✓ one lookup for all of them
await def.handler(args, ctx);
```

With the table, adding a command is one `register()` call, and an extension can do it at run time without editing the router. The registry's API:

```js
register(def)   // { name, description, usage?, aliases?, idle?, handler(args, ctx) }
get(name)       // by name or alias
handle(line, ctx) → { ok, output? }   // parse → look up → await handler → emit command_run
```

Aliases are a second `Map`, from alias to name: `get('q')` looks up `'q'`, finds `'quit'`, and returns the `quit` definition. `register` refuses a name or alias that's already taken (`a command named /q is already registered`), because two commands answering to one name would make one of them unreachable.

Every outcome is text. A handler returns the text to print, and unknown commands and handler errors come back **as text** too, never as a throw and never as a model call:

```
/frobnicate          → Unknown command: /frobnicate. Try /help.
/boom (it throws)    → /boom failed: disk full
```

That's Day 9's rule for tools, applied to commands: a failure is something to report, not something that takes the harness down. Only a successful run emits `command_run`, so anything that subscribes to it (an extension, say, from Day 22) hears only about commands that actually ran.

The table needs a name to look up, which means something has to pull the name out of the line.

### 3. A boring parser

A command line is a name, then arguments. `/new "my session" x` → `{ name: 'new', args: ['my session', 'x'] }`. Split on whitespace and let double quotes group. No escapes, no single quotes, no nesting. Write the limits in the file header. A bare `/` is not a command, and neither is `/Users/me/app.js why?`.

From the reference parser:

```js
parse('/help')                     // → { name: 'help', args: [] }
parse('/model 2')                  // → { name: 'model', args: ['2'] }
parse('/new "my session" x')       // → { name: 'new', args: ['my session', 'x'] }
parse('/')                         // → null
parse('/Users/me/app.js why?')     // → null: a message that starts with a path
splitArgs('a   b')                 // → ['a', 'b']    several spaces count as one
splitArgs('""')                    // → ['']          empty quotes are an empty argument
splitArgs('"unclosed quote runs')  // → ['unclosed quote runs']
```

"Boring" is the point. A user can predict exactly what a boring parser does, and its few limits fit in one comment.

A **name** is a letter, then letters, digits, `_` or `-`: the same rule as `PromptUI`'s. `register()` checks **aliases** against it too. An alias like `/?` would show up in `/help` and then answer "Not a command" when typed, because the parser's name rule can't read it:

```js
registry.register({ name: 'help', aliases: ['?'], handler });
// TypeError: invalid alias /? for /help: it could never be typed
```

With a name and its arguments in hand, the handler runs. The last question is what it's allowed to touch.

### 4. The command context

A command gets exactly what it needs, through one object. Commands get a `CommandContext`, with everything they may touch and nothing more:
- `ui`, `provider`, `bus`, `commands`, `cwd`;
- `getSession()`, `newSession()`, `openSession(path)` and `listSessions()` (Day 19);
- `isBusy()`, which the registry checks for `idle` commands;
- `quit(code)`.

This is a small, explicit API, and Day 22's extensions get a similar one.

It's dependency injection again (Day 2): a handler like `/session` reads `ctx.getSession()` instead of reaching for a global, so a test can hand it a fake session and a fake provider.

Note that the context has functions such as `getSession()`, not the session itself. The reason is a JavaScript detail that catches people. An object property holds a value: if that value is an object, the property keeps pointing at that same object, even after the variable it came from is given a new one. A function that reads the variable looks it up each time it's called. Here is the difference with a bank account:

```js run
let account = { owner: 'Ana', balance: 100 };

const snapshot = { account };                  // ✗ holds the object that was current then
const live = { getAccount: () => account };    // ✓ looks up the variable every time

account = { owner: 'Ben', balance: 0 };        // switch to a new account

snapshot.account.owner                         // → 'Ana'
live.getAccount().owner                        // → 'Ben'
```

`snapshot.account` still points at Ana's account, because assigning a new object to `account` changes the variable, not the object the property already holds. `getAccount` is a closure over the variable itself (Day 2), so it sees the reassignment. After `/new`, the current session is a different object, and every later command must see the new one, so the context hands out `getSession()`, never the session.

Commands that only read, like `/session`, are simple. `/model` changes something, so it gets more care.

### 5. `/model` touches provider config only

Switching models changes one setting, after checking it's safe. `/model` with no argument lists `provider.listModels()` (Ollama: `GET /api/tags`) and marks the active one with `*`. `/model <name|number>`:
- **refuses a model that isn't installed**, before changing anything. A typo would otherwise break every message, and from Day 26 `/model` saves your choice, so it would break every launch too. A name without a tag means `:latest`, as in Ollama;
- calls `provider.setModel` and records the model in the session header;
- **warns** if the model's `/api/show` capabilities lack `tools`: it can't call them, and Ollama may refuse every request that sends them.

The loop and the tools never hold a model name. The provider is the only place that knows which model is in use, so switching is one call in one place, and the next request uses the new model.

The tag rule in practice: with `llama3.2:latest` installed, `/model llama3.2` switches to `llama3.2:latest`. With only `qwen3.5:4b` installed, `/model qwen3.5` is refused, because the `:latest` it means isn't there. A model without tool support switches, but with a warning:

```
model → tiny — warning: this model does not list "tools". It can't call them, and Ollama may refuse every request that sends them
```

The order is the point of this concept: check first, change second. A refused switch leaves the harness exactly as it was, which is why *By tonight*'s refusal can say "the model is still qwen3.5:9b-mlx".

## Build

### 18.1 `src/shared/commands.js` — Core

Typedefs `CommandDefinition` and `CommandContext` (concept 4).

The types come first so the registry, the built-in commands and, later, extensions all agree on the shape of a command and of what it receives.

### 18.2 `src/commands/registry.js` — Core

`class CommandRegistry` with `register(def)` (rejecting duplicate names, alias clashes, and names or aliases outside the name rule; returns an unregister function), `unregister`, `get`, `list`, `parse(line)`, and `handle(line, ctx)`, which refuses an `idle` command while `ctx.isBusy?.()` is true. Export `splitArgs(text)` as well.

Some hints:
- **Two `Map`s:** one from name to definition, one from alias to name. Insertion order gives `list()` the registration order that `/help` prints.
- **`parse`** can match the name with one regular expression (`/` and a name, then optional whitespace and the rest), then hand the rest to `splitArgs`.
- **`handle`'s order:** parse, look up, check `idle`, then run the handler inside `try`, and emit `command_run` only after it succeeds.

The order in `handle` is concepts 1 and 2 together. The `idle` check comes before the handler runs, so a refused `/new` changes nothing, and `command_run` comes last, so it's only emitted for a command that finished. The handler is awaited inside the `try`, which is what turns an async handler's rejection into `/boom failed: …` text instead of an unhandled rejection (Day 14).

### 18.3 `src/commands/builtin/index.js` — Core

`createBuiltinCommands()` returns `/help` (alias `/h`), `/session` (id, entry count, model, cwd, file), `/new` (idle), `/model [name]` and `/quit` (aliases `/exit`, `/q`). Add `listModels()` to `OllamaProvider` (`GET /api/tags` → `[{ name, size }]`) and to `ScriptedProvider`.

`GET /api/tags` answers `{ models: [{ name, size, … }] }`, so `listModels()` maps each entry to `{ name, size }`. `/model 2` counts from 1, as the list does. A number past the end answers `No model number 9.` rather than switching to nothing.

Each built-in is an ordinary `CommandDefinition`, registered the same way an extension's command will be on Day 22. Nothing about the built-ins is special to the registry.

### 18.4 Wire it — Core

In `createApp`:
- build the registry and the `ctx` object, and expose them as `app.commands` and `app.ctx` (plus a `get session()` getter), because tests and later days drive commands through them. `ctx.isBusy` is `() => bridge.busy`;
- bridge `onCommand` → `commands.handle(line, ctx)`, printing each output line with `ui.printSystem`;
- `newSession()` creates a fresh `SessionManager` and emits `session_shutdown` and `session_start`. The old session needs no "save" step, because it was saved as it went (Day 17).

Keep the current session in a variable that `newSession()` replaces, and have `getSession()` return that variable. That's what lets every command see the new session at once.

That's the bank-account example from concept 4, for real: `newSession()` reassigns the variable, and every `getSession()` after it reads the new one. `ctx.isBusy` is a function for the same reason, since `bridge.busy` changes all the time.

### 18.5 Course tests — Core

Copy `course-tests/day-18/`. It covers parsing, `splitArgs`, register/alias/unregister, unknown commands, error capture, `command_run`, every advertised name being typeable, idle commands, `/help`, `/model` (list, switch by number, the no-`tools` warning, refusing a model that isn't installed, `:latest`), `/quit`, and `listModels`.

Live: `/help`, `/session`, `/model`, `/model 1`, `/model nope`, `/frobnicate`. Send a long request and type `/new` while it runs. Then make sure a normal sentence still streams an answer. Commit `day-18: slash commands`.

The last check matters more than it looks. A command rule that's slightly too broad would quietly route some ordinary messages away from the model, so make sure plain sentences still reach it.

### 18.6 `/clear` and `/tools` — Stretch

`/tools` lists registered tools, marking `needsApproval` and `readOnly`. `/clear` is just an alias of `/new`; decide whether that is honest or confusing, and write down why.

## Check

The harness now has commands of its own, and they never reach the model. A `Map` from name to definition is the whole router, so a command is one registration, and an extension will add one the same way. The parser is boring on purpose, every advertised name can be typed, and every outcome, an unknown command and a crashing handler included, comes back as a line of text. Commands run even mid-run, except the `idle` ones that would move a running conversation into another session. And `/model` checks before it changes anything, so a typo leaves the harness as it was.

Tomorrow, [Day 19](day-19.md) adds the command that makes yesterday's files pay off: `/resume`, which picks up an old conversation where you left it.

Before you move on, check:

- [ ] `node --test tests/course/day18-*` green (11 tests)
- [ ] `/help`, `/session`, `/model`, `/quit` and an unknown command all work live
- [ ] Commit `day-18: slash commands`

Solution: `src/commands/` and `src/shared/commands.js` in [`solutions/checkpoint-3/`](solutions/checkpoint-3/).

## Stuck?

<details><summary>Quoted arguments come out split</summary>

Walk the string character by character, flipping an `inQuotes` flag on `"`, and only split on whitespace when `!inQuotes`. Track `hasToken`, so that `""` yields an empty argument.
</details>

<details><summary>The prompt shows up before the command's output</summary>

`PromptUI` must not re-prompt after emitting `command`. The bridge re-poses it after the command finishes.
</details>

<details><summary><code>/model</code> says a model isn't installed, but <code>ollama list</code> shows it</summary>

Compare the names exactly. A name without a tag means `:latest`, so `/model qwen3.5` looks for `qwen3.5:latest`. Use the full name with its tag (`qwen3.5:4b`), or the number from the `/model` list.
</details>

<details><summary>A command's output comes out as one long line, or with only the first line prefixed</summary>

Split the output on `'\n'` and print each line with `ui.printSystem`, so every line gets its `  · ` prefix.
</details>

## Common mistakes

- Letting `/help` fall through to the model. It happens when routing is decided in more than one place, so one path checks for commands and another doesn't.
- Splitting before grouping quotes, so `"a b"` arrives as two arguments. `split(' ')` is the first thing everyone reaches for, and it knows nothing about quotes.
- An if/else router that grows a branch per command. It's fine for two commands, and each new one feels too small to justify a redesign.
- An alias `/help` advertises but the parser can't read (`/?`). The registry and the parser are written separately, and only the name rule ties them together.
- Switching to a model that isn't installed, then failing on every message. Changing first and checking later feels natural, but by then the bad name is already in use.

## Self-check

1. Where does the command-vs-message decision live, and why not inside the loop?
2. What does `parse('/new "my session with spaces"')` return?
3. Why does a `Map` dispatch table beat an if/else chain?
4. What exactly does `/model` change, what does it deliberately not touch, and when does it refuse?
5. Commands run even mid-run. Which ones must not, and why?

Answers: [self-check-answers.md](self-check-answers.md#day-18).

## Further reading

- Ollama, [List models](https://docs.ollama.com/api/tags)
- Wikipedia, [Dispatch table](https://en.wikipedia.org/wiki/Dispatch_table)
- Claude Code and Pi both ship slash commands. Skim the list in Pi's `packages/coding-agent` README for ideas.

---
← [Day 17](day-17.md) · [Curriculum home](README.md) · Next: [Day 19 — Resume: it remembers you](day-19.md) →
