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

From the outside, nothing has changed: `node toy/main.mjs` behaves exactly like yesterday's agent. Inside, one file has become several small ones, each with one job and a typed interface, and the loop no longer cares who answers its questions. Along the way you'll learn the parts of JavaScript that most often surprise programmers coming from C++ or Python: how values quietly convert themselves, what a closure captures, why `this` sometimes goes missing, and what `await` actually waits for.

## Why it matters

Yesterday you typed a working agent into a single file, top to bottom. It works, but everything in it is tangled together. The model client, the shell tool, the loop and the keyboard all share one scope, and the loop can only run with a real model on the other end and a real person typing `y`. That's fine for 70 lines. It won't be fine for the harness you're about to grow.

Today you pull the toy apart into four small modules, and you use the refactor as an excuse to learn the JavaScript that the rest of the course leans on. Every later module is written in the style you set up today: named ES exports, factories or small classes, JSDoc types, and data you copy instead of changing. Learning that style on a program you already understand is much easier than learning it on a new one.

One warning. Misunderstanding the ideas below rarely causes an error today. It causes one weeks later: a message that quietly changed under you, or a callback that lost its `this` and failed far from where the mistake was made. Bugs like that are hard to find precisely because the code looks right. So take your time with this section. I'd rather you spent the morning here than skimmed it.

## Concepts

**How to read this section.** Keep a Node REPL open (type `node` in a terminal) and try the examples as you read. A comment like `// → 3.5` shows what Node gives back, and a comment like `// TypeError: …` shows an error it throws. The REPL is more forgiving than your `.mjs` files in a few ways (concept 6 explains why), so the examples that depend on the difference say *run this in a file*.

The examples use everyday data, such as books, users and shopping carts, so that the language is the only new thing in front of you. Each idea then ends by pointing out where it shows up in the toy.

### 1. Values, types and coercion

Every language has to answer a few basic questions. What kinds of values exist? What counts as true? What happens when you mix types? JavaScript's answers are mostly unsurprising. Where they differ from C++ and Python, though, they tend to give you a wrong result rather than an error, and that makes them worth learning before anything else.

**Seven primitive types, and everything else is an object.** A *primitive* is a simple value that can't be changed: `string`, `number`, `bigint`, `boolean`, `undefined`, `symbol` and `null`. Everything else (plain objects, arrays, functions, dates, errors) is an *object*. The `typeof` operator tells you which kind of value you're holding:

```js run
typeof 'hello'        // → 'string'
typeof 42             // → 'number'
typeof true           // → 'boolean'
typeof undefined      // → 'undefined'
typeof { a: 1 }       // → 'object'
typeof (() => 1)      // → 'function'   functions are objects, but typeof names them separately
```

`typeof` has two quirks. `typeof null` is `'object'`, a bug from 1995 that can never be fixed without breaking old websites. And arrays are objects too, so `typeof` can't tell an array from a plain object. Use `Array.isArray(x)` for that.

**Two kinds of "nothing".** Python has one empty value, `None`. JavaScript has two, and they mean slightly different things. **`undefined` means "never set".** It's what you get from a variable declared without a value, a property that doesn't exist, an argument nobody passed, or a function that finishes without a `return`. **`null` means "deliberately empty".** Someone put it there on purpose, to say "there is no value here".

```js run
let nickname;
nickname              // → undefined   declared, but never given a value

const user = { name: 'Ada', email: null };
user.email            // → null        set to "nothing" on purpose
user.phone            // → undefined   there's no such property at all
```

Most of the time you can treat the two alike. The place where the difference bites is JSON, which has `null` but no `undefined`. `JSON.stringify` silently drops every property whose value is `undefined`:

```js run
JSON.stringify({ name: 'Ada', email: null, phone: undefined })
// → '{"name":"Ada","email":null}'      phone is gone; email survived as null
```

That matters to the harness, because every message travels to the model as JSON. A field you set to `undefined` doesn't arrive as "empty". It doesn't arrive at all.

**One number type.** `number` is a 64-bit floating-point value (a C++ `double`), and JavaScript uses it for integers too:

```js run
7 / 2                 // → 3.5        no integer division; use Math.trunc(7 / 2) → 3
0.1 + 0.2             // → 0.30000000000000004
1 / 0                 // → Infinity   no exception
Number('abc')         // → NaN        "not a number": the result of arithmetic that failed
NaN === NaN           // → false      NaN equals nothing, not even itself; test with Number.isNaN(x)
2 ** 53 + 1           // → 9007199254740992   past 2^53, integers stop being exact
```

Whole numbers are exact up to `Number.MAX_SAFE_INTEGER` (about 9 × 10<sup>15</sup>), which covers every byte count and token count in this course. For anything bigger, `bigint` values carry an `n` suffix: `2n ** 64n`.

C++ contrast: there's no `int` overflow, no integer division, and dividing by zero doesn't fail. Python contrast: Python's `int` grows as large as it needs to, while past 2^53 a JavaScript `number` quietly loses precision instead.

