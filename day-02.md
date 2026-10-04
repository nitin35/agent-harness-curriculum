# Day 2 — JavaScript Core, by Refactoring the Toy

**Phase:** Week 1 — Hello, agent

## By tonight

The toy agent from Day 1 still works exactly the same, but it is now four small modules with typed (JSDoc) interfaces:

```
toy/
├── agent.mjs       ← Day 1's single file, kept for comparison
├── ollama.mjs      createOllamaClient({ model }) → { model, chat }
├── bash-tool.mjs   bashToolSpec, runBash(command)
├── loop.mjs        runTurns({ client, messages, confirm, runTool })
└── main.mjs        the REPL
```

You will also understand the parts of JavaScript that surprise programmers coming from C++ or Python: how values quietly convert themselves, what a closure captures, and why `this` sometimes goes missing.

## Why it matters

Every later module is written in this style: named ES exports, factories or small classes, JSDoc types, and data you copy instead of changing. Learning the style on a 70-line program you already understand is much easier than learning it on a new one.

These ideas are the backbone of the rest of the course. Misunderstanding them rarely causes an error today. It causes one weeks later, as a message that quietly changed or a callback that lost its `this`. Take your time with this section.

## Concepts

**How to read this section.** Keep a Node REPL open (type `node` in a terminal) and try the examples as you read. A comment like `// → 3.5` shows what Node gives back. The REPL is more forgiving than your `.mjs` files in a few ways (concept 6 explains why), so the examples that depend on the difference say *run this in a file*.

### 1. Values, types and coercion

**Seven primitive types, and everything else is an object.** A *primitive* is a simple value that can't be changed: `string`, `number`, `bigint`, `boolean`, `undefined`, `symbol` and `null`. Everything else (plain objects, arrays, functions, dates, errors) is an *object*. The `typeof` operator tells you which kind of value you have:

```js run
typeof 'hello'        // → 'string'
typeof 42             // → 'number'
typeof true           // → 'boolean'
typeof undefined      // → 'undefined'
typeof { a: 1 }       // → 'object'
typeof (() => 1)      // → 'function'   functions are objects, but typeof names them separately
```

It has two quirks. `typeof null` is `'object'`, a bug from 1995 that can never be fixed without breaking old websites. And arrays are objects too, so `typeof` can't tell an array from a plain object: use `Array.isArray(x)` for that.

**Two kinds of "nothing".** Python has one empty value, `None`. JavaScript has two:
- **`undefined` means "never set"**: a variable declared without a value, a property that doesn't exist, an argument nobody passed, or the result of a function that doesn't `return`.
- **`null` means "deliberately empty"**: someone set it on purpose.

The difference matters for the harness, because messages travel as JSON, and JSON has `null` but no `undefined`. `JSON.stringify` silently drops every property whose value is `undefined`:

```js run
JSON.stringify({ content: 'Hi', thinking: undefined, images: null })
// → '{"content":"Hi","images":null}'      thinking is gone; images survived as null
```

**One number type.** `number` is a 64-bit floating-point value (a C++ `double`), and JavaScript uses it for integers too:

```js run
7 / 2                 // → 3.5        no integer division; use Math.trunc(7 / 2) → 3
0.1 + 0.2             // → 0.30000000000000004
1 / 0                 // → Infinity   no exception
Number('abc')         // → NaN        "not a number": the result of arithmetic that failed
NaN === NaN           // → false      NaN equals nothing, not even itself; test with Number.isNaN(x)
2 ** 53 + 1           // → 9007199254740992   past 2^53, integers stop being exact
```

Whole numbers are exact up to `Number.MAX_SAFE_INTEGER` (about 9 × 10¹⁵), which covers every byte count and token count in this course. For anything bigger, `bigint` values carry an `n` suffix: `2n ** 64n`.

C++ contrast: there's no `int` overflow, no integer division, and dividing by zero doesn't fail. Python contrast: Python's `int` grows as large as it needs to; past 2^53, a JavaScript `number` quietly loses precision instead.

**Truthiness: what counts as false.** Conditions (`if (x)`, `!x`, `x && y`, `x || y`) treat any value as true or false. Exactly eight values are **falsy**: `false`, `0`, `-0`, `0n`, `''` (the empty string), `null`, `undefined` and `NaN`. Everything else is **truthy**. That includes every object and every non-empty string, which catches Python programmers out:

```js run
const toolCalls = [];
if (toolCalls) console.log('has tool calls');          // prints! An empty array is an object: truthy
if (toolCalls.length) console.log('has tool calls');   // correct: 0 is falsy
```

