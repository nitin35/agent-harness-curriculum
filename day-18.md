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

The harness can now talk about *itself*. Lines starting with `/` never reach the model.

## Why it matters

Every real harness has commands: `/help`, `/model`, `/clear`, `/resume`, `/compact`. They're also the main way extensions (Day 22) add features. The design is a **dispatch table**: adding a command means one registration, never another `if` branch in the router.

## Concepts

### 1. Routing at one boundary

**Commands are for the harness; messages are for the model.** `PromptUI` already emits `command { line }` for lines that follow the command rule (Day 15: `/` and a name). The bridge runs commands **immediately**, even mid-run (so `/quit` always works), and re-poses the prompt afterwards. Commands never reach the model.

The path of `/model 2`: `PromptUI` sees a command and emits `command { line: '/model 2' }`. The bridge passes the line to the command registry. The registry finds `model` and runs its handler, and the bridge prints whatever text comes back. The loop and the model are never involved, so a command costs no tokens and no waiting.

**Except the ones that change the session.** `/new` mid-run would swap the session under a running conversation, and that run's messages would start the "fresh" one. So a command can say `idle: true`, and while a run is in flight it answers *"/new works between runs: wait for the answer, or press Ctrl+C first."* `/new`, `/resume` (Day 19) and `/compact` (Day 25) are idle commands.

### 2. A `Map` is the dispatch table

**A table from names to handlers.** A *dispatch table* replaces a chain of `if`s with a lookup:

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

**Every outcome is text.** A handler returns the text to print. Unknown commands and handler errors come back **as text**, never as a throw and never as a model call:

```
/frobnicate          → Unknown command: /frobnicate. Try /help.
/boom (it throws)    → /boom failed: disk full
```

Only a successful run emits `command_run`, so anything that subscribes to it (an extension, say, from Day 22) hears only about commands that actually ran.

### 3. A boring parser

**Name, then arguments.** `/new "my session" x` → `{ name: 'new', args: ['my session', 'x'] }`. Split on whitespace and let double quotes group. No escapes, no single quotes, no nesting. Write the limits in the file header. A bare `/` is not a command, and neither is `/Users/me/app.js why?`.

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

A **name** is a letter, then letters, digits, `_` or `-`: the same rule as `PromptUI`'s. `register()` checks **aliases** against it too. An alias like `/?` would show up in `/help` and then answer "Not a command" when typed:

```js
registry.register({ name: 'help', aliases: ['?'], handler });
// TypeError: invalid alias /? for /help: it could never be typed
```

### 4. The command context

**A command gets exactly what it needs, through one object.** Commands get a `CommandContext`, with everything they may touch and nothing more:
- `ui`, `provider`, `bus`, `commands`, `cwd`;
- `getSession()`, `newSession()`, `openSession(path)` and `listSessions()` (Day 19);
- `isBusy()`, which the registry checks for `idle` commands;
- `quit(code)`.

This is a small, explicit API, and Day 22's extensions get a similar one.

It's dependency injection again (Day 2): a handler like `/session` reads `ctx.getSession()` instead of reaching for a global, so a test can hand it a fake session and a fake provider. Note that the context has functions such as `getSession()`, not the session itself. After `/new`, the current session is a different object, and every later command must see the new one.

### 5. `/model` touches provider config only

**Switching models changes one setting, after checking it's safe.** `/model` with no argument lists `provider.listModels()` (Ollama: `GET /api/tags`) and marks the active one with `*`. `/model <name|number>`:
- **refuses a model that isn't installed**, before changing anything. A typo would otherwise break every message, and from Day 26 `/model` saves your choice, so it would break every launch too. A name without a tag means `:latest`, as in Ollama;
- calls `provider.setModel` and records the model in the session header;
- **warns** if the model's `/api/show` capabilities lack `tools`: it can't call them, and Ollama may refuse every request that sends them.

The loop and the tools never hold a model name.

The tag rule in practice: with `llama3.2:latest` installed, `/model llama3.2` switches to `llama3.2:latest`. With only `qwen3.5:4b` installed, `/model qwen3.5` is refused, because the `:latest` it means isn't there. A model without tool support switches, but with a warning:

```
model → tiny — warning: this model does not list "tools". It can't call them, and Ollama may refuse every request that sends them
```

## Build

### 18.1 `src/shared/commands.js` — Core

Typedefs `CommandDefinition` and `CommandContext` (concept 4).

### 18.2 `src/commands/registry.js` — Core

`class CommandRegistry` with `register(def)` (rejecting duplicate names, alias clashes, and names or aliases outside the name rule; returns an unregister function), `unregister`, `get`, `list`, `parse(line)`, and `handle(line, ctx)`, which refuses an `idle` command while `ctx.isBusy?.()` is true. Export `splitArgs(text)` as well.

Some hints:
- **Two `Map`s:** one from name to definition, one from alias to name. Insertion order gives `list()` the registration order that `/help` prints.
- **`parse`** can match the name with one regular expression (`/` and a name, then optional whitespace and the rest), then hand the rest to `splitArgs`.
- **`handle`'s order:** parse, look up, check `idle`, then run the handler inside `try`, and emit `command_run` only after it succeeds.

### 18.3 `src/commands/builtin/index.js` — Core

`createBuiltinCommands()` returns `/help` (alias `/h`), `/session` (id, entry count, model, cwd, file), `/new` (idle), `/model [name]` and `/quit` (aliases `/exit`, `/q`). Add `listModels()` to `OllamaProvider` (`GET /api/tags` → `[{ name, size }]`) and to `ScriptedProvider`.

`GET /api/tags` answers `{ models: [{ name, size, … }] }`, so `listModels()` maps each entry to `{ name, size }`. `/model 2` counts from 1, as the list does. A number past the end answers `No model number 9.` rather than switching to nothing.

### 18.4 Wire it — Core

In `createApp`:
- build the registry and the `ctx` object, and expose them as `app.commands` and `app.ctx` (plus a `get session()` getter), because tests and later days drive commands through them. `ctx.isBusy` is `() => bridge.busy`;
- bridge `onCommand` → `commands.handle(line, ctx)`, printing each output line with `ui.printSystem`;
- `newSession()` creates a fresh `SessionManager` and emits `session_shutdown` and `session_start`. The old session needs no "save" step, because it was saved as it went (Day 17).

Keep the current session in a variable that `newSession()` replaces, and have `getSession()` return that variable. That's what lets every command see the new session at once.

### 18.5 Course tests — Core

Copy `course-tests/day-18/`. It covers parsing, `splitArgs`, register/alias/unregister, unknown commands, error capture, `command_run`, every advertised name being typeable, idle commands, `/help`, `/model` (list, switch by number, the no-`tools` warning, refusing a model that isn't installed, `:latest`), `/quit`, and `listModels`.

Live: `/help`, `/session`, `/model`, `/model 1`, `/model nope`, `/frobnicate`. Send a long request and type `/new` while it runs. Then make sure a normal sentence still streams an answer. Commit `day-18: slash commands`.

### 18.6 `/clear` and `/tools` — Stretch

`/tools` lists registered tools, marking `needsApproval` and `readOnly`. `/clear` is just an alias of `/new`; decide whether that is honest or confusing, and write down why.

## Check

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

- Letting `/help` fall through to the model.
- Splitting before grouping quotes, so `"a b"` arrives as two arguments.
- An if/else router that grows a branch per command.
- An alias `/help` advertises but the parser can't read (`/?`).
- Switching to a model that isn't installed, then failing on every message.

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