**Truthiness: what counts as false.** Conditions (`if (x)`, `!x`, `x && y`, `x || y`) accept any value, not only booleans, and decide for themselves whether it counts as true. Exactly eight values are **falsy**: `false`, `0`, `-0`, `0n`, `''` (the empty string), `null`, `undefined` and `NaN`. Everything else is **truthy**. That includes every object, even an empty one, and every non-empty string. The first of those catches Python programmers out:

```js run
const cart = [];
if (cart) console.log('wrong: [] is truthy, so this prints');   // prints! an empty array is an object
if (cart.length) console.log('right: length is 1 or more');     // doesn't print: 0 is falsy
```

In Python an empty list is falsy, so `if cart:` asks "is there anything in it?". In JavaScript, `if (cart)` only asks "is there an array?". Test `.length` when you mean "is it empty?".

Strings are the other trap. Environment variables and command-line flags always arrive as strings, and every non-empty string is truthy, even one that spells zero:

```js
// with DEBUG=0 set in the environment
if (process.env.DEBUG) console.log('debugging');    // prints! '0' is a non-empty string
```

So convert values like these on purpose before you test them. *Converting on purpose*, below, shows how.

**Equality: always use `===`.** JavaScript has two equality operators. `===` (*strict* equality) never converts: values of different types are simply not equal. `==` (*loose* equality) first converts both sides to a common type, using rules so tangled that they aren't even consistent with each other:

```js run
'' == 0               // → true
'0' == 0              // → true
'' == '0'             // → false   two things equal to 0 aren't equal to each other
null == undefined     // → true
'' === 0              // → false   === never converts
```

Use `===` and `!==` everywhere, and you never have to remember those rules. If you come from Python, `===` is the one that behaves like the `==` you know: `'1' === 1` is `false`, just as `'1' == 1` is `False` in Python.

**Objects compare by identity.** For primitives, `===` compares values. For objects and arrays it asks a different question: *is this the very same object?* That's like comparing two pointers in C++, or using `is` in Python:

```js run
const a = { title: 'Dune' };
const b = { title: 'Dune' };
a === b               // → false   two different objects that happen to look alike
a === a               // → true
```

Arrays are objects, so the same goes for them: `[1, 2] === [1, 2]` is `false`. To compare contents, compare the fields you care about. In tests, `assert.deepStrictEqual` (Day 5) walks through both objects for you.

**Converting on purpose.** Arithmetic converts its operands too, and `+` is the odd one out. If either side is a string, `+` joins strings. The other arithmetic operators turn both sides into numbers:

```js run
'3' + 1               // → '31'
'3' - 1               // → 2
```

Neither rule is worth relying on. When a value arrives as text and you need a number, convert it explicitly, and then check that the conversion worked:

```js run
Number('42')          // → 42
Number('42px')        // → NaN      the whole string must be a number
Number('')            // → 0        careful: an empty string becomes 0
parseInt('42px', 10)  // → 42       reads digits until it meets something else
String(42)            // → '42'
```

You'll do exactly this on Day 5, when the toy's `--num-ctx` flag arrives as a string: `Number(…)`, then a check that the result is a whole number.

### 2. Objects, arrays, and two operators you'll use constantly

**Objects are bags of named properties.** A JavaScript object is closer to a Python `dict` than to a C++ `struct`. You can add properties whenever you like, and nothing declares the object's shape in advance:

```js run
const book = { title: 'Dune', year: 1965 };
book.title            // → 'Dune'
book['year']          // → 1965        brackets accept any expression, such as a variable
book.pages = 412;     // properties can be added at any time
book.author           // → undefined   no error (Python's dict would raise KeyError)

const title = 'Emma';
const year = 1815;
const other = { title, year };         // shorthand for { title: title, year: year }
```

You've been using objects since Day 1 without paying them much attention. Every message in the toy's history is one: `{ role: 'user', content: '…' }`.

**Optional chaining, `?.`, for data that might not be there.** That quiet `undefined` for a missing property has a price. Reading a property *of* something missing is one of the most common errors in JavaScript, and real data is full of parts that are sometimes there and sometimes not:

```js run
const user = { name: 'Ada' };                 // no address on file
user.address.city     // TypeError: Cannot read properties of undefined (reading 'city')
user.address?.city    // → undefined
```

`a?.b` means "if `a` is `null` or `undefined`, stop here and give `undefined`; otherwise read `a.b`". It works for indexes and calls too. `list?.[0]` reads the first item of a list that might be missing, and `onDone?.()` calls a function only if there is one.

The toy relies on this. Ollama includes `tool_calls` in a reply only when the model wants a tool, so the toy writes `if (!reply.tool_calls?.length)`. A missing list gives `undefined` and an empty one gives `0`. Both are falsy, and both mean "no tools, so this is the answer".

**Nullish coalescing, `??`, for defaults.** `x ?? fallback` gives `fallback` only when `x` is `null` or `undefined`. The older idiom, `x || fallback`, gives `fallback` whenever `x` is *falsy*. So it also throws away `0`, `''` and `false`, which are often perfectly good answers:

| `x` | `x \|\| 'default'` | `x ?? 'default'` |
|---|---|---|
| `undefined` | `'default'` | `'default'` |
| `null` | `'default'` | `'default'` |
| `0` | `'default'` | `0` |
| `''` | `'default'` | `''` |
| `false` | `'default'` | `false` |
| `'blue'` | `'blue'` | `'blue'` |

Here's the kind of bug that causes. A user turns the volume all the way down:

```js run
const settings = { volume: 0 };
settings.volume || 50     // → 50   the user's 0 was treated as "not set"
settings.volume ?? 50     // → 0    ?? keeps it
```

Use `??` for defaults. The toy's `process.env.AH_MODEL ?? 'qwen3.5:4b'` reads as "the variable if it's set, otherwise the default model". In the same way, `numCtx ?? 8192` keeps a deliberate `0`, where `numCtx || 8192` would quietly replace it.

**Arrays, and the two families of methods.** An array is an ordered list (`['a', 'b']`) with a `length`, much like a Python list. Its methods come in two families. Mixing them up causes real bugs, because one family leaves your data alone and the other changes it:
- **These leave the array alone and return something new:** `map` (transform every item), `filter` (keep some items), `find` (the first match), `some` and `every` (yes/no questions), `slice`, `concat`, `join`, `reduce`.
- **These change the array in place:** `push` and `pop` (at the end), `shift` and `unshift` (at the start), `splice`, `sort`, `reverse`.

Most of the first family take a function, which they call once for each item, passing the item in:

```js run
const books = [
  { title: 'Dune', year: 1965 },
  { title: 'Emma', year: 1815 },
  { title: 'Neuromancer', year: 1984 },
];

books.map((b) => b.title)                    // → ['Dune', 'Emma', 'Neuromancer']
books.filter((b) => b.year > 1900).length    // → 2
books.find((b) => b.year < 1900)             // → { title: 'Emma', year: 1815 }
books.some((b) => b.year > 2000)             // → false
books.at(-1).title                           // → 'Neuromancer'   a negative index counts from the end
```

If you know Python, `map` and `filter` are list comprehensions written as method calls: `books.map((b) => b.title)` is `[b.title for b in books]`.

`sort` has two traps. It changes the array in place, and without a compare function it sorts items **as strings**:

```js run
const sizes = [10, 9, 1];
sizes.sort()                       // → [1, 10, 9]   as text, '10' comes before '9'
sizes.sort((a, b) => a - b)        // → [1, 9, 10]
sizes.toSorted((a, b) => b - a)    // → [10, 9, 1], and sizes itself is left as it was
```

So give `sort` a compare function every time, and use `toSorted` when you want a sorted copy instead.

**Loop with `for...of`, not `for...in`.** `for (const x of list)` gives you the *values*, like Python's `for x in list`. `for...in` looks almost the same but gives you the *keys*, as strings, which is almost never what you want for an array:

```js run
for (const fruit of ['apple', 'pear']) console.log(fruit);     // apple, then pear
for (const i in ['apple', 'pear']) console.log(i, typeof i);   // 0 string, then 1 string
```

To walk an object's properties, ask for its entries:

```js run
const book = { title: 'Dune', year: 1965 };
for (const [key, value] of Object.entries(book)) {
  console.log(`${key} = ${value}`);                       // title = Dune, then year = 1965
}
```

The `[key, value]` on the left unpacks each entry into two variables. That's *destructuring*, which concept 5 covers properly.

### 3. Functions, closures and `this`

Functions are where JavaScript feels most like Python, and then where it surprises you most. Two ideas carry this section. A function remembers the variables around it. And the meaning of `this` inside a function isn't fixed when you write it. It's decided each time the function is called.

**Functions are values.** You can store a function in a variable, put it in an object, pass it to another function, or return it from one. That's how `map` works: you hand it a function, and it calls that function for each item. Python works the same way. In C++ terms, every function is already something like a `std::function` that you can copy around.

There are two ways to write a function:

```js
function add(a, b) { return a + b; }          // a function declaration
const add2 = (a, b) => a + b;                 // an arrow function: the expression after => is returned
const add3 = (a, b) => { return a + b; };     // an arrow function with a block body needs its own return
```

Arrow functions are shorter, and they treat `this` differently, as you'll see below. One syntax trap first. An arrow function that returns an object literal needs parentheses around it, or the braces are read as a block of code:

```js
[1, 2].map((n) => { id: n })       // → [undefined, undefined]   the braces were a block, not an object
[1, 2].map((n) => ({ id: n }))     // → [{ id: 1 }, { id: 2 }]
```

**Closures.** A function can use the variables around it, and it keeps them even after the code that created them has finished running. A function together with the variables it has kept is a **closure**. The classic use is a *factory function*, which gives an object private state:

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

Each call to `createCounter` runs its body again, so each call makes a fresh `n`, and the two functions it returns close over that one `n`. Nothing outside can read or change `n` except through `next` and `peek`. In C++ you'd reach for a class with a `private:` member. Here the closure does that job.