In Python, an empty list is falsy. In JavaScript, test `.length`.

Strings are the other trap. Environment variables and command-line flags always arrive as strings, and every non-empty string is truthy, even one that spells zero:

```js
// with AH_VERBOSE=0 set in the environment
if (process.env.AH_VERBOSE) console.log('verbose');    // prints! '0' is a non-empty string
```

So convert such values on purpose before you test them (see *Converting on purpose* below).

**Equality: always use `===`.** `===` (*strict* equality) never converts: values of different types are simply not equal. `==` (*loose* equality) first converts both sides using rules so tangled that they aren't even consistent:

```js run
'' == 0               // → true
'0' == 0              // → true
'' == '0'             // → false   two things equal to 0 aren't equal to each other
null == undefined     // → true
'' === 0              // → false   === never converts
```

Use `===` and `!==` everywhere. JavaScript's `===` behaves like Python's `==` does for strings and numbers: `'1' === 1` is `false`, just as `'1' == 1` is `False` in Python.

**Objects compare by identity.** For primitives, `===` compares values. For objects and arrays, it asks *"is this the very same object?"*, like comparing two pointers in C++ or using `is` in Python:

```js run
const a = { role: 'user' };
const b = { role: 'user' };
a === b               // → false   two different objects that happen to look alike
a === a               // → true
```

To compare contents, compare the fields you care about. In tests, `assert.deepStrictEqual` (Day 5) walks through both objects for you.

**Converting on purpose.** Arithmetic converts its operands too, and `+` is the odd one out: if either side is a string, `+` joins strings. The other arithmetic operators turn both sides into numbers:

```js run
'3' + 1               // → '31'
'3' - 1               // → 2
```

Don't rely on either. Convert explicitly, and check that the conversion worked:

```js run
Number('8192')        // → 8192
Number('8k')          // → NaN      the whole string must be a number
Number('')            // → 0        careful: an empty string becomes 0
parseInt('8k', 10)    // → 8        reads digits until it meets something else
String(8192)          // → '8192'
```

Day 5's flag parser does exactly this with `--num-ctx`: `Number(…)`, then a check that the result is a whole number.

### 2. Objects, arrays, and two operators you'll use constantly

**Objects are bags of named properties.** You've used them since Day 1: every message in the history is one.

```js run
const msg = { role: 'user', content: 'How many files?' };
msg.role              // → 'user'
msg['content']        // → 'How many files?'   brackets accept any expression, such as a variable
msg.tokens = 12;      // properties can be added at any time
msg.missing           // → undefined           no error (Python's dict would raise KeyError)

const model = 'qwen3.5:4b';
const opts = { model, numCtx: 8192 };          // shorthand for { model: model, numCtx: 8192 }
```

**Optional chaining, `?.`, for data that might not be there.** A model's reply is full of parts that are sometimes present and sometimes not. Ollama includes `tool_calls` only when the model calls a tool, so on a plain answer:

```js run
const reply = { role: 'assistant', content: 'Paris.' };
reply.tool_calls.length     // TypeError: Cannot read properties of undefined (reading 'length')
reply.tool_calls?.length    // → undefined
```

`a?.b` means "if `a` is `null` or `undefined`, stop here and give `undefined`; otherwise read `a.b`". It works for indexes and calls too: `list?.[0]`, `onText?.(chunk)`. That's why the toy writes `if (!reply.tool_calls?.length)`: a missing list and an empty one both come out falsy, and both mean "no tools, this is the answer".

**Nullish coalescing, `??`, for defaults.** `x ?? fallback` gives `fallback` only when `x` is `null` or `undefined`. The older `x || fallback` gives `fallback` whenever `x` is *falsy*, so it also throws away `0`, `''` and `false`:

| `x` | `x \|\| 'default'` | `x ?? 'default'` |
|---|---|---|
| `undefined` | `'default'` | `'default'` |
| `null` | `'default'` | `'default'` |
| `0` | `'default'` | `0` |
| `''` | `'default'` | `''` |
| `false` | `'default'` | `false` |
| `'qwen3.5:9b'` | `'qwen3.5:9b'` | `'qwen3.5:9b'` |

Use `??` for defaults. `numCtx || 8192` quietly turns a deliberate `0` into `8192`; `numCtx ?? 8192` keeps it. The toy's `process.env.AH_MODEL ?? 'qwen3.5:4b'` reads as "the variable if it's set, otherwise the default model".

