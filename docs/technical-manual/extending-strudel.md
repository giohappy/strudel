# Extending Strudel: Registration, Params, and I/O — A Functional Architecture Guide

> This guide complements the existing material under `docs/` and the website's
> technical manual. It goes deeper into *how* Strudel turns plain functions into
> the chainable, patternified API you write in the REPL, what "param/control"
> functions really are, how the MIDI/OSC/WebSocket output packages plug into the
> playback engine, and how **you** can register your own pattern methods or a
> whole new I/O module.
>
> All line numbers refer to the source at the time of writing and are meant as
> navigation anchors, not contracts.

---

## Table of contents

1. [The mental model: a Pattern is `State → [Hap]`](#1-the-mental-model-a-pattern-is-state--hap)
2. [`register()`: turning a function into a chainable method](#2-register-turning-a-function-into-a-chainable-method)
3. [Param / control functions](#3-param--control-functions)
4. [Stateful vs. non-stateful (pure) functions](#4-stateful-vs-non-stateful-pure-functions)
5. [How output modules hook into playback (MIDI, OSC, WebSocket/MQTT)](#5-how-output-modules-hook-into-playback)
6. [Recipes: registering your own functions and modules](#6-recipes-registering-your-own-functions-and-modules)
7. [Two end-to-end examples](#7-two-end-to-end-examples)
8. [Quick reference](#8-quick-reference)

---

## 1. The mental model: a Pattern is `State → [Hap]`

Everything below makes sense only once this is internalised: **a `Pattern` is a thin
wrapper around one lazy function** that, given a query window (`State`), returns the
list of events (`Hap`) that fall inside it.

```js
// packages/core/pattern.mjs:52
constructor(query, steps = undefined) {
  this.query = query;      // State -> Hap[]
  this._Pattern = true;    // duck-typing flag, see isPattern()
  this._steps = steps;     // steps-per-cycle metadata (for the "steppy" API)
}
```

Nothing is precomputed. A pattern is a *recipe* evaluated on demand whenever
someone calls `.query(state)`.

### `State` — the query window

```js
// packages/core/state.mjs:7
export class State {
  constructor(span, controls = {}) {
    this.span = span;          // a TimeSpan (begin..end, in cycles)
    this.controls = controls;  // query-time params: { randSeed, id, _cps, ... }
  }
  setSpan(span)      { return new State(span, this.controls); }
  withSpan(func)     { return this.setSpan(func(this.span)); }
  setControls(c)     { return new State(this.span, { ...this.controls, ...c }); }
}
```

`State` is **immutable** — every mutator returns a fresh instance. Note that
`State.controls` is *not* the audio-control registry (`gain`, `note`, …). It is a
small bag of query-time parameters such as `randSeed` (for deterministic random)
and `id`. Keep these two meanings of "controls" separate — they collide by name
only.

### `Hap` — one event

```js
// packages/core/hap.mjs:25
constructor(whole, part, value, context = {}, stateful = false) {
  this.whole = whole;   // the full event span; undefined => continuous signal
  this.part  = part;    // the (clipped) span actually inside the query window
  this.value = value;   // the payload: a number, string, or controls object
  this.context = context; // metadata: source locations, onTrigger, ...
  this.stateful = stateful;
}
```

A discrete event has a defined `whole`; a continuously-changing **signal** emits
haps with `whole === undefined` (its value is sampled at a point in time).

### The query entry point

```js
// packages/core/pattern.mjs:420
queryArc(begin, end, controls = {}) {
  try {
    return this.query(new State(new TimeSpan(begin, end), controls));
  } catch (err) { errorLogger(err, 'query'); return []; }
}
```

The canonical "pure" pattern, `pure(v)`, emits one hap per cycle covering the
query span — it depends on the span only, never on hidden state:

```js
// packages/core/pattern.mjs:1384
export function pure(value) {
  function query(state) {
    return state.span.spanCycles.map(
      (subspan) => new Hap(Fraction(subspan.begin).wholeCycle(), subspan, value),
    );
  }
  const result = new Pattern(query, 1);
  result.__pure = value;   // marks it as a "pure" literal — used as a fast path below
  return result;
}
```

> **Why this matters for extension:** when you write a new pattern function you
> are writing a function that *transforms one query function into another*. You
> rarely build `Hap`s by hand — you wrap an existing pattern's `query`.

---

## 2. `register()`: turning a function into a chainable method

When you call `s("bd").fast(2).rev()`, both `.fast` and `.rev` are methods on
`Pattern.prototype`. They get there through a single function, `register()`, in
`packages/core/pattern.mjs`. This is the heart of Strudel's extensibility.

### 2.1 The contract

```js
// packages/core/pattern.mjs:1743
export function register(
  name,                 // string OR string[] (synonyms)
  func,                 // (...args, pat) => Pattern   — pattern is the LAST arg
  patternify = true,    // auto-reify/patternify the leading args?
  preserveSteps = false,
  join = (x) => x.innerJoin(),
) { ... }
```

The convention `func(...args, pat)` — **the current pattern is always the last
parameter** — is what lets `register` expose the same `func` two ways:

- as a **standalone, curried function** `name(...args, pat)` (added to `strudelScope`), and
- as a **chainable method** `pat.name(...args)` (added to `Pattern.prototype`),
  where `this` is appended as the final `pat` argument.

> #### 🔎 Deep dive: why the pattern is the *last* argument
>
> This single convention is the hinge the whole dual-API design turns on. Think
> about what each call form needs:
>
> - The **method** form `pat.fast(2)` already *has* the pattern — it is `this`.
>   So the method just needs to take the user's args (`2`) and tack `this` on the
>   end: `func(2, this)`.
> - The **function** form `fast(2, pat)` passes everything explicitly, pattern
>   included, in the same positions.
>
> Because the pattern always lands in the **same final slot**, one `func` body
> serves both call sites unchanged — `register` never has to rewrite argument
> order. It also makes the function **point-free / partially applicable**:
> `fast(2)` (pattern omitted) returns "a transformation waiting for a pattern",
> which is precisely what currying gives you (see the currying inset below) and
> what makes `fast(2)` usable as a value you can pass to `someOtherPattern.apply(...)`,
> store in a variable, or compose. Put the pattern first and you lose all of
> that: you could no longer write `fast(2)` and mean "the doubling transform".
>
> This is the functional-programming idiom *"data last"* — the same reason
> libraries like Ramda or lodash/fp put the collection last. In Strudel the
> "data" is always the `Pattern`.

The JSDoc on `register` even ships a runnable example:

```js
// packages/core/pattern.mjs:1737 (from the doc comment)
const vlpf = register('vlpf', (freq, pat) => {
  return pat.fmap((v) => ({ ...v, cutoff: freq * (v.velocity ?? 1) }));
});
s("saw").seg(8).velocity(rand).vlpf(800)
```

### 2.2 What `register` does, step by step

**(a) Guard against double-quote mistakes.** If `name` is itself a `Pattern`,
the user double-quoted the name and the mini-notation parser turned it into a
pattern. Throw a helpful error:

```js
// packages/core/pattern.mjs:1744
if (isPattern(name)) {
  throw new Error(
    'Name argument for register is a pattern, try using single quotes (\'name\') instead of double quotes ("name")',
  );
}
```

**(b) Synonyms via recursion.** Passing an array registers each name
independently and returns an object keyed by every name:

```js
// packages/core/pattern.mjs:1750
if (Array.isArray(name)) {
  const result = {};
  for (const name_item of name) {
    result[name_item] = register(name_item, func, patternify, preserveSteps, join);
  }
  return result;
}
// usage: const { fast, density } = register(['fast', 'density'], ...)
```

**(c) Capture arity.** `func.length` drives both currying and argument-count
validation: `const arity = func.length;` (pattern.mjs:1757).

> #### 🔎 Deep dive: what "arity" means here and why it is read from `func.length`
>
> **Arity** is simply *how many arguments a function declares*. In JavaScript,
> `function.length` reports the number of parameters **before** the first one
> with a default value or a rest (`...`) parameter. Strudel leans on this as a
> zero-config way to learn the shape of your function — you never declare the
> argument count separately; you just write the parameters and `register` counts
> them.
>
> Because the pattern is the last parameter (previous inset), arity is always
> `userArgs + 1`:
>
> | Your `func` | `func.length` (arity) | User-facing args | Example |
> |---|---|---|---|
> | `(pat) => …` | 1 | 0 | `.rev()`, `.brak()` |
> | `(n, pat) => …` | 2 | 1 | `.fast(2)`, `.gain(0.5)` |
> | `(a, b, pat) => …` | 3 | 2 | `.range(0, 1)` |
>
> This is why the chainable wrapper checks `arity !== args.length + 1`
> (pattern.mjs:1810): the `+ 1` accounts for `this` filling the final slot. Two
> consequences worth internalising:
>
> 1. **Default values change arity.** If you write `(n = 2, pat) => …`, then
>    `func.length` is `0`, not `2` — JS stops counting at the first defaulted
>    param. `register` would then treat your function as arity-1 and never
>    patternify `n`. **Fix:** don't default the leading args in a registered
>    `func`; handle "missing" inside the body, or keep them required.
> 2. **Arity-2 is special-cased.** A method declared with arity 2 may receive
>    *several* args and Strudel sequences them: `.fast(2, 4)` becomes
>    `.fast("2 4")` (pattern.mjs:1808, `sequence(...args)`). That ergonomic
>    shortcut exists only for the single-user-arg case.

**(d) Build `pfunc`, the patternified core.** When `patternify` is true, the
leading arguments are themselves allowed to be patterns (so you can write
`fast("2 4", x)`). The arguments are `reify`-d (turned into patterns), and the
result is assembled by applicative composition:

```js
// packages/core/pattern.mjs:1761
pfunc = function (...args) {
  args = args.map(reify);
  const pat = args[args.length - 1];   // last arg is the pattern
  let result;

  if (arity === 1) {
    result = func(pat);                // nothing to patternify
  } else {
    const firstArgs = args.slice(0, -1);

    // Fast path: every leading arg is a plain literal (pure) -> call func directly
    if (firstArgs.every((arg) => arg.__pure != undefined)) {
      const pureArgs = firstArgs.map((arg) => arg.__pure);
      result = func(...pureArgs, pat);
      result = result.withContext(/* merge source locations */);
    } else {
      // General case: fold the patterned args over the pattern with appLeft + join
      const [left, ...right] = firstArgs;
      let mapFn = (...args) => func(...args, pat);
      mapFn = curry(mapFn, null, arity - 1);
      result = join(right.reduce((acc, p) => acc.appLeft(p), left.fmap(mapFn)));
    }
  }
  if (preserveSteps) result._steps = pat._steps;
  return result;
};
```

The `appLeft`/`join` machinery is what makes `fast("<2 4>", pat)` mean "the speed
factor itself follows a pattern". The default `join` is `innerJoin` (the inner
pattern's structure wins). `stepRegister` (pattern.mjs:1837) is the same function
with `join = stepJoin` for the steppy API.

> #### 🔎 Deep dive: what "patternify" actually does
>
> **Patternify** is Strudel's term for *"let an argument be a pattern, not just a
> constant"*. When you write `.fast(2)` the speed is constant. But Strudel also
> lets you write `.fast("<2 4>")` — alternate between doubling and quadrupling
> each cycle — or `.fast(sine.range(1, 4))` — sweep the speed continuously. The
> argument has become time-varying. Patternification is the generic machinery
> that makes *every* registered function accept patterned arguments without the
> author writing any special code.
>
> It is built from four small pieces, all in `packages/core`:
>
> 1. **`reify`** (pattern.mjs:1409) — coerce *anything* into a `Pattern`. A number
>    becomes `pure(n)`; a string is parsed as mini-notation; a pattern is left
>    alone. After `args.map(reify)` (pattern.mjs:1762) **every** argument is a
>    pattern, so the rest of the code only ever deals with patterns.
> 2. **`fmap`** (pattern.mjs:95) — map a function over the *values* a pattern
>    produces, leaving its time structure intact. `pure(2).fmap(x => x*10)` is
>    `pure(20)`.
> 3. **`appLeft`** — *applicative application*: combine a pattern **of functions**
>    with a pattern **of values**, keeping the **left** (function) pattern's
>    timing. This is the engine that aligns "the changing argument" with "the
>    pattern being transformed".
> 4. **`join`** — flatten a pattern-of-patterns back into a plain pattern (see the
>    next inset).
>
> Read the general-case line with that vocabulary:
>
> ```js
> // packages/core/pattern.mjs:1786
> result = join(right.reduce((acc, p) => acc.appLeft(p), left.fmap(mapFn)));
> ```
>
> - `left.fmap(mapFn)` turns the first argument-pattern into a **pattern of
>   partially-applied functions** (each value `a` becomes `b => func(a, b, pat)`).
> - `.appLeft(p)` feeds the next argument-pattern in, and so on for every extra
>   arg (`right.reduce(...)`). Now we have a pattern whose values are *patterns*
>   (because `func` returns a pattern).
> - `join(...)` collapses that nesting into the final flat pattern.
>
> **Why this is elegant:** the author of `fast` wrote a function of plain numbers.
> They got "argument may be a constant, a mini-notation pattern, a signal, or an
> alternation" **for free**, because `register` lifts the plain function into the
> applicative structure of patterns. This is the same `fmap`/`ap` pattern as
> Haskell's applicative functors — Strudel is, under the hood, a small applicative
> algebra over `State → [Hap]`.
>
> **The fast paths.** Two optimisations sidestep this when nothing is gained:
> arity-1 functions skip it entirely (`func(pat)`, pattern.mjs:1766); and when
> every leading arg is a plain literal (`__pure`, the marker `pure()` stamps on),
> `func` is called directly on the unwrapped values (pattern.mjs:1771). The
> applicative path only runs when an argument is *genuinely* patterned.

> #### 🔎 Deep dive: `join` and why the default is `innerJoin`
>
> When a patterned argument drives a transformation you momentarily get a
> **pattern of patterns** (outer = the argument's timing, inner = the transformed
> result). `join` decides *whose timing survives* when you flatten it back to one
> level. Strudel ships several joins; the choice is a real musical decision:
>
> | Join | Timing kept | Typical use |
> |---|---|---|
> | `innerJoin` | the **inner** (result) pattern's structure | **default** for `register`; e.g. `fast("<2 4>")` — the speed switches at cycle boundaries but the *sped-up pattern's* events define the grid |
> | `outerJoin` | the **outer** (argument) pattern's structure | when the controlling pattern should dictate the rhythm |
> | `stepJoin` | aligns by **steps-per-cycle** (`_steps`) | the "steppy" API (`stepRegister`), so step counts compose predictably |
> | `restart`/`reset` | inner, but **retriggered** when the outer changes | sample-accurate restarts |
>
> Picking the wrong join is the most common cause of "my patterned argument
> sounds off". If you `register` a function and the patterned argument should
> instead impose its own grid, pass `outerJoin`:
>
> ```js
> register('myFunc', (arg, pat) => /* ... */, true, false, (x) => x.outerJoin());
> ```
>
> The two trailing args of `register` are exactly these knobs: `preserveSteps`
> and `join` (see signature in §2.1).

**(e) Install the chainable method.** This is the line that makes everything
chainable:

```js
// packages/core/pattern.mjs:1805
Pattern.prototype[name] = function (...args) {
  // arity-2 methods accept multiple args and sequence them: .fast(2,4) => .fast("2 4")
  if (arity === 2 && args.length !== 1) {
    args = [sequence(...args)];
  } else if (arity !== args.length + 1) {
    throw new Error(`.${name}() expects ${arity - 1} inputs but got ${args.length}.`);
  }
  args = args.map(reify);
  return pfunc(...args, this);   // <-- 'this' (the pattern) becomes the last arg
};
```

**(f) Install a raw `_`-prefixed variant** (for `arity > 1`) that skips
patternification of the leading args — handy internally when you already hold
plain values:

```js
// packages/core/pattern.mjs:1820
Pattern.prototype['_' + name] = function (...args) {
  const result = func(...args, this);
  if (preserveSteps) result.setSteps(this._steps);
  return result;
};
```

**(g) Curry + publish the standalone function.** Because `pfunc` uses spread
args its own `.length` is 0, so the arity must be passed explicitly to `curry`:

```js
// packages/core/pattern.mjs:1831
const curried = curry(pfunc, null, arity);
strudelScope[name] = curried;   // make it resolvable by the transpiler/evaluator
return curried;
```

`curry` itself is a standard partial-application helper:

```js
// packages/core/util.mjs:177
export function curry(func, overload, arity = func.length) {
  const fn = function curried(...args) {
    if (args.length >= arity) return func.apply(this, args);
    const partial = (...args2) => curried.apply(this, args.concat(args2));
    if (overload) overload(partial, args);
    return partial;
  };
  if (overload) overload(fn, []);
  return fn;
}
```

> #### 🔎 Deep dive: currying, and what it buys the standalone functions
>
> **Currying** transforms a function that wants all its arguments at once into one
> that can receive them *a few at a time*, returning a new function each time
> until enough have arrived. The helper above implements exactly that: every call
> checks `args.length >= arity` (pattern.mjs/util.mjs) — if enough arguments are
> present it runs `func`; otherwise it returns a `partial` that remembers what it
> has and waits for the rest.
>
> Concretely, for the standalone `fast` (arity 2):
>
> ```js
> fast(2, somePattern)   // all args -> runs immediately
> fast(2)                // one arg  -> returns a function (pattern) => fast(2, pattern)
> ```
>
> That second form is the payoff. `fast(2)` is a **reusable transformation** — a
> value you can name, pass around, and apply later:
>
> ```js
> const double = fast(2);          // a transform, not yet applied
> const f0 = double(s("bd sd"));   // apply it
> // and it composes with combinators that expect "a function of a pattern":
> s("hh*8").every(2, fast(2))      // 'every' takes such a function as its 2nd arg
> ```
>
> Without currying, `every(2, fast(2))` would be impossible — you'd have to wrap
> it in an arrow `every(2, x => fast(2, x))` everywhere. Currying makes the
> point-free style (data-last, previous inset) actually usable.
>
> **Why `register` passes `arity` explicitly** (`curry(pfunc, null, arity)`,
> pattern.mjs:1831): `pfunc` is written with a rest parameter (`...args`), so its
> own `.length` is `0`. If `curry` trusted `func.length` it would think `pfunc`
> takes no args and fire on the very first call, defeating partial application.
> Passing the real `arity` (captured from the *original* `func` back in step (c))
> restores the correct threshold. This is the one place the separately-captured
> arity is indispensable — a subtle but load-bearing detail.

### 2.3 The global registry: `strudelScope`

Every registered name is written into `strudelScope`, a plain object exposed on
`globalThis`:

```js
// packages/core/evaluate.mjs:7
export const strudelScope = {};
globalThis.strudelScope = strudelScope;
```

This is the namespace the transpiler/evaluator uses to resolve the identifiers in
your REPL code. When you load a package you call `evalScope(import('@strudel/midi'), ...)`,
which copies every export of the module into **both** `globalThis` and
`strudelScope`:

```js
// packages/core/evaluate.mjs:37
export const evalScope = async (...args) => {
  const results = await Promise.allSettled(args);
  const modules = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  modules.forEach((module) => {
    Object.entries(module).forEach(([name, value]) => {
      globalThis[name] = value;
      strudelScope[name] = value;
    });
  });
  return modules;
};
```

> **Takeaway:** there are two doors into the user-facing API. `register()` adds a
> single chainable name; `evalScope()` bulk-imports a module's exports. Most I/O
> packages use *both* — `register()` (or a direct prototype assignment) inside the
> module, and `evalScope()` to load the module.

---

## 3. Param / control functions

A **control** (a.k.a. **param**) is a function such as `note`, `s`, `gain`,
`speed`, `cutoff`, `ccn`. Each control corresponds to **one key in a Hap's value
object**. So:

```js
note("c").gain(0.5)   // => haps whose value is { note: "c", gain: 0.5 }
```

The synth backend (superdough) and the I/O packages then read those keys. Controls
are built by `createParam` and registered by `registerControl` in
`packages/core/controls.mjs`.

### 3.1 `createParam`: building the value-merger

```js
// packages/core/controls.mjs:10
export function createParam(names) {
  let isMulti = Array.isArray(names);
  names = !isMulti ? [names] : names;
  const name = names[0];

  // withVal: turn a raw hap value into a controls object keyed by name(s)
  const withVal = (xs) => {
    let bag;
    if (typeof xs === 'object' && xs.value !== undefined) {
      bag = { ...xs };       // keep already-present keys
      xs = xs.value;         // grab the "unnamed" slot for this control
      delete bag.value;
    }
    if (isMulti && Array.isArray(xs)) {           // e.g. s("bd:3") => ['bd', 3]
      const result = bag || {};
      xs.forEach((x, i) => { if (i < names.length) result[names[i]] = x; });
      return result;                              // => { s:'bd', n:3 }
    } else if (bag) {
      bag[name] = xs;
      return bag;
    } else {
      return { [name]: xs };                       // gain(0.5) => { gain: 0.5 }
    }
  };

  // func: works both as a standalone source and as a method body
  const func = function (value, pat) {
    if (!pat) return reify(value).withValue(withVal);      // standalone: gain("0.5 1")
    if (typeof value === 'undefined') return pat.fmap(withVal); // wrap bare values
    return pat.set(reify(value).withValue(withVal));        // method: merge onto pat
  };

  Pattern.prototype[name] = function (value) {   // <-- chainable method
    return func(value, this);
  };
  return func;
}
```

Two ideas to take away:

- **`withVal`** is the per-hap value transformer: scalar → `{name: scalar}`, or a
  colon-tuple → spread across several keys. The `xs.value` branch is what lets
  controls *accumulate* keys when chained.
- The single-value vs. multi-value distinction (`isMulti`) is how `s("bd:3:0.8")`
  becomes `{ s:'bd', n:3, gain:0.8 }`.

### 3.2 `registerControl`: name + aliases

```js
// packages/core/controls.mjs:63
const controlAlias = new Map();                 // alias -> main name
export function isControlName(name) { return controlAlias.has(name); }

export function registerControl(names, ...aliases) {
  const name = Array.isArray(names) ? names[0] : names;
  let bag = {};
  bag[name] = createParam(names);               // build the function once
  controlAlias.set(name, name);
  aliases.forEach((alias) => {
    bag[alias] = bag[name];                      // alias shares the SAME function
    controlAlias.set(alias, name);
    Pattern.prototype[alias] = Pattern.prototype[name];  // and the same method
  });
  return bag;
}
```

Real registrations:

```js
// packages/core/controls.mjs:111
export const { s, sound } = registerControl(['s', 'n', 'gain'], 'sound');
// packages/core/controls.mjs:431
export const { note } = registerControl(['note', 'n']);
// packages/core/controls.mjs:1306
export const { cutoff, lpf } = registerControl(['cutoff', 'resonance', 'lpenv'], 'ctf', 'lpf', 'lp');
```

Note how `s` and `sound` are literally the *same* function (alias sharing),
whereas `register()` (section 2) builds a *fresh* function per synonym. The
`controlAlias` map powers `isControlName()`, which the mini-notation parser uses
to know what counts as a control.

`registerMultiControl` (controls.mjs:76) generates numbered families like
`fm1`…`fm8` by repeatedly calling `registerControl` with suffixed names.

### 3.3 How chained controls merge: `set` + `unionWithObj`

`note("c").gain(0.5)` calls `func(0.5, notePattern)` → `notePattern.set(gainPattern)`.
The `set` composer means "right value wins on conflict":

```js
// packages/core/pattern.mjs:1083
set: [(a, b) => b],
```

The actual object merge happens in `_composeOp` → `unionWithObj`:

```js
// packages/core/pattern.mjs:1044
function _composeOp(a, b, func) {
  if (_nonArrayObject(a) || _nonArrayObject(b)) {
    if (!_nonArrayObject(a)) a = { value: a };
    if (!_nonArrayObject(b)) b = { value: b };
    return unionWithObj(a, b, func);
  }
  return func(a, b);
}
// packages/core/value.mjs:10
export function unionWithObj(a, b, func) {
  const common = Object.keys(a).filter((k) => Object.keys(b).includes(k));
  return Object.assign({}, a, b, Object.fromEntries(common.map((k) => [k, func(a[k], b[k])])));
}
```

So merging `{note:'c'}` with `{gain:0.5}` → `{note:'c', gain:0.5}`. For
*non-conflicting* keys it is a plain union; for conflicting keys the composer
decides — `set` keeps the right side, while arithmetic composers (`add`, `mul`)
combine them. **There is no separate "controls registry" stored on a Pattern: the
merged value object on each Hap *is* the accumulated set of controls.**

> #### 🔎 Deep dive: controls are just values, and why that is powerful
>
> A control like `gain` does not flip a knob on the pattern. It produces a
> *pattern of tiny objects* (`{gain: …}`) and **merges** that into the value
> stream. Chaining controls is therefore nothing but repeated object-merging at
> query time. Three implications follow, and they explain a lot of Strudel's
> expressive surface:
>
> 1. **Controls are themselves patterns.** `gain("1 0.5 0.25")` is a pattern of
>    three gain objects. So a control's argument can be a mini-notation rhythm, a
>    signal (`gain(sine)`), or an alternation (`gain("<1 0.5>")`) — for the exact
>    same reason any registered function's args can (patternify inset). `gain` is
>    registered the same way everything else is.
>
> 2. **The merge operator is pluggable — that is what `add`/`set`/`mul` are.**
>    `note("c").gain(0.5)` uses `set` (right wins). But Strudel exposes the *same*
>    object-merge through arithmetic composers: `n("0 2 4").add(n("12"))` merges
>    with `+` instead of "right wins", yielding `n("12 14 16")`. The composer
>    table (pattern.mjs:1083) is literally a dictionary from operator name to the
>    `func` that `unionWithObj` applies to conflicting keys. Controls and maths
>    are the same machinery with a different merge function.
>
> 3. **The `value` slot is the glue for "unnamed" values.** When `withVal`
>    (controls.mjs:10) sees an object carrying a bare `.value`, it assigns that
>    value to *this* control's key and keeps the rest. This is what lets a chain
>    like `"0.5".gain` work even though `"0.5"` started life as a plain
>    number-pattern, not an object: the scalar travels in the `value` slot until a
>    control gives it a name. `_composeOp` (pattern.mjs:1044) wraps any non-object
>    operand as `{ value: x }` for precisely this reason.
>
> The mental model: **a Hap's value grows by accumulation, never by mutation.**
> Each control returns a new merged object; nothing is edited in place, preserving
> the purity discussed in §4.

---

## 4. Stateful vs. non-stateful (pure) functions

### 4.1 Pure / structural functions (the vast majority)

Most pattern functions are **pure transformations of pattern structure** — they
manipulate timespans and values without reading wall-clock time or RNG. They are
built by composing query wrappers:

```js
// packages/core/pattern.mjs:453 — the basis of fast/slow/early/late
withQuerySpan(func) {
  return new Pattern((state) => this.query(state.withSpan(func)));
}
// packages/core/pattern.mjs:95 — the basis of every value transform
withValue(func) {
  return new Pattern((state) => this.query(state).map((hap) => hap.withValue(func)));
}
```

These are pure in the mathematical sense: **`query(state)` is a deterministic
function of `state` alone.** Same `State` in → same `Hap[]` out. They store
nothing.

> #### 🔎 Deep dive: "referential transparency" and why Strudel insists on it
>
> A function is **referentially transparent** when you can replace any call with
> its result without changing program behaviour — i.e. it depends only on its
> inputs and has no side effects. For a Strudel pattern this means
> `pat.query(state)` returns the same haps *every time* it is asked about the same
> window, no matter how often or in what order. This is not academic tidiness; it
> is what makes the engine work at all:
>
> - **Scrubbing, looping and re-renders are free.** The scheduler re-queries
>   windows constantly (every clock tick, after a tempo change, when you jump the
>   playhead). If a query mutated hidden state, re-asking the same window would
>   give a different answer and the music would drift or glitch. Purity guarantees
>   that querying cycle 12 always yields cycle 12.
> - **Random is reproducible.** Because `rand` is a pure hash of *time + seed*
>   (§4.3), the "random" choice at a given moment is fixed. Reload the page, jump
>   back, run it on another machine — the same beat plays. Randomness without
>   stored state is only possible because time is an input.
> - **Patterns are cheap to copy and combine.** `cat`, `stack`, `every`, etc.
>   freely query their child patterns over shifted/stretched windows. They can do
>   that fearlessly *because* a child has no internal cursor to corrupt — there is
>   nothing to clone or reset.
> - **Laziness costs nothing extra.** A pattern is just a function, so describing
>   an hour of music allocates nothing until a window is queried. Composition
>   builds bigger functions, not bigger data.
>
> The practical rule for extenders: **a registered function should compute its
> haps purely from the `State` it is handed.** If you find yourself reaching for a
> module-level variable that changes over time, you are stepping outside the model
> (§4.4) — sometimes legitimately (mouse, MIDI input), but know that you are
> trading away the guarantees above for that pattern.

### 4.2 Signals: time-derived, but still pure

Signals (`sine`, `saw`, `rand`, `perlin`, …) are *not* stored state. They derive
their value from the **queried timespan**, sampled at its begin point:

```js
// packages/core/signal.mjs:17
export const signal = (func) => {
  const query = (state) => [new Hap(undefined, state.span, func(state.span.begin, state.controls))];
  return new Pattern(query);
};
// examples
export const saw  = signal((t) => t % 1);                      // signal.mjs:36
export const sine2 = signal((t) => Math.sin(Math.PI * 2 * t)); // signal.mjs:75
export const time = signal(id);                                // signal.mjs:170
```

Time is an **input** (`state.span.begin`), not a side effect. Query the same span
twice → identical result. Signals emit one continuous hap (`whole === undefined`).

> #### 🔎 Deep dive: continuous vs. discrete haps, and "sampling" a signal
>
> Strudel has two kinds of events, distinguished by whether `whole` is set:
>
> - **Discrete** haps (notes, samples) have a `whole` timespan — they *occur* at a
>   start time and have a duration. Only these "have an onset" and get scheduled
>   (the cyclist checks `hap.hasOnset()`, §5.2).
> - **Continuous** haps (signals) have `whole === undefined`. They do not occur at
>   a point; they represent *a value defined across the whole query window*. A
>   signal is a function of time that has been wrapped as a pattern.
>
> So `sine` by itself never makes a sound — it has no onsets to trigger. It only
> becomes audible/visible when a **discrete** pattern *samples* it. That is what
> `gain(sine)` or `note("c").gain(sine)` does: the discrete `note` events impose
> onsets, and at each onset the signal is **sampled** — evaluated at a single
> point in time (Strudel samples at the midpoint of the event's part). This is why
> the docs say a continuous value is "sampled from the point halfway between the
> start and end of the part" (hap.mjs:15).
>
> The mental picture: a signal is a smooth curve with no events of its own;
> discrete patterns are a comb of onsets; combining them reads the curve's height
> at each tooth of the comb. This cleanly separates *what value* (the signal) from
> *when to read it* (the rhythm) — and both halves stay pure, because the signal
> is `t → value` and the rhythm only supplies the `t`s.

### 4.3 Random: a deterministic hash of time + seed

Randomness is pure too — a hash of the queried time and a seed threaded through
`State.controls.randSeed`:

```js
// packages/core/signal.mjs:480
export const rand = signal((t, controls) => getRandsAtTime(t, 1, controls.randSeed));

// packages/core/signal.mjs:445 — how the seed is injected/overridden at query time
export const withSeed = (func, pat) =>
  new Pattern((state) => {
    let { randSeed, ...controls } = state.controls;
    randSeed = func(randSeed);
    return pat.query(state.setControls({ ...controls, randSeed }));
  }, pat._steps);
```

Two patterns querying the same time with the same seed get the same random value
— that is why random patterns are reproducible across re-renders.

### 4.4 The genuinely impure leaks

A few signals read **module-level mutable state** outside `State`, so they are
*not* referentially transparent. Use them knowingly:

```js
// packages/core/signal.mjs:191 — reads a global mutated by a mousemove listener
export const mousex = signal(() => _mouseX);
// packages/core/signal.mjs:988 — reads live keyboard state
// useRNG / RNG_MODE (signal.mjs:278/297) toggles RNG behaviour globally
```

### 4.5 The Hap-level `stateful` flag (a distinct concept)

Separately, an individual **Hap** may carry a `stateful` flag. This is *not* about
pattern purity; it is an opt-in where a hap's value is a function
`state → [newState, newValue]`, resolved at scheduling time against an evolving
runtime accumulator:

```js
// packages/core/hap.mjs:25
constructor(whole, part, value, context = {}, stateful = false) {
  ...
  this.stateful = stateful;
  if (stateful) console.assert(typeof this.value === 'function', 'Stateful values must be functions');
}
// packages/core/hap.mjs:99
resolveState(state) {
  if (this.stateful && this.hasOnset()) {
    const [newState, newValue] = this.value(state);
    return [newState, new Hap(this.whole, this.part, newValue, this.context, false)];
  }
  return [state, this];
}
```

This is the one place a hap's *final* value is computed by threading a running
state rather than being a pure function of the query — the deliberate exception
to value purity.

> **Rule of thumb for extenders:** keep your registered functions pure — wrap
> `query`/`withValue`/`withQuerySpan` and let time and randomness arrive through
> `State`. Reach for module globals or `stateful` haps only when you genuinely
> need to bridge to the outside world.

---

## 5. How output modules hook into playback

MIDI, OSC, and MQTT all plug into the **same** chain:

```
control registration (core)  →  onTrigger context attachment  →  scheduler (cyclist)  →  trigger dispatch (getTrigger)
```

Understand this spine once and every output package becomes trivial.

### 5.1 `onTrigger`: the attachment point

`.midi()`, `.osc()` etc. ultimately call `pat.onTrigger(fn)`. It does **not** send
anything — it attaches a callback and a `dominantTrigger` flag onto every hap's
`context` via `withHap`:

```js
// packages/core/pattern.mjs:875
onTrigger(onTrigger, dominant = true) {
  return this.withHap((hap) =>
    hap.setContext({
      ...hap.context,
      onTrigger: (...args) => {
        hap.context.onTrigger?.(...args);  // chain any previously-set trigger
        onTrigger(...args);
      },
      // when true, the default WebAudio output is suppressed for this hap
      dominantTrigger: hap.context.dominantTrigger || dominant,
    }),
  );
}
```

Triggers **chain** (line: `hap.context.onTrigger?.(...args)` runs first), so
`.log().midi()` works. `dominant = true` (default) suppresses default audio;
outputs that should *also* play audio pass `dominant = false` (e.g. `.log()`).

> #### 🔎 Deep dive: trigger chaining and the `dominantTrigger` flag
>
> Two design decisions live in this small function, and both matter when you write
> an output.
>
> **Chaining — outputs accumulate, they don't replace.** Each call to
> `.onTrigger()` builds a *new* callback that first invokes whatever trigger was
> already on the hap, then runs the new one. So triggers form a chain in
> attachment order:
>
> ```js
> s("bd").log().midi("port")   // logs AND sends MIDI — both fire, log first
> ```
>
> This is the same accumulation philosophy as control merging (§3): adding an
> output never clobbers a previously-added one. (Note the contrast with
> `@strudel/mqtt` in §5.6, which sets the context *manually* and therefore does
> **not** chain — a real behavioural difference to be aware of when mixing it with
> other outputs.)
>
> **`dominantTrigger` — who owns the sound.** By default Strudel plays every event
> through WebAudio. An output like MIDI or OSC usually does *not* want that — the
> sound is coming from the synth on the other end, so a doubled WebAudio voice
> would be wrong. Setting `dominant = true` raises a flag that `getTrigger`
> (repl.mjs:563) reads to **skip** `defaultOutput`:
>
> ```js
> if (!hap.context.onTrigger || !hap.context.dominantTrigger) {
>   await defaultOutput(hap, ...);   // WebAudio only when nothing dominant claimed the hap
> }
> ```
>
> The flag is **sticky / monotonic**: once any trigger in the chain sets it true
> it stays true (`hap.context.dominantTrigger || dominant`, pattern.mjs:887) — you
> cannot un-suppress audio later in the chain. Practical guidance for your own
> output:
>
> - **Replaces the sound** (MIDI, OSC, serial, DMX, your laser in §7) → leave
>   `dominant` at its default `true`.
> - **Observes / augments** the sound (logging, visuals, analytics, lighting that
>   should accompany audio) → pass `dominant = false`, exactly as `.log()` does
>   (pattern.mjs:903), so WebAudio still plays.

### 5.2 The scheduler (cyclist) queries and fires

Each clock tick the cyclist queries the active pattern and, for every hap with an
onset, computes wall-clock timing and calls the scheduler's trigger:

```js
// packages/core/cyclist.mjs:60
const haps = this.pattern.queryArc(begin, end, { _cps: this.cps, cyclist: 'cyclist' });
haps.forEach((hap) => {
  if (hap.hasOnset()) {
    const targetTime = (hap.whole.begin - this.num_cycles_at_cps_change) / this.cps
                       + this.seconds_at_cps_change + latency;
    const duration = hap.duration / this.cps;
    const deadline = targetTime - phase;
    onTrigger?.(hap, deadline, duration, this.cps, targetTime);  // note this signature
  }
});
```

### 5.3 `getTrigger`: default audio + the hap's own trigger

The cyclist's `onTrigger` is produced by `getTrigger` and wired into the REPL:

```js
// packages/core/repl.mjs:563
export const getTrigger =
  ({ getTime, defaultOutput }) =>
  async (hap, deadline, duration, cps, t) => {
    try {
      if (!hap.context.onTrigger || !hap.context.dominantTrigger) {
        await defaultOutput(hap, deadline, duration, cps, t);   // WebAudio, unless dominant
      }
      if (hap.context.onTrigger) {
        // signature is CONVERTED here for output packages:
        await hap.context.onTrigger(hap, getTime(), cps, t);
      }
    } catch (err) { errorLogger(err, 'getTrigger'); }
  };
```

So a hap's `onTrigger` is invoked with `(hap, currentTime, cps, targetTime)` —
exactly the signature every output package's trigger callback expects.
`defaultOutput` in the browser is `webaudioOutput` (webaudio.mjs:110).

### 5.4 MIDI

The control params (`.ccn()`, `.ccv()`, `.midichan()`, `.progNum()`, …) are **core
controls**, registered in `controls.mjs`, not in the midi package — they merely
write keys into the hap value:

```js
// packages/core/controls.mjs
export const { midichan } = registerControl('midichan');  // :2814
export const { ccn }      = registerControl('ccn');        // :2863
export const { ccv }      = registerControl('ccv');        // :2871
export const { progNum }  = registerControl('progNum');    // :2903
```

`.midi()` itself is assigned **directly on the prototype** (it needs custom
handling of the port name/options), and returns `this.onTrigger(...)`:

```js
// packages/midi/midi.mjs:294
Pattern.prototype.midi = function (midiport, options = {}) {
  if (isPattern(midiport)) throw new Error('.midi does not accept Pattern input for midiport ...');
  // ... build midiConfig, enableWebMidi(...) ...
  return this.onTrigger((hap, _currentTime, cps, targetTime) => {   // :340
    if (!WebMidi.enabled) { logger('Midi not enabled'); return; }
    hap.ensureObjectValue();
    let { note, ccn, ccv, midichan = midiConfig.midichannel, progNum, /* ... */ } = hap.value;
    const device = getDevice(midiport, WebMidi.outputs);
    if (note !== undefined && !midiConfig.isController) {
      const duration = (hap.duration.valueOf() / cps) * 1000 - midiConfig.noteOffsetMs;
      sendNote(note, velocity, duration, device, midichan, targetTime);
    }
    // progNum -> sendProgramChange, ccn/ccv -> sendCC, midibend -> sendPitchBend, ...
  });
};
```

The low-level senders schedule the actual WebMIDI call at `targetTime` using
superdough's sample-accurate `scheduleAtTime`:

```js
// packages/midi/midi.mjs:265
function sendNote(note, velocity, duration, device, midichan, targetTime) {
  const midiNumber = typeof note === 'number' ? note : noteToMidi(note);
  const midiNote = new Note(midiNumber, { attack: velocity, duration });
  scheduleAtTime(() => device.playNote(midiNote, midichan), targetTime);
}
```

MIDI input is the reverse direction: `midin(input)` exposes `createCC`, which
returns a **reactive ref** (`ref(() => lookupMap[cc])`) so `cc(0).range(...)`
re-reads the latest received CC value (midi/input.mjs). `midikeys(input)` enqueues
incoming note-on events as haps.

### 5.5 OSC — the idiomatic `register()` + a WebSocket bridge

OSC is the textbook example of using `register()`:

```js
// packages/osc/osc.mjs:86
export const osc = register('osc', (pat) => pat.onTrigger(oscTrigger));
```

Browsers can't send UDP, so OSC sends a JSON envelope over a WebSocket to a small
Node bridge:

```js
// packages/osc/osc.mjs:13
const ws = new WebSocket('ws://localhost:8080');     // memoized in connect()
// packages/osc/osc.mjs:60
export async function oscTrigger(hap, currentTime, cps = 1, targetTime) {
  const ws = await connect();
  const controls = parseControlsFromHap(hap, cps);   // flatten value, note->midinote, +cps/cycle/delta
  const keyvals = Object.entries(controls).flat();
  const ts = collator.calculateTimestamp(currentTime, targetTime) * 1000;
  const msg = { address: '/dirt/play', args: keyvals, timestamp: ts };
  ws.send(JSON.stringify(msg));
}
```

The Node server translates WebSocket-in to OSC/UDP-out:

```js
// packages/osc/server.js
const wss = new WebSocketServer({ port: 8080 });
wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    const data = JSON.parse(message);
    let msg = { address: data.address, args: data.args };
    if ('timestamp' in data) msg = { timeTag: osc.timeTag(0, data.timestamp), packets: [msg] };
    udpPort.send(msg, osc_host, osc_port);          // -> 127.0.0.1:57120 (SuperDirt)
  });
});
```

### 5.6 MQTT — WebSocket via Paho, manual context

MQTT assigns the method directly and sets the trigger context *manually* (it does
not use `.onTrigger()`, so it does not chain prior triggers):

```js
// packages/mqtt/mqtt.mjs:31
Pattern.prototype.mqtt = function (username, password, topic, host = 'wss://localhost:8883/', /* ... */) {
  // ... connect a memoized Paho client over the WebSocket host ...
  return this.withHap((hap) => {
    const onTrigger = (hap, currentTime, cps, targetTime) => {
      if (!cx || !cx.isConnected()) return;
      const message = new Paho.Message(JSON.stringify(hap.value));
      message.destinationName = msg_topic;
      const offset = (targetTime - currentTime + latency) * 1000;
      window.setTimeout(() => cx.send(message), offset);
    };
    return hap.setContext({ ...hap.context, onTrigger, dominantTrigger: true });
  });
};
```

### 5.7 Comparison

| Aspect | MIDI | OSC | MQTT |
|---|---|---|---|
| Method registration | `Pattern.prototype.midi = ...` (direct) | `register('osc', pat => pat.onTrigger(...))` | `Pattern.prototype.mqtt = ...` (direct) |
| Trigger attachment | `this.onTrigger(fn)` | `pat.onTrigger(oscTrigger)` | manual `hap.setContext({ onTrigger, dominantTrigger:true })` |
| Transport | WebMIDI | WebSocket → Node `server.js` → UDP/OSC | Paho MQTT over WebSocket |
| Timing | `scheduleAtTime` (AudioContext clock) | `ClockCollator` + OSC timeTag | `window.setTimeout` |
| Control params | core `registerControl` (`ccn`, `ccv`, …) | core controls + computed `midinote` | arbitrary `hap.value` keys → JSON |
| Suppresses default audio | yes | yes | yes |

The unifying mechanism for all three is `getTrigger` (repl.mjs:563), invoked by
the cyclist (cyclist.mjs:71): it conditionally runs `defaultOutput` and then the
hap's `onTrigger`, whatever the output package attached.

---

## 6. Recipes: registering your own functions and modules

### 6.1 A new pure pattern method (one line)

```js
import { register } from '@strudel/core';

// adds .vlpf() to every Pattern AND a standalone vlpf(...)
export const vlpf = register('vlpf', (freq, pat) =>
  pat.fmap((v) => ({ ...v, cutoff: freq * (v.velocity ?? 1) })),
);

// usage in the REPL:
// s("saw").seg(8).velocity(rand).vlpf(800)
```

Because the last parameter is the pattern, `register` exposes `vlpf` both as
`pat.vlpf(800)` and as `vlpf(800, pat)`. The leading `freq` arg is patternified
automatically, so `vlpf("<400 800>")` also works.

### 6.2 A new control (param) that adds a value key

```js
import { registerControl } from '@strudel/core';

// single key
export const { wobble } = registerControl('wobble');
// wobble(0.5)  =>  haps with value { wobble: 0.5 }

// multi-key with alias: foo("a:b") => { foo:'a', bar:'b' }; baz is an alias of foo
export const { foo } = registerControl(['foo', 'bar'], 'baz');
```

### 6.3 A new MIDI method

Two ways, depending on whether you need custom argument handling.

**(a) As a pure control** — if you just need a new value key that an existing
`.midi()` trigger already understands, register it as a control in the spirit of
`controls.mjs` (e.g. a new CC alias). Nothing else is required: `.midi()` already
destructures known keys from `hap.value`.

**(b) As a new trigger method** — if you need to emit a *new kind* of message,
follow the `.midi()` shape: assign a prototype method that opens/looks up a device
and returns `this.onTrigger(...)`:

```js
import { Pattern } from '@strudel/core';
import { WebMidi } from 'webmidi';
import { scheduleAtTime } from 'superdough';

Pattern.prototype.midipanic = function (midiport) {
  return this.onTrigger((hap, _currentTime, _cps, targetTime) => {
    if (!WebMidi.enabled) return;
    const device = WebMidi.outputs.find((o) => o.name === midiport) ?? WebMidi.outputs[0];
    scheduleAtTime(() => device.sendAllNotesOff(), targetTime);
  });
};
// usage: s("bd").midipanic("IAC Driver")
```

Key points: the trigger signature is `(hap, currentTime, cps, targetTime)` (already
converted by `getTrigger`); schedule the real I/O at `targetTime` via
`scheduleAtTime` for sample-accurate timing; return `this.onTrigger(...)` so the
default audio is suppressed and the callback is wired into playback.

### 6.4 A brand-new output module

Mirror the structure of `packages/osc`:

```js
// packages/myout/myout.mjs
import { register, logger } from '@strudel/core';

let connection;
function connect() {
  if (!connection) {
    connection = new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://localhost:9000');
      ws.addEventListener('open', () => { logger('[myout] connected'); resolve(ws); });
      ws.addEventListener('error', reject);
    });
  }
  return connection;
}

async function myTrigger(hap, currentTime, cps, targetTime) {
  const ws = await connect();
  ws.send(JSON.stringify({ value: hap.value, targetTime, cps }));
}

// chainable .myout() + standalone myout(pat)
export const myout = register('myout', (pat) => pat.onTrigger(myTrigger));
```

```js
// packages/myout/index.mjs — re-export so evalScope can bulk-import
import './myout.mjs';
export * from './myout.mjs';
```

Load it into the REPL scope alongside the other packages:

```js
import { evalScope } from '@strudel/core';
await evalScope(
  import('@strudel/core'),
  import('@strudel/mini'),
  import('@strudel/myout'),   // <-- your module's exports land in strudelScope + globalThis
);
// now: s("bd sd").myout()
```

That is the entire contract for an output module:

1. `import { register, Pattern } from '@strudel/core'`.
2. Write a trigger `(hap, currentTime, cps, targetTime) => {…}` that reads
   `hap.value`/`hap.duration` and emits to your transport.
3. Expose a chainable method that returns `pat.onTrigger(trigger)` — via
   `register()` (recommended) or a direct `Pattern.prototype.x` assignment when you
   need custom argument parsing.
4. Re-export from `index.mjs` and load with `evalScope()`.
5. The cyclist + `getTrigger` will invoke your trigger automatically during
   playback.

---

## 7. Two end-to-end examples

The recipes above show the API in isolation. This section walks two complete,
runnable scenarios from first principles:

- **Example A** — extend Strudel **temporarily, inside the REPL**, with no build
  step and no install. Great for prototyping and sharing a one-off snippet.
- **Example B** — build a **standalone npm package** that ships new functions, a
  new control, and a new `onTrigger` output, published to a remote git repo /
  npm and loaded into any Strudel REPL without being bundled into Strudel itself.

### Why both work: the scope mechanism

Both examples rely on one fact established earlier: **user code in the REPL runs
inside a plain `Function` body, not an ES module** (`safeEval`, evaluate.mjs:57).
That body closes over `globalThis`, and at REPL startup `evalScope(import('@strudel/core'), …)`
copies every `@strudel/core` export — including `register`, `registerControl`,
`Pattern`, `evalScope` itself, `reify`, `noteToMidi`, … — onto `globalThis`
(evaluate.mjs:48). So in the editor you can call `register(...)` directly, and
because it is a non-module function body you can also use **dynamic** `import()`
and **top-level `await`** (the transpiler parses with `allowAwaitOutsideFunction`
and does not touch import expressions). Static `import … from …` statements are
*not* allowed — they are illegal outside a real module.

---

### Example A — Extend Strudel temporarily inside the REPL

Goal: add three things live in the editor —

1. a pure pattern method `.crush2()` (alias of bit-crush expressed via existing controls),
2. a new control `wobble`,
3. a custom `onTrigger` output `.blink()` that flashes `console`/DOM on each event.

Paste this at the **top** of your REPL buffer, above the pattern you want to play:

```js
// ---- 1. a pure pattern method --------------------------------------------
// register() installs both Pattern.prototype.crush2 and a standalone crush2().
// The last parameter is always the current pattern.
register('crush2', (amount, pat) =>
  pat.fmap((v) => ({ ...v, crush: 16 - 15 * amount })) // map 0..1 -> 16..1 bits
);

// ---- 2. a new control ------------------------------------------------------
// registerControl adds Pattern.prototype.wobble + a standalone wobble().
// wobble(0.5) produces haps whose value is { wobble: 0.5 }.
registerControl('wobble');

// ---- 3. a custom onTrigger output -----------------------------------------
// onTrigger attaches a callback to every hap's context. dominant=false here so
// the default WebAudio output is NOT suppressed — .blink() rides alongside sound.
register('blink', (pat) =>
  pat.onTrigger((hap, currentTime, cps, targetTime) => {
    // signature is already converted by getTrigger: (hap, currentTime, cps, targetTime)
    document.body.style.background = '#fff';
    setTimeout(() => (document.body.style.background = ''), 60);
    console.log('blink', hap.value);
  }, /* dominant = */ false)
);

// ---- use them --------------------------------------------------------------
note("c3 e3 g3 b3")
  .s("sawtooth")
  .crush2("<0.2 0.8>")   // patternified arg works automatically
  .wobble(sine.slow(4))  // a signal as a control value
  .blink()
```

What happens when you hit *play*:

- `register`/`registerControl` mutate `Pattern.prototype` and `strudelScope`
  immediately, so the methods exist for the rest of the session (until reload).
- `crush2` and `wobble` merge keys into each hap's value object exactly like the
  built-in controls (section 3.3). `crush` is a real superdough control, so you
  hear the effect; `wobble` is inert audio-wise here but is now a first-class
  control you could read in your own output.
- `blink()` attaches a non-dominant trigger; the cyclist + `getTrigger`
  (sections 5.2–5.3) call it on every onset *in addition to* the audio.

#### A.1 Loading a remote extension live (no install)

Because dynamic `import()` works in the editor, you can pull a published
extension straight from a CDN and inject its exports in one line:

```js
// load a remote ESM build and merge its exports into globalThis + strudelScope
await evalScope(import('https://esm.sh/@yourname/strudel-blink'));

s("bd sd").blink()   // method provided by the remote package
```

This is the same runtime mechanism Strudel itself uses to pull `hydra-synth` from
a CDN (`await import('https://unpkg.com/hydra-synth')`, hydra/hydra.mjs:16-29).
`evalScope` (evaluate.mjs:37) awaits the module and copies its exports onto
`globalThis`/`strudelScope`, and any `register`/`Pattern.prototype` side effects
in that module run on import.

> **Limits of the REPL approach:** definitions live only until reload, there is
> no module resolution for bare specifiers (`import('@strudel/core')` only works
> because the host pre-bundled it — use a full URL for third-party code), and you
> cannot use static `import` statements. For anything reusable, build a package
> (Example B).

---

### Example B — A standalone, remotely-installable package

Goal: ship a real package, `@yourname/strudel-laser`, that provides:

- a new control `beam`,
- a pure pattern function `.strobe(n)`,
- a custom `onTrigger` output `.laser(host)` that sends each event to a hardware
  bridge over a WebSocket (the same shape as `@strudel/osc`).

It depends on `@strudel/core` but is **not** part of the Strudel monorepo, builds
to a single ESM file, and is loadable via `evalScope(import('@yourname/strudel-laser'))`
or remotely via a CDN URL.

#### B.1 Project layout

```
strudel-laser/
├── package.json
├── vite.config.js
├── index.mjs          # barrel: import for side effects + re-export
└── laser.mjs          # implementation
```

#### B.2 `package.json`

Mirror the Strudel package template (midi/osc/gamepad all share it). The two
non-obvious choices, copied from those packages:

- `publishConfig.main` repoints `main` to the built `dist/index.mjs` only when
  published, so the source entry is used in dev and the bundle in production.
- `@strudel/core` is a normal dependency (the Strudel packages use
  `workspace:*`; outside the monorepo pin a real range). It is marked *external*
  at build time (B.4) so it is never bundled — the host REPL provides the one
  true copy (core warns if loaded twice, core/index.mjs:34).

```json
{
  "name": "@yourname/strudel-laser",
  "version": "0.1.0",
  "description": "Laser/WebSocket output + extra controls for Strudel",
  "type": "module",
  "main": "index.mjs",
  "publishConfig": { "main": "dist/index.mjs" },
  "scripts": {
    "build": "vite build",
    "prepublishOnly": "npm run build"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/yourname/strudel-laser.git"
  },
  "dependencies": {
    "@strudel/core": "^1.0.0"
  },
  "devDependencies": {
    "vite": "^6.0.11"
  },
  "engines": { "node": ">=18.0.0" }
}
```

#### B.3 `index.mjs` — the barrel

Importing the implementation for its **side effects** is what installs the
`Pattern.prototype` methods and registered controls; the re-export makes the
named functions available to `evalScope`.

```js
import './laser.mjs';
export * from './laser.mjs';
```

#### B.4 `vite.config.js` — build a single ESM file, keep core external

```js
import { defineConfig } from 'vite';
import { resolve } from 'path';
import { dependencies } from './package.json' assert { type: 'json' };

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'index.mjs'),
      formats: ['es'],
      fileName: () => 'index.mjs',
    },
    rollupOptions: {
      // do NOT bundle @strudel/core (or any dep) into the package
      external: [...Object.keys(dependencies)],
    },
    target: 'esnext',
  },
});
```

This produces `dist/index.mjs` with `@strudel/core` left as an external import —
exactly how `@strudel/gamepad` builds (gamepad/vite.config.js).

#### B.5 `laser.mjs` — the implementation

```js
import { Pattern, isPattern, register, registerControl, logger, noteToMidi } from '@strudel/core';

// --- 1. a new control: beam("a:b") -> { beam:'a', focus:b } -----------------
// Multi-key control: an array of names spreads a colon-tuple across keys,
// just like s("bd:3") -> { s:'bd', n:3 }. 'laserbeam' is an alias.
export const { beam } = registerControl(['beam', 'focus'], 'laserbeam');

// --- 2. a pure pattern function: .strobe(n) ---------------------------------
// Retriggers each event n times (like a strobe), tagging it with strobe:n.
// Built on the core `ply` primitive. Pure: it only transforms structure, so it
// stays referentially transparent. `n` is patternified for free by register.
export const strobe = register('strobe', (n, pat) =>
  pat.ply(n).fmap((v) => ({ ...v, strobe: n })),
);

// --- 3. a WebSocket output: .laser(host) ------------------------------------
// Same architecture as @strudel/osc: a memoized WebSocket connection + an
// onTrigger that serializes each hap and sends it.
const connections = {};
function connect(host) {
  if (!connections[host]) {
    connections[host] = new Promise((resolve, reject) => {
      const ws = new WebSocket(host);
      ws.addEventListener('open', () => {
        logger(`[laser] connected to ${host}`);
        resolve(ws);
      });
      ws.addEventListener('close', () => {
        delete connections[host]; // allow reconnect next trigger
      });
      ws.addEventListener('error', reject);
    }).catch((err) => {
      delete connections[host];
      throw new Error(`[laser] could not connect to ${host}: ${err}`);
    });
  }
  return connections[host];
}

// .laser(host) is assigned DIRECTLY on the prototype (exactly like .midi(port)),
// NOT via register() — see the note below on why config args must bypass register.
// onTrigger(fn) defaults dominant=true -> default WebAudio is suppressed.
Pattern.prototype.laser = function (host = 'ws://localhost:9000') {
  if (isPattern(host)) {
    throw new Error('.laser() does not accept a pattern as host - pass a plain ws:// URL string');
  }
  return this.onTrigger(async (hap, currentTime, cps, targetTime) => {
    const ws = await connect(host);
    if (ws.readyState !== WebSocket.OPEN) return;
    hap.ensureObjectValue();
    const { note, beam = 0, focus = 1, ...rest } = hap.value;
    const msg = {
      midinote: note != null ? (typeof note === 'number' ? note : noteToMidi(note)) : undefined,
      beam,
      focus,
      durationSec: hap.duration.valueOf() / cps,
      targetTime, // wall-clock target so the bridge can schedule precisely
      cps,
      ...rest,
    };
    ws.send(JSON.stringify(msg));
  });
};
```

Notes on the choices, tied back to the architecture:

- **Why `.laser()` is a direct prototype assignment, not `register('laser', …)`.**
  `register` always `reify`s a method's arguments (pattern.mjs:1813) — even with
  `patternify = false`. A connection URL like `ws://localhost:9000` is *not* valid
  mini-notation, so `reify` would try to parse it and throw on the `/` and `:`.
  Config-style arguments (URLs, ports, option objects) must therefore bypass
  `register` and be handled by hand — which is exactly why the real `.midi(port)`
  (midi.mjs:294) and `.mqtt(...)` (mqtt.mjs:31) are assigned directly too. Keep
  `register()` for arguments that are genuinely meant to be *patterns*.

  > #### 🔎 Deep dive: the "patternify reifies my config string" trap
  >
  > This is the single most common surprise when writing an output. The instinct
  > is to reach for `register('laser', (host, pat) => …)` for consistency. But the
  > chainable wrapper `register` installs runs `args.map(reify)` on every method
  > argument (pattern.mjs:1813), and `reify` (pattern.mjs:1409) sends any string
  > through the mini-notation parser. `"bd sd"` parses fine; `"ws://host:9000"`
  > does not. There is **no flag** to disable this — `patternify: false` still
  > reifies (it only changes how the args are *combined*, not whether they are
  > coerced to patterns). The rule of thumb:
  >
  > | Argument is… | Use |
  > |---|---|
  > | a value/rhythm the user might want to pattern (`gain`, `fast`, `strobe`'s `n`) | `register()` |
  > | a connection target or option (URL, port, device name, `{}` config) | direct `Pattern.prototype.x = function(cfg){ … return this.onTrigger(fn) }` |
  >
  > It also means `.laser()` has **no curried standalone form** (`laser(host)`),
  > because the standalone form is something only `register` produces. For an
  > output that is exactly right — you always call it as a method on a pattern.

- `pat.onTrigger(fn)` (pattern.mjs:875) attaches the callback and the
  `dominantTrigger` flag; the cyclist (cyclist.mjs:60) and `getTrigger`
  (repl.mjs:563) invoke `fn` with the converted `(hap, currentTime, cps, targetTime)`
  signature on every onset.
- `hap.ensureObjectValue()` guarantees `hap.value` is an object before
  destructuring controls, exactly as `@strudel/midi` does (midi.mjs:345).
- Like `@strudel/osc`, the browser cannot send raw UDP/serial — a tiny Node
  bridge would accept these WebSocket JSON frames and drive the actual hardware,
  scheduling on `targetTime` (see osc/server.js for the pattern).

#### B.6 Build and publish

```bash
npm install
npm run build          # -> dist/index.mjs (core left external)
npm publish --access public          # to npm
# or just push to git; the repo is installable directly:
#   npm install yourname/strudel-laser            (github shorthand)
#   npm install git+https://github.com/yourname/strudel-laser.git
```

#### B.7 Use it

In a Node/bundler-based Strudel app, register the package into the REPL scope
alongside the core modules — the same way the website does in
`website/src/repl/util.mjs` (`evalScope(import('@strudel/core'), …)`):

```js
import { evalScope } from '@strudel/core';

await evalScope(
  import('@strudel/core'),
  import('@strudel/mini'),
  import('@strudel/webaudio'),
  import('@yourname/strudel-laser'), // your package's exports + side effects
);

// now available everywhere:
note("c3 e3 g3").beam("red:0.8").strobe(4).laser("ws://localhost:9000")
```

Or, with **zero install**, load the published package straight from a CDN inside
the REPL editor (combining Example A.1 with this package):

```js
await evalScope(import('https://esm.sh/@yourname/strudel-laser'));

s("bd*4").beam("green").laser("ws://localhost:9000")
```

Because the package marked `@strudel/core` as external, esm.sh resolves it to the
same core the REPL already loaded — no duplicate-core warning, and your
`Pattern.prototype` additions land on the one shared `Pattern` class.

---

## 8. Quick reference

| Concept | Where | Note |
|---|---|---|
| `Pattern` constructor | pattern.mjs:52 | `query: State → Hap[]` |
| `State` | state.mjs:7 | immutable span + query-time controls |
| `Hap` | hap.mjs:25 | `whole` / `part` / `value` / `context` / `stateful` |
| `queryArc` | pattern.mjs:420 | builds a `State`, runs the query |
| `pure` | pattern.mjs:1384 | one hap per cycle; `__pure` fast-path marker |
| **`register`** | pattern.mjs:1743 | function → chainable method + curried standalone |
| chainable install | pattern.mjs:1805 | `Pattern.prototype[name] = …` |
| `_`-prefixed raw method | pattern.mjs:1820 | skips arg patternification |
| `stepRegister` | pattern.mjs:1837 | `register` with `stepJoin` |
| `strudelScope` | evaluate.mjs:7 | global name registry for the evaluator |
| `evalScope` | evaluate.mjs:37 | bulk-import a module's exports |
| `createParam` | controls.mjs:10 | builds a control's value-merger |
| `registerControl` | controls.mjs:63 | control + aliases; updates `controlAlias` |
| `registerMultiControl` | controls.mjs:76 | numbered families (`fm1`…`fm8`) |
| `set` composer / `unionWithObj` | pattern.mjs:1083 / value.mjs:10 | how chained controls merge |
| `signal` | signal.mjs:17 | time-as-input, pure |
| `rand` / `withSeed` | signal.mjs:480 / 445 | deterministic random via `randSeed` |
| impure signals | signal.mjs:191, 988 | mouse/keyboard read globals |
| `onTrigger` | pattern.mjs:875 | attaches trigger + `dominantTrigger` to haps |
| cyclist trigger loop | cyclist.mjs:60 | queries + fires per onset |
| `getTrigger` | repl.mjs:563 | default audio + hap `onTrigger`, converts signature |
| `.midi()` | midi/midi.mjs:294 | direct prototype assignment + `onTrigger` |
| `.osc()` | osc/osc.mjs:86 | `register` + WebSocket → Node `server.js` → UDP |
| `.mqtt()` | mqtt/mqtt.mjs:31 | direct assignment + manual context, Paho/WebSocket |