The harness hides configuration the same way. On Day 10, `createReadTool({ root })` returns a tool whose functions close over `root`, so nobody has to pass the workspace root in again.

**A closure captures the variable itself, not a copy of its value.** If the variable changes later, the closure sees the change:

```js run
let greeting = 'Hello';
const greet = (name) => `${greeting}, ${name}!`;
greeting = 'Welcome';
greet('Ada')          // → 'Welcome, Ada!'   it reads greeting now, not when greet was created
```

In a loop, `let` creates a **fresh variable for every pass**, so closures made in different passes don't share one:

```js run
const fns = [];
for (let i = 0; i < 3; i++) fns.push(() => i);
fns.map((f) => f())   // → [0, 1, 2]
```

Python contrast: `[f() for f in [lambda: i for i in range(3)]]` gives `[2, 2, 2]`, because all three lambdas share a single `i`. Old JavaScript code declares variables with `var`, which behaves the same way here (`[3, 3, 3]`). Never use `var`. Use `const`, or `let` when you need to reassign. C++ contrast: a C++ lambda lists what it captures and how (`[=]`, `[&]`). A JavaScript function captures every variable it uses, automatically and by reference.

**`this` is decided by the call, not by where the function is written.** This is the rule that trips up almost everyone coming from another language, so let's go slowly. Inside a method, or any function written with the `function` keyword, `this` is a hidden extra argument. It's filled in *every time the function is called*, according to how the call is written:

| The call looks like | `this` is |
|---|---|
| `obj.method()` | `obj`, the object before the dot |
| `fn()`, a plain call | `undefined` (in an ES module) |
| `new Fn()` | the brand-new object |
| `fn.call(x)`, or `fn.bind(x)` and then a call | `x` |

Here's an object with one method that uses `this`. Exercise 2.2 builds on this exact object, so it's worth running. *Run this in a file*, not the REPL:

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

Walk through the middle two lines. `const f = client.label` copies the function, not the object it came from. `f` is now just a function with no memory of `client`. Called on its own, `f()` has no object before the dot, so `this` is `undefined`, and reading `.model` from `undefined` throws.

This is where Python programmers get caught. In Python, `f = client.label` gives you a *bound method* that remembers `client`. In JavaScript it gives you the bare function. C++ contrast: it's like a pointer to a member function, which can't be called without an object. C++ refuses to compile the call, while JavaScript lets you try and fails at run time.

**Passing a method as a callback is the same mistake in disguise.** `setTimeout(client.label, 0)` hands over the function without `client`, so whoever calls it later decides `this`. Node's `setTimeout` happens to pass its own `Timeout` object, so `this.model` is quietly `undefined` instead of throwing (browsers pass `window`). Either way, `client` is gone. Fix it with `.bind`, or wrap the call in an arrow function so that it stays a method call:

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

The same rule makes arrow functions the wrong choice *as* methods. An arrow written inside an object literal takes its `this` from the code *around* the object, not from the object itself. Exercise 2.2 lets you watch that happen.

### 4. Classes versus factories

Concept 3 gave you two ways for an object to keep state, and JavaScript builds a style of programming on each. A **class** keeps its state in fields and reaches it through `this`. A **factory** is a plain function that keeps its state in a closure and returns an object of functions. Here's the same small bank account written both ways:

```js run
class Account {
  #balance;                                 // a private field: only code inside the class can use it

  constructor(opening) {
    this.#balance = opening;
  }

  deposit(amount) {
    this.#balance += amount;
    return this.#balance;
  }
}

function createAccount(opening) {
  let balance = opening;                    // private: only the function below can see it
  return {
    deposit: (amount) => (balance += amount),   // an arrow that closes over balance: no this anywhere
  };
}

const c = new Account(5);
const d = createAccount(5);
c.deposit(10)         // → 15
d.deposit(10)         // → 15
```

They behave the same until you pass a method around, as you just saw with `client.label`:

```js
const depositC = c.deposit;
depositC(10);         // TypeError: Cannot read properties of undefined (reading '#balance')

const depositD = d.deposit;
depositD(10);         // → 25
```

`depositC` lost its `this`, exactly like `f` in concept 3. `depositD` never had one to lose: `balance` lives in the closure, which goes wherever the function goes.

| | Class | Factory |
|---|---|---|
| Create with | `new Account(5)` | `createAccount(5)` |
| Private state | `#private` fields | variables in the closure |
| `this` | used in every method, and lost when you pass `c.deposit` around | not used, so passing `d.deposit` around is safe |
| `instanceof` | `c instanceof Account` works | nothing to check against |
| Testing | inject dependencies through the constructor | inject them through the options object |

A `#private` field is enforced by the language. Writing `c.#balance` outside the class is a `SyntaxError` before the file even runs. Python contrast: that's real privacy, not a naming convention like `_balance`. C++ contrast: it's close to `private:`.