**Arrays, and the two families of methods.** An array is an ordered list (`['a', 'b']`) with a `length`. Its methods come in two families, and mixing them up causes real bugs:
- **These leave the array alone and return something new:** `map` (transform every item), `filter` (keep some items), `find` (the first match), `some` and `every` (yes/no questions), `slice`, `concat`, `join`, `reduce`.
- **These change the array in place:** `push` and `pop` (at the end), `shift` and `unshift` (at the start), `splice`, `sort`, `reverse`.

Most of the first family take a function, which they call once per item:

```js run
const calls = [
  { name: 'bash', args: { command: 'ls' } },
  { name: 'read', args: { path: 'notes.txt' } },
  { name: 'bash', args: { command: 'pwd' } },
];

calls.map((c) => c.name)                        // → ['bash', 'read', 'bash']
calls.filter((c) => c.name === 'bash').length   // → 2
calls.find((c) => c.name === 'read')            // → { name: 'read', args: { path: 'notes.txt' } }
calls.some((c) => c.name === 'write')           // → false
calls.at(-1).args.command                       // → 'pwd'   a negative index counts from the end
```

`sort` has two traps: it changes the array in place, and without a compare function it sorts items **as strings**:

```js run
const sizes = [10, 9, 1];
sizes.sort()                       // → [1, 10, 9]   as text, '10' comes before '9'
sizes.sort((a, b) => a - b)        // → [1, 9, 10]
sizes.toSorted((a, b) => b - a)    // → [10, 9, 1], and sizes itself is left as it was
```

**Loop with `for...of`, not `for...in`.** `for (const x of list)` gives you the *values*, like Python's `for x in list`. `for...in` gives you the *keys*, as strings, which is almost never what you want for an array:

```js run
for (const name of ['bash', 'read']) console.log(name);       // bash, then read
for (const i in ['bash', 'read']) console.log(i, typeof i);   // 0 string, then 1 string
```

To walk an object's properties, ask for its entries:

```js run
const settings = { model: 'qwen3.5:4b', numCtx: 8192 };
for (const [key, value] of Object.entries(settings)) {
  console.log(`${key} = ${value}`);                       // model = qwen3.5:4b, then numCtx = 8192
}
```

The `[key, value]` on the left unpacks each entry into two variables. That's *destructuring*, from concept 5.

### 3. Functions, closures and `this`

**Functions are values.** You can store a function in a variable, put it in an object, pass it to another function, or return it from one. That's how `map` works: you hand it a function, and it calls that function for each item. Python works the same way; in C++ terms, every function is already something like a `std::function` you can copy around.

There are two ways to write a function:

```js
function add(a, b) { return a + b; }          // a function declaration
const add2 = (a, b) => a + b;                 // an arrow function: the expression after => is returned
const add3 = (a, b) => { return a + b; };     // an arrow function with a block body needs its own return
```

Arrow functions are shorter, and they treat `this` differently (below). One syntax trap: an arrow function that returns an object literal needs parentheses around it, or the braces are read as a block of code:

```js
[1, 2].map((n) => { id: n })       // → [undefined, undefined]   the braces were a block, not an object
[1, 2].map((n) => ({ id: n }))     // → [{ id: 1 }, { id: 2 }]
```

**Closures.** A function can use the variables around it, and it keeps them even after the code that created them has finished. That is a **closure**. A *factory function* uses closures to give an object private state:

```js run
function createCounter() {
  let n = 0;                                 // stays alive after createCounter returns
  return {
    next: () => ++n,
    peek: () => n,
  };
}

const a = createCounter();
const b = createCounter();
a.next();
a.next();
a.peek()              // → 2
b.peek()              // → 0   each call to createCounter made its own n
```

Nothing outside can read or change `n`, except through `next` and `peek`. The harness hides configuration the same way: on Day 10, `createReadTool({ root })` returns a tool whose functions close over `root`, so nobody has to pass the workspace root in again.

**A closure captures the variable itself, not a copy of its value.** If the variable changes later, the closure sees the change:

```js run
let model = 'qwen3.5:4b';
const describe = () => `using ${model}`;
model = 'qwen3.5:9b';
describe()            // → 'using qwen3.5:9b'   it reads model now, not when it was created
```

In a loop, `let` creates a **fresh variable for every pass**, so closures made in different passes don't share one:

```js run
const fns = [];
for (let i = 0; i < 3; i++) fns.push(() => i);
fns.map((f) => f())   // → [0, 1, 2]
```

Python contrast: `[f() for f in [lambda: i for i in range(3)]]` gives `[2, 2, 2]`, because all three lambdas share a single `i`. Old JavaScript code declares variables with `var`, which behaves the same way here (`[3, 3, 3]`). Never use `var`: use `const`, or `let` when you need to reassign. C++ contrast: a lambda lists what it captures and how (`[=]`, `[&]`); a JavaScript function captures every variable it uses, automatically and by reference.

