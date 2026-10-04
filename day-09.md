# Day 9 — Tool Contracts and the Registry

**Phase:** Week 2 — Provider & tools

## By tonight

```js
const registry = new ToolRegistry();
registry.registerTool(lookupTool);
registry.toProviderTools();
// → [{ name: 'lookup', description: 'Look up a term in THIS project…', parameters: {…} }]   ← plain JSON, no functions
await provider.chat(messages, registry.toProviderTools());                                 // the model now "sees" lookup
```

Tools have a contract (`ToolDefinition`, `ToolResult`), a hand-written argument validator, and a `Map`-backed registry. You also measure how much a tool's **description** changes what the model does, which matters more than almost anything else you'll do today.

## Why it matters

Tools are the agent's hands. Before you build real ones (Days 10–11), you fix the rules every tool follows: what it declares, what it returns, what failure looks like, and what happens when the model sends nonsense arguments. That last one is a policy, and you set it **once**, today.

## Concepts

### 1. Two shapes, plus the one you already have

**A tool is an object that describes itself and knows how to run.** This is the contract every tool in the harness follows:
- **`ToolDefinition`** = `{ name, label?, description, parameters /* JSON Schema */, execute(args, { signal }), needsApproval?, readOnly? }`
- **`ToolResult`** = `{ content, isError, details? }`. **Failures are results, not exceptions.** `details` is for the UI and the logs, and never goes to the model.
- What the loop hands to `executeTool` is the **`ToolCall`** from Day 7, `{ id, name, arguments, parseError? }`: the same shape, under the same name. One vocabulary, no aliases.

Here is the `lookup` tool from *By tonight*, written out in full:

```js
const lookupTool = {
  name: 'lookup',                                   // what the model calls
  label: 'Glossary lookup',                         // what the UI shows
  description:                                      // written for the model (concept 5)
    "Look up a term in THIS project's glossary (docs/glossary.md). " +
    'Only for terms specific to this project; never for general knowledge.',
  parameters: {                                     // a JSON Schema for the arguments (concept 3)
    type: 'object',
    properties: { term: { type: 'string', description: 'The term to look up' } },
    required: ['term'],
    additionalProperties: false,
  },
  // plain-object arguments, and the run's signal (Day 3)
  async execute({ term }, { signal }) {
    // … look the term up …
    return { content: `(glossary entry for ${term})`, isError: false };
  },
  readOnly: true,                                   // harness policy: it changes nothing (Day 20)
};
```

The fields fall into two groups. `name`, `description` and `parameters` are **for the model**: they're all it knows about the tool. `execute`, `label`, `needsApproval` and `readOnly` are **for the harness**. `execute` is code, and `needsApproval` and `readOnly` are policy: whether the user must approve a call (Day 12), and whether the tool can change anything (Day 20). The model never sees them.