Both styles are fine, and the harness uses both. **It uses classes for long-lived, stateful things** (providers, the loop, the session manager). You always call those as `provider.chat(…)`, so their `this` never gets lost. **It uses factories for tools and small helpers**, which get passed around a lot. Today's toy uses factories: `createOllamaClient` is one.

### 5. Destructuring, spread, and copying instead of changing

This section is about getting data in and out of objects. It ends with a habit that keeps a program like the harness sane: making changed copies instead of changing things in place.

**Destructuring** unpacks the parts of an object or array into variables:

```js run
const book = { title: 'Dune', year: 1965 };
const { title, pages = 'unknown' } = book;     // pulls out title, and gives pages a default
title                                          // → 'Dune'
pages                                          // → 'unknown'

const [first, ...rest] = ['a', 'b', 'c'];
first                                          // → 'a'
rest                                           // → ['b', 'c']
```

A default (`pages = …`) is used only when the value is `undefined`. Unlike `??`, a `null` doesn't trigger it, because `null` counts as a value someone chose.

**Options objects: JavaScript's keyword arguments.** JavaScript has no keyword arguments, but destructuring in a parameter list gets you very close:

```js run
function orderPizza({ size, crust = 'thin', extraCheese = false }) {
  return `${size} pizza, ${crust} crust${extraCheese ? ', extra cheese' : ''}`;
}

orderPizza({ size: 'large' })                       // → 'large pizza, thin crust'
orderPizza({ extraCheese: true, size: 'small' })    // → 'small pizza, thin crust, extra cheese'
```

The caller names each value, so the order doesn't matter and nobody has to remember that the third argument is the cheese. Every factory and constructor in this course takes a single options object this way, starting with today's client:

```js
function createOllamaClient({ model, url = 'http://localhost:11434', numCtx = 8192 }) { … }

createOllamaClient({ model: 'qwen3.5:4b' });                  // url and numCtx take their defaults
createOllamaClient({ numCtx: 16384, model: 'qwen3.5:9b' });   // any order: the names say what's what
```

Calling such a function with no argument at all fails, because there's nothing to destructure:

```js
orderPizza();
// TypeError: Cannot destructure property 'size' of 'undefined' as it is undefined.
```

When every option is optional, give the whole object a default as well, so that a bare call still works. The toy's `runBash` ends the week with one: `function runBash(command, { timeoutMs = 30_000 } = {})`.

**Spread (`...`) copies the contents of one array or object into a new one.** For objects, a property written later wins. That makes spread the standard way to "change" one field without touching the original:

```js run
const user = { name: 'Ada', email: 'ada@old.example' };
const moved = { ...user, email: 'ada@new.example' };
moved.email                                   // → 'ada@new.example'
user.email                                    // → 'ada@old.example'   the original is untouched

const fruits = ['apple'];
const more = [...fruits, 'pear'];
more                                          // → ['apple', 'pear']
fruits                                        // → ['apple']
```

**Spread is shallow.** It copies the top level only, so nested objects and arrays end up *shared* between the copy and the original:

```js run
const order = { id: 1, items: ['pen'] };
const copy = { ...order, id: 2 };
copy.items.push('paper');
order.items                                   // → ['pen', 'paper']   the original changed too
```

`copy` got its own `id`, but `items` is the same array in both objects. Spread copied a *reference* to the array, not the array itself. `structuredClone(order)` makes a **deep** copy, with nothing shared.

**`const` is not immutability.** `const` stops you from pointing the *variable* at a different value. The object it points to can still change:

```js run
const user = { name: 'Ada' };
user.name = 'Grace';  // allowed: the object changed, the variable didn't
user = {};            // TypeError: Assignment to constant variable.
```

`Object.freeze(user)` makes an object's own properties read-only (in an ES module, writing to one throws a `TypeError`), but it's shallow too: arrays and objects inside it stay changeable. C++ contrast: there's no const-correctness, so you can't hand someone a read-only view of an object. The course relies on a habit instead.

**House rule:** treat message objects, tool arguments and tool output as read-only. Copy them, don't change them. The one thing that does change is the history **array**. The loop owns it, and only ever appends to it.

Why so strict? Because one message object has many readers: the history, the session file (Day 17), the UI, and your tests. Change it in one place, and every reader sees the change, including the ones that didn't expect it:

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

Day 1's toy was one file, so every line could see every other line. Today it becomes four files, and the rules for how files share code are the rules of ES modules.

**Every file is a module, with its own scope.** A top-level `const` in one file is invisible to every other file, unless the first file exports it and the second imports it. Nothing becomes global by accident, which is a welcome change if you've chased name clashes between C++ headers or Python's `from x import *`.

```js
// geometry.mjs
export const PI = 3.14159;
export function circleArea(r) { return PI * r * r; }
const scratch = [];                           // not exported: invisible outside this file
```

```js
// main.mjs
import { circleArea } from './geometry.mjs';  // the names must match the exports exactly
circleArea(2)                                 // → 12.56636
```