**`this` is decided by the call, not by where the function is written.** Inside a method, or any function written with the `function` keyword, `this` is a hidden extra argument. It is filled in *every time the function is called*, according to how it is called:

| The call looks like | `this` is |
|---|---|
| `obj.method()` | `obj`, the object before the dot |
| `fn()`, a plain call | `undefined` (in an ES module) |
| `new Fn()` | the brand-new object |
| `fn.call(x)`, or `fn.bind(x)` and then a call | `x` |

*Run this in a file*, not the REPL:

```js run
const client = {
  model: 'qwen3.5:4b',
  label() { return this.model; },
};

client.label();       // → 'qwen3.5:4b'   method call: this = client
const f = client.label;
f();                  // TypeError: Cannot read properties of undefined (reading 'model')
const g = client.label.bind(client);
g();                  // → 'qwen3.5:4b'   bind returns a new function with this fixed for good
```

`const f = client.label` copies the function, not the object it came from. Called on its own, `f()` has no object before the dot, so `this` is `undefined`, and reading `.model` from it throws.

This is where Python programmers get caught. In Python, `f = client.label` gives you a *bound method* that remembers `client`. In JavaScript, it gives you the bare function. C++ contrast: it's like a pointer to a member function, which can't be called without an object; JavaScript lets you try, and fails at run time.

**Passing a method as a callback is the same mistake in disguise.** `setTimeout(client.label, 0)` hands over the function without `client`, so whoever calls it later decides `this`. Node's `setTimeout` happens to pass its own `Timeout` object, so `this.model` is quietly `undefined` instead of throwing (browsers pass `window`). Either way, `client` is gone. Fix it with `.bind`, or wrap the call in an arrow function so it stays a method call:

```js
setTimeout(client.label.bind(client), 0);
setTimeout(() => client.label(), 0);
```

**Arrow functions have no `this` of their own.** They use the `this` of the code they're written in, just like any other variable from the surrounding scope. That makes them the right choice for callbacks *inside* a method:

```js run
const tally = {
  total: 0,
  addAll(numbers) {
    numbers.forEach((n) => { this.total += n; });   // the arrow uses addAll's this, which is tally
    return this.total;
  },
};

tally.addAll([1, 2])  // → 3
```

Write that callback as `function (n) { this.total += n; }` instead, and `forEach` calls it as a plain function: `TypeError: Cannot read properties of undefined (reading 'total')`.

The same rule makes arrow functions the wrong choice *as* methods. An arrow written inside an object literal takes its `this` from the code *around* the object, not from the object. Exercise 2.2 lets you watch that happen.

### 4. Classes versus factories

There are two common ways to make objects that bundle state with behaviour. Here's the same small client written both ways:

```js run
class Client {
  #model;                                   // a private field: only code inside the class can use it

  constructor({ model }) {
    this.#model = model;
  }

  describe() {
    return `client for ${this.#model}`;
  }
}

function createClient({ model }) {
  return {
    model,                                  // a copy of the setting, for anyone to read
    describe: () => `client for ${model}`,  // closes over model: no this anywhere
  };
}

const c = new Client({ model: 'qwen3.5:4b' });
const d = createClient({ model: 'qwen3.5:4b' });
c.describe()          // → 'client for qwen3.5:4b'
d.describe()          // → 'client for qwen3.5:4b'
```

They behave the same until you pass a method around, as you just saw with `client.label`:

```js
const describeC = c.describe;
describeC();          // TypeError: Cannot read properties of undefined (reading '#model')

const describeD = d.describe;
describeD();          // → 'client for qwen3.5:4b'
```

| | Class | Factory |
|---|---|---|
| Create with | `new Client({ model })` | `createClient({ model })` |
| Private state | `#private` fields | variables in the closure |
| `this` | used in every method, and lost when you pass `c.describe` around | not used, so passing `d.describe` around is safe |
| `instanceof` | `c instanceof Client` works | nothing to check against |
| Testing | inject dependencies through the constructor | inject them through the options object |

A `#private` field is enforced by the language: writing `c.#model` outside the class is a `SyntaxError` before the file even runs. Python contrast: that's real privacy, not a naming convention like `_model`. C++ contrast: close to `private:`.

Both styles are fine. **The harness uses classes for long-lived, stateful things** (providers, the loop, the session manager), which you always call as `provider.chat(…)`, **and factories for tools and small helpers.** Today the toy uses factories.