**A tool reports failure by returning it.** A missing glossary entry isn't a crash; it's something the model should hear and adapt to (Day 5's operational errors):

```js
{ content: 'tool pair: an assistant message with tool calls, plus one result per call.', isError: false }
{ content: "No glossary entry for 'banana'.", isError: true, details: { term: 'banana' } }
```

### 2. The malformed-arguments policy (fixed for the whole course)

**Models send bad arguments, and the harness has to decide, once, what happens then.** When arguments are broken JSON (`parseError` from Day 8) or fail the schema, the harness returns:

```
ToolResult {
  isError: true,
  content: "Invalid arguments for read: missing required property 'path'. Retry the call with corrected arguments."
}
```

The model reads that result like any other, and usually fixes the call. A conversation goes like this:

```
model    read {"path": 42}
harness  Invalid arguments for read: path must be string, got number. Retry the call with corrected arguments.
model    read {"path": "notes.txt"}
harness  (the file's contents)
```

There are three things it must **never** do:
- **throw into the loop**, which would kill the run;
- **"fix" the arguments and run anyway**, which executes something the model didn't ask for;
- **retry silently**, which hides the problem.

Day 12's `executeTool` implements this.

### 3. A small JSON Schema checker

**JSON Schema describes the shape of JSON data, in JSON.** A tool's `parameters` is one: the model reads it to know what to send, and the harness uses it to check what came back. Here is a schema like the one Day 10's `read` tool will have:

```js
const schema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'File path, relative to the workspace root' },
    offset: { type: 'integer', description: '1-based first line' },
    limit: { type: 'integer', description: 'How many lines to read' },
  },
  required: ['path'],
  additionalProperties: false,
};
```

It says: the arguments are an object. `path` is a string, and it's required. `offset` and `limit` are whole numbers, and optional. Nothing else is allowed.

**Check only what models get wrong.** You don't need all of JSON Schema. Check `type`, `required`, `properties` (recursively), `enum`, `items` and `additionalProperties: false`: that catches what models actually get wrong. `validateArguments(schema, value)` returns `{ ok: true }` or `{ ok: false, error }`, so a validation failure is an *expected branch*, not an exception. Ajv is the optional Stretch, but only after yours works.

```js
validateArguments(schema, { path: 'notes.txt' })
// → { ok: true }
validateArguments(schema, {})
// → { ok: false, error: "missing required property 'path'" }
validateArguments(schema, { path: 42 })
// → { ok: false, error: 'path must be string, got number' }
validateArguments(schema, { path: 'a', limit: 1.5 })
// → { ok: false, error: 'limit must be integer, got number' }
```

Each error names the property and says what was wrong, because the model reads it and must be able to fix the call. Notice that JSON has one number type, as JavaScript does (Day 2), so "integer" means `Number.isInteger(value)`.

**Models invent arguments.** When we ran `qwen2.5:0.5b`, it called `read` with `{ "path": "toy/agent.mjs", "output": "import { moduleA } …" }`: its *guess* at the file, stuffed into an argument that doesn't exist. Then it answered from the guess. JSON Schema allows extra properties unless the schema says `additionalProperties: false`, so give your tools that line, and make the validator refuse unexpected properties by name, listing the allowed ones: `unexpected property 'output' (allowed: path, offset, limit)`. The model reads that and can correct itself.

Python contrast: this is what the `jsonschema` package, or a pydantic model, does for you. Today you write a small one, so you know exactly what it checks.

### 4. `Map`, not a plain object

**A plain object comes with keys you didn't put there.** Every object inherits properties from `Object.prototype`, so an empty object already "has" a `toString`, and one special key doesn't store anything at all:

```js run
const tools = {};
'toString' in tools                       // → true: inherited, not registered
tools.toString                            // → [Function: toString]

tools['__proto__'] = { name: '__proto__' };
Object.keys(tools)                        // → []: no key was added
tools.name                                // → '__proto__': the object's prototype was replaced instead
```

A tool named `toString` or `__proto__` is a real possibility. A `Map` has no prototype-key traps, a real `.size`, and insertion order:

```js run
const registry = new Map();
registry.has('toString')                  // → false
registry.set('__proto__', { name: '__proto__' });
registry.size                             // → 1: stored like any other key
```

`set`, `get`, `has`, `delete` and `size` are most of what you need, and iterating a `Map` visits entries in the order they were added. That order is why `getTools()` can return tools in registration order. Python contrast: a `Map` behaves like a `dict`; a plain JavaScript object is something different, with inherited keys.

**But the wire is JSON.** `toProviderTools()` returns plain objects with `execute`, `needsApproval` and `readOnly` stripped. (`JSON.stringify` silently *omits* function-valued properties, so a leak wouldn't even show up as an error.) Policy fields are worse, because they're data:

```js run
JSON.stringify({ name: 'lookup', execute() {}, needsApproval: true })
// → '{"name":"lookup","needsApproval":true}'      the function vanished; the policy flag went out
```

So build each provider tool from the three fields the model needs, by name, rather than copying the definition and deleting fields. Copying and deleting leaks the next field anyone adds.

### 5. Write descriptions for the model

**The model chooses tools *only* from their names, descriptions and schemas.** It can't read your code. Good descriptions say:
- **what it does and what it returns**: "Returns the file content…";
- **when to use it, and when to use something else**: "To change part of a file, prefer edit";
- **the limits**: "Paths are relative to the workspace root. Cannot read binary files.";
- **each parameter's meaning and format**: `offset` is "1-based first line".

Compare the two descriptions you'll measure in 9.4. The vague one, `Looks things up.`, doesn't say *what* it looks up, so a question about "tool pair" gives the model no reason to think of it. The clear one names the project's glossary, and also says when *not* to use it.

If a human couldn't tell which of two tools to use from their descriptions, the model can't either.

### 6. Measure, don't anecdote

**One run tells you almost nothing.** A model is not deterministic: the same prompt can call a tool on one run and answer in prose on the next. One run that calls a tool tells you almost nothing; **ten** runs that call it nine times tell you something. Count, and compare counts.

**Small differences are noise.** With ten trials, 9/10 against 8/10 could easily swap places on the next run. 9/10 against 1/10 is a real difference. Before you conclude that a change helped, ask whether the gap is bigger than the run-to-run wobble. Day 29 turns this into evals, with more trials and proper statistics.

## Build

**Files today:** `src/shared/tool-schemas.js`, `src/tools/tool-registry.js`, `tests/tool-registry-roundtrip.test.js`, `scripts/tool-description-experiment.js` and `notes/day-09.md`.

### 9.1 `src/shared/tool-schemas.js` — Core

- JSDoc typedefs: `ToolDefinition`, `ToolContext` (`{ signal? }`) and `ToolResult`. For calls, import `ToolCall` from `message-schemas.js`.
- `validateToolDefinition(def)` returns `{ ok: true } | { ok: false, error }` naming the first bad field. Its rules:
  - `name` is 1–64 characters of `[A-Za-z0-9_.-]`;
  - `description` is a non-empty string;
  - `parameters` is an object with `type: 'object'`;
  - `execute` is a function;
  - `needsApproval`, if present, is a boolean.
- `validateToolResult(result)`: `content` is a string, `isError` is a boolean, and `details`, if present, is an object.
- `validateArguments(schema, value, path = 'arguments')`, as in concept 3. Error messages name the property: `"missing required property 'path'"`, `"limit must be integer, got number"`, `"unexpected property 'output' (allowed: path, offset, limit)"`.
- A comment block with the malformed-arguments policy, word for word. Day 12 refers to it.

The name rule is a regular expression: `/^[A-Za-z0-9_.-]{1,64}$/.test(name)`. `^` and `$` anchor it to the whole string, so `'look up'` (with a space) fails. To report a value's type in an error, remember that `typeof null` and `typeof []` are both `'object'` (Day 2), so check those two first.

### 9.2 `src/tools/tool-registry.js` — Core

```js
export class ToolRegistry {
  // validate; DUPLICATE NAME → throw (a bug in your code, not model input); returns an unregister fn
  registerTool(def) { … }
  getTool(name) { … }
  getTools() { … }               // in registration order
  unregisterTool(name) { … }     // → boolean
  // → [{ name, description, parameters }], optionally filtered by an allow-list of names
  toProviderTools(enabled) { … }
}
```

Keep the tools in a private `#tools = new Map()`. A duplicate name is a programmer error (Day 5), so throw at once. `registerTool` returns a small closure, `() => this.unregisterTool(def.name)`, so whoever registered a tool can remove it later without remembering its name. Day 22's extensions use exactly that. For `toProviderTools`, `filter` by the allow-list and `map` each tool to `({ name, description, parameters })` (concept 4).

### 9.3 Course tests and your own — Core

Copy `course-tests/day-09/` and make it green. Then add your own test, `tests/tool-registry-roundtrip.test.js`, proving that `JSON.parse(JSON.stringify(registry.toProviderTools()))` deep-equals the original, so nothing that isn't JSON leaks out.

The trick works because the round trip *drops* anything JSON can't hold. A function, or a property whose value is `undefined`, is missing from the copy, so `deepEqual` sees a difference and fails. A clean result survives unchanged.

### 9.4 Does the description matter? Measure it — Core

Write `scripts/tool-description-experiment.js`. It registers **one** tool, `lookup`, which looks terms up in "this project's glossary", and asks the model two questions:
- a **project** question, where the tool *should* be called: `What does 'tool pair' mean?`;
- a **general** question, where it should *not*: `What is the capital of France?`.

Run every combination of two descriptions and two thinking settings, **10 trials each**, and print how often `lookup` was called:

| Description | Text |
|---|---|
| clear | `Look up a term in THIS project's glossary (docs/glossary.md). Only for terms specific to this project; never for general knowledge.` |
| vague | `Looks things up.` |

For thinking, construct the provider as `new OllamaProvider({ think: false })` or `{ think: true }`. It takes about 5 minutes. Each cell of the table is one counting loop:

```js
let called = 0;
for (let i = 0; i < 10; i++) {
  const reply = await provider.chat([{ role: 'user', content: prompt }], tools);
  if (reply.toolCalls.some((c) => c.name === 'lookup')) called++;
}
```

What we measured on `qwen3.5:4b`:

```
thinking  description  project question  general question
false     clear        9/10              0/10
false     vague        1/10              0/10
true      clear        10/10             0/10
true      vague        8/10              0/10
```

Put your table in `notes/day-09.md` and answer two questions. When does the description matter most? What does thinking buy you, and what does it cost (time it)? Commit `day-09: tool schemas + registry`.

To time it, take `performance.now()` before and after each group of trials, or wrap them in `console.time(label)` and `console.timeEnd(label)`.

### 9.5 Ajv — Stretch

`npm i ajv`. Validate arguments with Ajv and compare its error messages with yours on the same five bad inputs. Write in `notes/day-09.md` whether the dependency is worth it. Note what stays hand-written either way: "`execute` is a function" can't be expressed in JSON Schema, because schemas describe data, not behaviour.

### 9.6 Two tools that overlap — Stretch

Register `read` and `bash` together and ask "Show me what's in notes.txt" ten times. Which tool does the model pick? Change `read`'s description to say when to prefer it over `cat` and count again. (When we tried, the counts barely moved: the model leaned on `bash` either way. Small models have habits that descriptions don't always override.)

## Check

- [ ] `node --test tests/course/day09-*` green (12 tests)
- [ ] Your round-trip test passes
- [ ] `notes/day-09.md` has your description experiment table, and your two answers
- [ ] Commit `day-09: tool schemas + registry`

Solution: `src/shared/tool-schemas.js`, `src/tools/tool-registry.js` and `scripts/tool-description-experiment.js` in [`solutions/checkpoint-1/`](solutions/checkpoint-1/).

## Stuck?

<details><summary>How should <code>validateArguments</code> recurse?</summary>

For each `[key, subSchema]` in `schema.properties`, if `key in value`, call `validateArguments(subSchema, value[key], key)` and return the first failure. Do the same for `items` over array elements, with a path like `files[2]`.
</details>

<details><summary>Integers vs numbers</summary>

`Number.isInteger(1.0) === true` and `Number.isInteger(1.5) === false`. JSON has no separate integer type, so `1.0` *is* an integer.
</details>

<details><summary><code>registerTool</code> rejects a tool that looks fine</summary>

Read the error: it names the field. The usual culprits are a `parameters` without `type: 'object'`, and a `name` with a space or another character outside `[A-Za-z0-9_.-]`.
</details>

<details><summary>My round-trip test fails</summary>

Something in `toProviderTools()` isn't plain JSON: a function, a property set to `undefined`, or a policy field copied along with the rest. Build each entry from `name`, `description` and `parameters` only.
</details>

<details><summary>My experiment table looks different from yours</summary>

Expected. Your model, your Ollama version and plain chance all move the numbers. The pattern is what matters: compare the clear row against the vague row, and thinking off against on. If two counts differ by only one or two out of ten, call it noise.
</details>

## Common mistakes

- Throwing from the argument-validation path, so one bad tool call kills the run.
- Silently letting the last registration win on duplicate names.
- Leaking `needsApproval` into the payload. It's harness policy; the model has no say in it.
- Building `toProviderTools` by copying the whole definition and deleting fields. The next field anyone adds leaks.
- Judging a description from one run.

## Self-check

1. Why a `Map` for the registry, and why must `toProviderTools()` still return plain objects?
2. The model sends `arguments: '{"path": '`. What does the harness return, and what must it never do?
3. What does `toProviderTools()` leave out, and why?
4. In your experiment, when did the description matter most, and why might thinking narrow the gap?

Answers: [self-check-answers.md](self-check-answers.md#day-9).

## Further reading

- Anthropic, [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [Understanding JSON Schema](https://json-schema.org/understanding-json-schema/), especially [types](https://json-schema.org/understanding-json-schema/reference/type) and [objects](https://json-schema.org/understanding-json-schema/reference/object) (`required`, `additionalProperties`)
- MDN, [`Map`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map) · [`JSON.stringify`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify) (see how functions are handled)

---
← [Day 8](day-08.md) · [Curriculum home](README.md) · Next: [Day 10 — The workspace jail, `read` and `write`](day-10.md) →