Today's split works the same way. `toy/bash-tool.mjs` exports `bashToolSpec` and `runBash`, and `toy/loop.mjs` imports them by name: `import { bashToolSpec, runBash } from './bash-tool.mjs'`.

A few rules about import paths:
- **Relative imports need the whole file name,** extension included: `'./geometry.mjs'`, not `'./geometry'`. Python and C++ search for the file for you. Node never guesses.
- **Built-in modules start with `node:`,** as in `import { spawnSync } from 'node:child_process'`.
- **`as` renames.** Day 1's toy used both forms: `import { stdin as input } from 'node:process'` renames one export, and `import * as readline from 'node:readline/promises'` gathers a whole module into one object.

**Prefer named exports.** With `export default`, each file that imports the value picks its own name for it, so one thing ends up with different names in different files. A named export has the same name everywhere: a search finds every use, and your editor can rename it safely. Use `export default` only when a module has one obvious thing to offer.

**A module's top-level code runs once, the first time anything imports it.** Later imports get the same, already-loaded module, and its code doesn't run again. That's why library modules should stay quiet. `ollama.mjs`, `bash-tool.mjs` and `loop.mjs` should only *define* things. Only `main.mjs`, the program you run, should *do* things like opening `readline` and starting the REPL.

You'll feel the reason tomorrow. The course tests import `loop.mjs` directly. If importing it opened a readline on your terminal, the tests would sit waiting for you to type, and never finish. Python contrast: this is the job `if __name__ == '__main__':` does in Python. JavaScript has no such guard, so the convention is to keep everything with side effects in the one file you run.

**Modules always run in strict mode.** Strict mode turns several silent mistakes into errors. Three of them matter today:
- a plain call `f()` gets `this === undefined` (sloppy mode substitutes the global object);
- writing to a frozen object throws a `TypeError` (sloppy mode silently ignores the write);
- assigning to a variable you never declared throws a `ReferenceError` (sloppy mode creates a global variable).

The REPL runs in sloppy mode. That's why today's `this` and `Object.freeze` experiments go in files.

### 7. JSDoc: types without TypeScript

If you come from C++, this may be the hardest thing to get used to: nothing checks your types before the program runs. Misspell a property, or pass a string where a number belongs, and JavaScript carries on until something downstream goes wrong. **JSDoc** comments let you write types down anyway. Your editor (VS Code reads them out of the box) uses them for autocompletion, hover information and error checking. Node ignores them like any other comment, so there's no build step.

Here's a small function with its types written out:

```js
/**
 * @typedef {object} Book
 * @property {string} title
 * @property {number} year
 * @property {string[]} [tags]
 */

/**
 * Find the books published before a given year.
 * @param {Book[]} books
 * @param {{ before: number, limit?: number }} opts
 * @returns {Book[]}
 */
export function olderThan(books, { before, limit = 10 }) { … }
```

How to read it:
- A JSDoc comment starts with `/**` (two stars) and sits directly above what it describes.
- `@typedef` names a type, and each `@property` adds a field to it. `Book` is "an object with a `title` string, a `year` number and, optionally, an array of `tags`". The square brackets around `[tags]` mark it optional.
- `@param {type} name` gives a parameter's type. `Book[]` is an array of books. `{ before: number, limit?: number }` is an object type written inline, and `?` marks a property as optional.
- `@returns {type}` gives the result's type.

Put `// @ts-check` on the first line of a file, and your editor reports mistakes as you type:

```js
// @ts-check
import { olderThan } from './books.mjs';

const shelf = [{ title: 'Emma', year: 1815 }];

olderThan(shelf, { befor: 1900 });
// ✗ Object literal may only specify known properties, but 'befor' does not exist in type
//   '{ before: number; limit?: number; }'. Did you mean to write 'before'?

olderThan(shelf, { before: '1900' });
// ✗ Type 'string' is not assignable to type 'number'.
```

Today's client needs one more kind of type: a function. `(a: T, b: U) => R` describes a function that takes a `T` and a `U` and returns an `R`. With that, the comment for `toy/ollama.mjs` reads like this:

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

`ToyClient` is "an object with a `model` string, and a `chat` function that takes two arrays and returns a promise of an object". Concept 8 explains what a promise is.

These checks are for *you*, while you write. Types don't exist at run time: Node runs the misspelled call anyway, with `before` set to `undefined`, and every comparison with `undefined` is `false`, so it quietly finds no books. Data you don't control, such as flags or a model's reply, still needs checking when it arrives (Day 5 starts on that). Day 5's stretch also runs the same checker over your whole project from the command line.

### 8. Just enough `async` and `await` to read today's code

The toy talks to two slow things: a model server that takes seconds to answer, and a person who takes even longer to type `y`. Day 1's code waited for both with `await`, and today's modules are full of `async` and `await` as well. Tomorrow is given over entirely to how waiting works in JavaScript. Today you need enough to read the code correctly, and to avoid one mistake that would quietly break your refactor. So let's be precise about the few rules involved.