### 5. Destructuring, spread, and copying instead of changing

**Destructuring** unpacks the parts of an object or array into variables:

```js
const opts = { model: 'qwen3.5:4b', numCtx: 8192 };
const { model, url = 'http://localhost:11434' } = opts;   // model = 'qwen3.5:4b'; url takes the default
const [first, ...rest] = ['a', 'b', 'c'];                 // first = 'a', rest = ['b', 'c']
```

A default (`url = …`) is used only when the value is `undefined`.

**Options objects: JavaScript's keyword arguments.** Destructuring in a parameter list gives you something close to Python's keyword arguments. Every factory and constructor in this course takes a single options object this way:

```js
function createOllamaClient({ model, url = 'http://localhost:11434', numCtx = 8192 }) { … }

createOllamaClient({ model: 'qwen3.5:4b' });                  // url and numCtx take their defaults
createOllamaClient({ numCtx: 16384, model: 'qwen3.5:9b' });   // any order: the names say what's what
```

Calling it with no argument at all fails, because there is nothing to destructure:

```
TypeError: Cannot destructure property 'model' of 'undefined' as it is undefined.
```

When every option is optional, give the whole object a default as well: `function runBash(command, { timeoutMs = 30_000 } = {})`.

**Spread (`...`) copies the contents of one array or object into a new one.** For objects, a property written later wins, which makes spread the standard way to "change" one field without touching the original:

```js run
const msg = { role: 'assistant', content: 'Hello' };
const edited = { ...msg, content: 'Hi' };     // → { role: 'assistant', content: 'Hi' }
msg.content                                   // → 'Hello'   the original is untouched

const tools = ['read'];
const more = [...tools, 'bash'];              // → ['read', 'bash'], and tools is still ['read']
```

**Spread is shallow.** It copies the top level only, so nested objects and arrays end up *shared* between the copy and the original:

```js run
const reply = { role: 'assistant', tool_calls: [{ id: 'call_1' }] };
const copy = { ...reply, content: '' };
copy.tool_calls.push({ id: 'call_2' });
reply.tool_calls.length                       // → 2   the original changed too
```

`structuredClone(reply)` makes a **deep** copy, with nothing shared.

**`const` is not immutability.** `const` stops you from pointing the *variable* at a different value. The object it points to can still change:

```js run
const msg = { content: 'a' };
msg.content = 'b';    // allowed: the object changed, the variable didn't
msg = {};             // TypeError: Assignment to constant variable.
```

`Object.freeze(msg)` makes an object's own properties read-only (in an ES module, writing to one throws a `TypeError`), but it's shallow too: arrays and objects inside it stay changeable. C++ contrast: there's no const-correctness, so you can't hand someone a read-only view of an object. The course relies on a habit instead.

**House rule:** treat message objects, tool arguments and tool output as read-only: copy them, don't change them. The one thing that does change is the history **array**. The loop owns it and only ever appends to it.

The reason is that one message object is shared by many readers: the history, the session file (Day 17), the UI, and your tests. Change it in one place, and every reader sees the change:

```js
// ✗ shortens the message for display, and also in the history the model reads next turn
function preview(msg) {
  msg.content = msg.content.slice(0, 80);
  return msg;
}

// ✓ returns a shortened copy; the history keeps the original
function preview(msg) {
  return { ...msg, content: msg.content.slice(0, 80) };
}
```

### 6. ES modules

**Every file is a module, with its own scope.** A top-level `const` in `loop.mjs` is invisible to `main.mjs`, unless `loop.mjs` exports it and `main.mjs` imports it. Nothing becomes global by accident.

```js
// toy/bash-tool.mjs
export const bashToolSpec = { … };
export async function runBash(command) { … }
```

```js
// toy/loop.mjs
import { bashToolSpec, runBash } from './bash-tool.mjs';   // the names must match the exports exactly
```

- **Relative imports need the whole file name,** extension included: `'./bash-tool.mjs'`, not `'./bash-tool'`. Node never guesses.
- **Built-in modules start with `node:`,** as in `import { spawnSync } from 'node:child_process'`.
- **`as` renames.** Day 1's toy used both forms: `import { stdin as input } from 'node:process'` renames one export, and `import * as readline from 'node:readline/promises'` gathers a whole module into one object.

**Prefer named exports.** With `export default`, each file that imports the value picks its own name for it, so one thing ends up with different names in different files. A named export has the same name everywhere: a search finds every use, and your editor can rename it safely. Use `export default` only when a module has one obvious thing to offer.