**A promise is an object that stands for a result you don't have yet.** When a function starts something slow, such as a network request or a question on the terminal, it can't hand you the result straight away. Instead it returns a **promise** at once. A promise starts out **pending**. Later it **settles** in one of two ways: it is **fulfilled** with a value, or **rejected** with an error. Once settled, it never changes again. `fetch(url)` returns a promise of a response, and `rl.question('you> ')` returns a promise of the line you type.

The important thing to grasp is that the promise is *not* the result. It's a separate object that exists immediately, whether or not the result has arrived yet.

**`await` gets the result out of a promise.** Writing `await p` does three things:
1. It **pauses the function it's written in** until `p` settles. Only that function pauses. The rest of the program is free to carry on, which is what makes `await` different from a blocking call like Day 1's `spawnSync`. Tomorrow shows what "carry on" means in practice.
2. If `p` is fulfilled, `await p` **evaluates to the value**, so `const line = await rl.question('you> ')` leaves the typed line in `line`.
3. If `p` is rejected, `await p` **throws the error at that line**, so an ordinary `try`/`catch` around the `await` handles it.

`await` is allowed in only two places: inside a function marked `async`, and at the top level of an ES module, as Day 1's toy does. Anywhere else, it's a `SyntaxError` before the file runs.

**An `async` function always returns a promise.** Putting `async` in front of a function does two things. It lets you use `await` inside it, and it wraps whatever the function returns in a promise. Even a function that has the value immediately hands its caller a promise, never the value itself:

```js run
async function getAnswer() {
  return 42;
}

getAnswer()           // → Promise { 42 }   a promise that holds 42, not 42
await getAnswer()     // → 42
```

If an `async` function throws, its caller doesn't see an exception at the call. The promise it returned is rejected instead, and the error surfaces wherever someone `await`s that promise.

**Forgetting `await` is the bug to watch for today.** Without `await`, you're holding the promise, not the result. JavaScript won't complain, because a promise is a perfectly good value to hold. It's also an object, so it's truthy (concept 1), and that makes the mistake especially nasty in a condition:

```js run
async function isAllowed() {
  return false;                                    // imagine this asked a person, who said no
}

if (isAllowed()) console.log('allowed?!');         // prints! a promise is an object, so truthy
if (await isAllowed()) console.log('allowed');     // doesn't print: the answer really is false
```

That's exactly what can go wrong in today's refactor. Your loop will ask permission by calling `confirm(command)`, which returns a promise because it waits for the keyboard. Write `if (confirm(command))` instead of `if (await confirm(command))`, and every command runs without asking. Nothing crashes, and nothing warns you.

**`async` spreads upward.** A function that needs to `await` something must itself be `async`. So it returns a promise, so *its* callers must `await` it in turn. That's why `runTurns` is `async`, and why `main.mjs` writes `await runTurns(…)`.

Python contrast: `async def` and `await` in `asyncio` follow the same rules, with one difference worth knowing. In Python, calling an `async def` function without `await` doesn't run its body at all, and Python warns that a coroutine "was never awaited". In JavaScript, the body starts running straight away, up to its first `await`, and nothing warns you that the result was ignored. C++ contrast: a promise is roughly a `std::future`, but `await` gives the thread back while it waits, where `future.get()` blocks it.

With those rules, you can read the last piece of today's design: how the loop gets hold of its model, its shell and its human.

### 9. Dependency injection

Here's a small function that's surprisingly hard to test:

```js run
function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? 'Good morning' : 'Good afternoon';
}
```

What does it return? That depends on when you run it, so a test that expects `'Good morning'` passes before noon and fails after. The function reaches out and grabs something it doesn't control: the clock. The fix is to let the caller hand the clock in:

```js run
function greeting(now = new Date()) {
  return now.getHours() < 12 ? 'Good morning' : 'Good afternoon';
}

greeting(new Date(2026, 0, 1, 9))     // → 'Good morning'     9 a.m., whatever the real time is
greeting(new Date(2026, 0, 1, 15))    // → 'Good afternoon'
```

Ordinary callers write `greeting()` and get the real clock. A test passes in whatever time it needs. That's **dependency injection**. The function says *what* it needs, and the caller decides *how* to provide it.

Day 1's loop has the same problem three times over. It called the model, `rl.question` and `spawnSync` itself, which means it can only ever run with a real model, a real keyboard and a real shell. To test it, someone would have to sit there typing `y`.

Today, `runTurns` receives those abilities as arguments instead:

```js
export async function runTurns({ client, messages, confirm, runTool = runBash, maxTurns = 10 }) { … }
```

The loop says *what* it needs (something to chat with, a way to ask permission, a way to run a command), and the caller decides *how*. `main.mjs` passes the real things: an Ollama client, a `confirm` that asks on the terminal, and the default `runBash`. A test passes fakes:

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

Notice that the fakes are `async` even though they have nothing to wait for. Strictly they don't need to be, because `await` accepts a plain value too and simply hands it back. Writing them as `async` keeps them honest: they return promises, just like the real client and the real `confirm`, so the loop is tested the way it really runs.