**A module's top-level code runs once, the first time anything imports it.** Later imports get the same, already-loaded module. So keep library modules quiet: `ollama.mjs`, `bash-tool.mjs` and `loop.mjs` should only *define* things, and only `main.mjs`, the program you run, should *do* things like opening `readline` and starting the REPL. Tomorrow's course tests import `loop.mjs` directly. If importing it opened a readline on your terminal, the tests would never finish.

**Modules always run in strict mode.** Strict mode turns several silent mistakes into errors. Three of them matter today:
- a plain call `f()` gets `this === undefined` (sloppy mode substitutes the global object);
- writing to a frozen object throws a `TypeError` (sloppy mode silently ignores the write);
- assigning to a variable you never declared throws a `ReferenceError` (sloppy mode creates a global variable).

The REPL runs in sloppy mode. That's why today's `this` and `Object.freeze` experiments go in files.

### 7. JSDoc: types without TypeScript

JavaScript doesn't check types before it runs your code. **JSDoc** comments let you write types anyway. Your editor (VS Code reads them out of the box) uses them for autocompletion, hover information and error checking, and Node ignores them like any other comment, so there's no build step.

```js
/**
 * @typedef {object} ToyClient
 * @property {string} model
 * @property {(messages: object[], tools: object[]) => Promise<object>} chat
 */

/**
 * Create a client for one Ollama model.
 * @param {{ model: string, url?: string, numCtx?: number }} opts
 * @returns {ToyClient}
 */
export function createOllamaClient({ model, url = 'http://localhost:11434', numCtx = 8192 }) { … }
```

How to read it:
- A JSDoc comment starts with `/**` (two stars) and sits directly above what it describes.
- `@typedef` names a type, and each `@property` adds a field to it. `ToyClient` is "an object with a `model` string, and a `chat` function that takes two arrays and returns a promise".
- `@param {type} name` gives a parameter's type. `{ model: string, url?: string }` is an object type, and `?` marks a property as optional.
- `@returns {type}` gives the result's type.

Put `// @ts-check` on the first line of a file, and your editor reports mistakes as you type:

```js
// @ts-check
import { createOllamaClient } from './ollama.mjs';

createOllamaClient({ modle: 'qwen3.5:4b' });
// ✗ Object literal may only specify known properties, but 'modle' does not exist in type
//   '{ model: string; url?: string; numCtx?: number; }'. Did you mean to write 'model'?

createOllamaClient({ model: 'qwen3.5:4b', numCtx: '8192' });
// ✗ Type 'string' is not assignable to type 'number'.
```

These checks are for *you*, while you write. Types don't exist at run time: Node runs the misspelled call anyway, with `model` set to `undefined`. Data you don't control, such as flags or a model's reply, still needs checking when it arrives (Day 5 starts on that). Day 5's stretch also runs the same checker over your whole project from the command line.

### 8. Dependency injection

On Day 1, the loop called `rl.question` and `spawnSync` itself. That works, but it means the loop can only ever run with a real keyboard and a real shell: to test it, someone would have to sit there typing `y`.

Today, `runTurns` receives those abilities as arguments instead:

```js
export async function runTurns({ client, messages, confirm, runTool = runBash, maxTurns = 10 }) { … }
```

The loop says *what* it needs (something to chat with, a way to ask permission, a way to run a command), and the caller decides *how*. That is **dependency injection**. `main.mjs` passes the real things: an Ollama client, a `confirm` that asks on the terminal, and the default `runBash`. A test passes fakes:

```js
const replies = [
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call_1', function: { name: 'bash', arguments: { command: 'ls demo/' } } }],
  },
  { role: 'assistant', content: 'There are 2 files.' },
];
const client = { chat: async () => replies.shift() };   // a fake model: plays its replies in order
const confirm = async () => true;                        // a fake human who always says yes
const runTool = async () => 'a.txt\nb.txt\n';            // a fake shell

const messages = [{ role: 'user', content: 'How many files are in demo/?' }];
const result = await runTurns({ client, messages, confirm, runTool });
result.text                    // → 'There are 2 files.'
messages.map((m) => m.role)    // → ['user', 'assistant', 'tool', 'assistant']
```

No model, no keyboard, no shell, and it finishes in milliseconds. That's exactly how tomorrow's course tests check your loop. You'll meet the pattern all through the course: Day 5 injects `fetch`, and Day 12's approval function and Day 20's permission gate plug into the loop the same way `confirm` does.

Python contrast: the same idea as passing in a callable or a mock instead of patching a module. C++ contrast: like passing an interface or a `std::function` to a constructor, instead of calling a global.

## Build

**Files today:** `notes/day-02.md`, `scratch/closures.js`, `scratch/user.js`, and `toy/ollama.mjs`, `toy/bash-tool.mjs`, `toy/loop.mjs`, `toy/main.mjs`.

### Sitting 1 — the language

#### 2.1 Predict, then evaluate — Core

For each expression below, **write your prediction in `notes/day-02.md` first**. Then evaluate it in the REPL, and wherever you were wrong, write one line on why.

```js
typeof null
typeof []
0.1 + 0.2 === 0.3
[] == false
[] === []
!!{}
'5' * '2'
'5' + 2
null ?? 'x'
0 || 'x'
0 ?? 'x'
Number.isNaN(NaN)
```

Then add a truthiness table to your notes: all eight falsy values, plus the traps `[]`, `{}`, `'0'` and `'false'`, each with what `Boolean(x)` returns.

#### 2.2 Closures and `this` — Core

Work in `scratch/closures.js` and run it with `node scratch/closures.js`. Don't use the REPL for this one: it runs in sloppy mode, where a plain call gets the global object as `this` instead of `undefined`, so you would never see the `TypeError` (concept 6).

1. Write `createCounter()`, `once(fn)` and `memoize(fn)`, and log the state each one closes over. `once` runs `fn` the first time and then keeps returning that first result. `memoize` caches results by the first argument (a `Map` makes a good cache). They should behave like this:

   ```js
   const init = once(() => { console.log('initialising'); return 42; });
   init();       // logs 'initialising' → 42
   init();       // → 42, without logging

   const square = memoize((n) => { console.log('computing', n); return n * n; });
   square(4);    // logs 'computing 4' → 16
   square(4);    // → 16, from the cache
   ```

2. Try the four `this` cases: a method call, an extracted method, `.bind`, and an arrow function used as an object method. **Predict each one before you run it.** A case that throws stops the script, so wrap each one in `try { … } catch (err) { console.log(err.message); }`.
3. Change `label` to log instead of return: `label() { console.log('label:', this?.model, this); }`. Pass `client.label` to `setTimeout` and meet the `Timeout` object. Fix it two ways: with `.bind`, and with an arrow wrapper.

#### 2.3 Classes vs factories — Core

In `scratch/user.js`, write a tiny user twice:

```js
class User {
  #name;

  constructor(name) {
    this.#name = name;
  }

  greet() {
    return `Hi, ${this.#name}`;
  }
}

function createUser({ name }) {
  return { greet: () => `Hi, ${name}` };
}
```

Make one of each, then pass each `greet` as a callback: `['x'].map(user.greet)`. Which one throws, and why? Write the answer in your notes.

Commit: `day-02a: JS language drills`. **Take a break.**

### Sitting 2 — the refactor

#### 2.4 Split the toy into modules — Core

Keep `toy/agent.mjs` as it is, and split a copy of it into the four files below. Give each export a JSDoc comment (concept 7).

1. **`toy/ollama.mjs`**: `export function createOllamaClient({ model, url, numCtx })` returns `{ model, chat(messages, tools) }`. The config lives in the closure, so there is no `this`.
2. **`toy/bash-tool.mjs`**: `export const bashToolSpec = { … }` and `export async function runBash(command)` (still `spawnSync` today).
3. **`toy/loop.mjs`**: `export async function runTurns({ client, messages, confirm, runTool = runBash, maxTurns = 10 })`. This is Day 1's inner `for` loop, and it returns `{ text, turns }`. It no longer knows about `readline` or `spawnSync`:
   - before running a tool, it **asks** by calling the injected `confirm(command)`;
   - it **runs** the tool by calling the injected `runTool(command)`, which defaults to `runBash`.
4. **`toy/main.mjs`**: the REPL. It creates the client, owns `rl`, passes a `confirm` that asks on the terminal, and prints the answer:

   ```js
   const confirm = async (command) =>
     (await rl.question(`\n  run \`${command}\`? [y/N] `)).trim().toLowerCase() === 'y';
   ```

`node toy/main.mjs` must behave exactly like Day 1. **That is your test today.** From tomorrow, the course's tests drive `runTurns` with a fake client, a fake `confirm` and a fake `runTool`, as in concept 8, with no model and no keyboard.

#### 2.5 Contrast table — Core

In `notes/day-02.md`, fill in the JavaScript column in your own words:

| Concept | C++ | Python | JavaScript |
|---|---|---|---|
| equality | overloads, conversions | `==` value equality | ? |
| empty collection truthiness | n/a | falsy | ? |
| method receiver | implicit `this` | explicit `self` | ? |
| closures | capture lists | late-binding closures | ? |
| `const` | const-correctness | convention | ? |
| cleanup | destructors / RAII | `with`, `try/finally` | `try/finally` (Day 5) |
| numbers | `int`, `float` | arbitrary-size `int` | ? |
| modules | `#include` + link | `import` | ? |