No model, no keyboard, no shell, and it finishes in milliseconds. That's exactly how tomorrow's course tests check your loop. You'll meet the pattern all through the course: Day 5 injects `fetch`, and Day 12's approval function and Day 20's permission gate plug into the loop the same way `confirm` does.

Python contrast: it's the same idea as passing in a callable or a mock instead of patching a module. C++ contrast: it's like passing an interface or a `std::function` to a constructor, instead of calling a global.

## Build

**Files today:** `notes/day-02.md`, `scratch/closures.js`, `scratch/user.js`, and `toy/ollama.mjs`, `toy/bash-tool.mjs`, `toy/loop.mjs`, `toy/main.mjs`.

The work comes in two sittings. The first drills the language on small scratch files, and the second applies it to the toy. Take a real break between them.

### Sitting 1 — the language

#### 2.1 Predict, then evaluate — Core

These twelve expressions cover most of concepts 1 and 2. The predicting is the point: an answer you got wrong and then understood sticks far better than one you only read. For each expression below, **write your prediction in `notes/day-02.md` first**. Then evaluate it in the REPL, and wherever you were wrong, write one line on why.

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

This is concept 4's account example in miniature, so you can see the difference with your own code. In `scratch/user.js`, write a tiny user twice:

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

Now the language meets the toy. Keep `toy/agent.mjs` as it is, so you can compare the two versions later, and split a copy of it into the four files below. Give each export a JSDoc comment (concept 7).

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

Two things to keep in mind while you split. First, `confirm` and `runTool` both return promises, so the loop must `await` each of them. Leave out the `await` before `confirm`, and every command runs without asking (concept 8). Second, keep `loop.mjs` quiet: no `readline`, no `console.log` of the answer, nothing that happens just because the file was imported (concept 6). Printing is `main.mjs`'s job.

`node toy/main.mjs` must behave exactly like Day 1. **That is your test today.** From tomorrow, the course's tests drive `runTurns` with a fake client, a fake `confirm` and a fake `runTool`, as in concept 9, with no model and no keyboard.

#### 2.5 Contrast table — Core

Writing the differences down in one place is what makes them stick. In `notes/day-02.md`, fill in the JavaScript column in your own words:

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

The agent does exactly what it did yesterday, and that was the point. What changed is its shape. The loop now says what it needs and lets its caller supply it, so it can be driven by a test as easily as by a person. You also have the JavaScript to read everything that follows: values and their traps, closures and `this`, copying instead of changing, modules, types in comments, and the first rules of `await`. Tomorrow takes those rules much further. [Day 3](day-03.md) explains how JavaScript waits without blocking, and uses that to make Ctrl+C stop the work without stopping the program.

Before you move on, check:

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

`rl.question` returns a promise. Did you `await` it inside `confirm`, and `await confirm(cmd)` in the loop? A missing `await` gives you a `Promise` object, which is truthy, so every command runs without asking. Concept 8 shows the same bug in five lines. To find it, log what the condition actually sees: `console.log(confirm(cmd))` prints `Promise { <pending> }`, not `true` or `false`.
</details>

<details><summary>The answer prints as <code>[object Promise]</code>, or the loop seems to finish before the model replies</summary>

Somewhere a promise is being used as if it were its result. Usually `main.mjs` calls `runTurns(…)` without `await`, so it prints or reads `.text` from the promise instead of from the result. Every call to an `async` function needs an `await` in front of it, all the way up to the top level of `main.mjs` (concept 8, "`async` spreads upward").
</details>

<details><summary>Hover types don't show up in my editor</summary>

VS Code reads JSDoc out of the box. Make sure the comment starts with `/**` (two stars) and sits directly above the function. For stricter checking, add `// @ts-check` as the first line of the file.
</details>

## Common mistakes

- **Using `==`, or `||` where you meant `??`.** Both convert values behind your back. `numCtx || 8192` replaces a deliberate `0`, because `||` treats every falsy value as missing.
- **Testing an array with `if (list)` instead of `if (list.length)`.** It's a Python habit: every array is truthy in JavaScript, even an empty one.
- **Treating spread as a deep copy, then "immutably" changing nested arrays.** Spread copies only the top level. The nested array is still shared with the original, so the change shows up in both.
- **Passing `obj.method` as a callback and losing `this`.** The function travels without its object, and whoever calls it decides what `this` is. Wrap it in an arrow function, or `.bind` it.
- **Leaving out an `await`.** You get the promise instead of the result. Nothing throws, and a promise in a condition is always truthy.

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
- javascript.info, [Promise](https://javascript.info/promise-basics) · [Async/await](https://javascript.info/async-await): a gentle preview of tomorrow, if concept 8 left you curious
- TypeScript handbook, [JSDoc reference](https://www.typescriptlang.org/docs/handbook/jsdoc-supported-types.html)

---
← [Day 1](day-01.md) · [Curriculum home](README.md) · Next: [Day 3 — Async JavaScript: make Ctrl+C work](day-03.md) →