Commit: `day-02b: toy split into modules`.

#### 2.6 The class version — Stretch

Write `class OllamaClient` with `#model` and `chat()`, and make `runTurns` call `client.chat`. Then try `const chat = client.chat; await chat(…)` and explain the error in one sentence. Day 8's provider *is* a class, and you'll always call it as `provider.chat(…)`.

#### 2.7 Immutability check — Stretch

In a file, `Object.freeze` a message and try to change `msg.content` (an ES module throws a `TypeError`). Then change `msg.tool_calls[0]`, which *succeeds*, because the freeze is shallow. Fix it with `structuredClone` plus a deep freeze.

## Check

- [ ] `notes/day-02.md` has your predictions, the truthiness table and the contrast table
- [ ] `scratch/closures.js` runs: counter, once, memoize, the four `this` cases and the `setTimeout` fix
- [ ] `node toy/main.mjs` behaves like Day 1, built from four modules with JSDoc
- [ ] `runTurns` takes `confirm` and `runTool` as arguments
- [ ] Commits `day-02a` and `day-02b`

Solution: [`solutions/toy/`](solutions/toy/). It shows the end of week 1, so it already includes the next three days' changes (abort, streaming, the CLI flags).

## Stuck?

<details><summary><code>SyntaxError: The requested module does not provide an export named …</code></summary>

The name in `import { x } from './file.mjs'` must match an `export` exactly, and the path needs its extension (`./file.mjs`, not `./file`). ES modules never guess extensions.
</details>

<details><summary><code>TypeError: Cannot read properties of undefined (reading '…')</code></summary>

Something before the dot is `undefined`. Usually it's one of two things:
- **Data that isn't there.** For example, `reply.tool_calls.length` on a plain answer, which has no `tool_calls`. Use `reply.tool_calls?.length`.
- **A method that lost its `this`.** It was taken off its object (`const f = obj.method`) or passed as a callback. Call it as `obj.method()`, wrap it in an arrow function, or `.bind` it.
</details>

<details><summary><code>TypeError: Cannot destructure property 'model' of 'undefined'</code></summary>

A function that destructures an options object was called without one: `createOllamaClient()` instead of `createOllamaClient({ model })`. Pass the object, or give the parameter a default (`{ … } = {}`) if every option is optional.
</details>

<details><summary>Every command runs without asking</summary>

`rl.question` returns a promise. Did you `await` it inside `confirm`, and `await confirm(cmd)` in the loop? A missing `await` gives you a `Promise` object, which is truthy, so every command would run without asking.
</details>

<details><summary>Hover types don't show up in my editor</summary>

VS Code reads JSDoc out of the box. Make sure the comment starts with `/**` (two stars) and sits directly above the function. For stricter checking, add `// @ts-check` as the first line of the file.
</details>

## Common mistakes

- Using `==`, or `||` where you meant `??` (`numCtx || 8192` replaces a deliberate `0`).
- Testing an array with `if (list)` instead of `if (list.length)`.
- Treating spread as a deep copy, then "immutably" changing nested arrays.
- Passing `obj.method` as a callback and losing `this`.

## Self-check

1. Why is `const msg = { … }` not immutability, and which habits make up for it?
2. What does `this` depend on, and why don't arrow functions have that problem?
3. Why does `runTurns` take `confirm` and `runTool` functions instead of using `readline` and `spawnSync` itself?
4. When would you choose a class over a factory?

Answers: [self-check-answers.md](self-check-answers.md#day-2).

## Further reading

- javascript.info, [Variable scope, closure](https://javascript.info/closure) · [Object methods, "this"](https://javascript.info/object-methods) · [Destructuring assignment](https://javascript.info/destructuring-assignment): patient, beginner-friendly chapters with exercises
- MDN, [`this`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/this) · [Closures](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Closures) · [Equality comparisons](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Equality_comparisons_and_sameness) · [Strict mode](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Strict_mode)
- MDN, [JavaScript modules](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules)
- TypeScript handbook, [JSDoc reference](https://www.typescriptlang.org/docs/handbook/jsdoc-supported-types.html)

---
← [Day 1](day-01.md) · [Curriculum home](README.md) · Next: [Day 3 — Async JavaScript: make Ctrl+C work](day-03.md) →
