# The Strudel Clock & Timing Model

> How Strudel turns a lazy, timeless *pattern* into sound, MIDI, OSC and WebSocket
> messages that land **on the beat** — and why that requires looking into the
> future.
>
> This document is a deep, code-anchored tour of the scheduling subsystem in
> `packages/core` (`zyklus.mjs`, `cyclist.mjs`, `neocyclist.mjs`, `clockworker.js`)
> and how it connects to the audio engine (`packages/superdough`,
> `packages/webaudio`) and to the I/O packages (`packages/midi`, `packages/osc`).
> Every claim carries a `file:line` anchor so you can read the source alongside.
>
> If you have not yet read [`extending-strudel.md`](./extending-strudel.md), the
> short version of the model you need is: a `Pattern` is a pure function
> `query: State → Hap[]` (`packages/core/pattern.mjs:52`). Nothing happens until
> something *queries* it for a time span. The clock is the thing that queries it,
> over and over, slightly ahead of time.

---

## Table of contents

1. [Why timing is hard in a browser](#1-why-timing-is-hard-in-a-browser)
2. [The three clocks and the cycle timeline](#2-the-three-clocks-and-the-cycle-timeline)
3. [The lookahead principle](#3-the-lookahead-principle)
4. [`zyklus` — the low-level lookahead clock](#4-zyklus--the-low-level-lookahead-clock)
5. [`cyclist` — the event scheduler](#5-cyclist--the-event-scheduler)
6. [All the time windows in one picture](#6-all-the-time-windows-in-one-picture)
7. [`neocyclist` + `clockworker` — multi-instance sync](#7-neocyclist--clockworker--multi-instance-sync)
8. [From scheduler to output: the trigger pipeline](#8-from-scheduler-to-output-the-trigger-pipeline)
9. [A full numeric walkthrough](#9-a-full-numeric-walkthrough)
10. [Tuning, gotchas, and failure modes](#10-tuning-gotchas-and-failure-modes)
11. [Quick reference](#11-quick-reference)

---

## 1. Why timing is hard in a browser

Strudel is a *live* instrument: when you hit a downbeat, the kick must come out of
your speakers at exactly that moment, every cycle, with no audible jitter. The
problem is that the only general-purpose timer the browser gives JavaScript —
`setInterval` / `setTimeout` — is run on the main thread and is **not** accurate
enough for music. It can fire late by tens of milliseconds whenever the page
does layout, garbage collection, or any other work. A drum machine that fired
its samples directly from a `setInterval` callback would wobble noticeably.

There is, however, a clock that *is* sample-accurate: the **Web Audio clock**,
`AudioContext.currentTime`. The Web Audio API lets you say "play this sound at
**exactly** time `t`" and the audio thread honours it down to the sample. The
catch is that `t` must be in the *future* — you cannot schedule a sound for
"right now" and expect it to be on time, because the audio thread processes in
blocks.

Strudel's whole timing strategy follows from these two facts:

- **Use the inaccurate timer only to wake up periodically** ("am I due to do
  some work?").
- **Use the accurate audio clock to actually place every event**, always a
  little bit in the future.

This is the standard "[A Tale of Two Clocks](https://web.dev/articles/audio-scheduling)"
lookahead pattern, and `zyklus.mjs` is Strudel's implementation of it.

---

## 2. The three clocks and the cycle timeline

It helps to be ruthless about which "time" we are talking about at any moment.
There are **three distinct time bases** in play:

| Clock | Unit | Source | Role |
|---|---|---|---|
| **Wall / interval clock** | seconds | `setInterval` on the main thread | the *heartbeat* — wakes the scheduler up roughly every `interval` seconds |
| **Audio clock** | seconds | `AudioContext.currentTime` (`packages/webaudio/webaudio.mjs:109`, `packages/repl/repl-component.mjs:41`) | the *authoritative* time base; every event's onset is expressed in these seconds |
| **Cycle timeline** | cycles | derived: `cycles = seconds × cps` | the *musical* time the pattern is written in |

The audio clock is the one that matters. The interval clock only decides *when
we get a chance to schedule*; it never decides *when a sound plays*.

### Cycles, cps, and the pattern timeline

A Strudel pattern lives on an abstract, dimensionless **cycle timeline**. The
mini-notation `"a b c d"` puts four events in cycle 0 (at 0, ¼, ½, ¾), four more
in cycle 1, and so on, forever. The pattern does not know about seconds at all —
querying `pattern.queryArc(0, 1, …)` (`packages/core/pattern.mjs:420`) returns
the `Hap`s whose onsets fall in `[0, 1)`.

The bridge between the cycle timeline and seconds is **cps** — *cycles per
second* (default `0.5`, i.e. one cycle every two seconds; see
`packages/core/cyclist.mjs:24`). The conversion is the single most important
equation in the whole subsystem and it is exactly this trivial
(`packages/core/util.mjs:377`):

```js
export function cycleToSeconds(cycle, cps) {
  return cycle / cps;          // seconds = cycles / cps
}
```

```
cycle timeline (what the pattern is written in)
  0        0.25      0.5       0.75      1.0       1.25  ...
  |─────────|─────────|─────────|─────────|─────────|──
  a         b         c         d         a         b
  │
  │  × (1 / cps)            cps = 0.5  ⇒  one cycle = 2 seconds
  ▼
audio-clock seconds (what gets scheduled)
  0s        0.5s      1.0s      1.5s      2.0s      2.5s ...
```

> #### 🔎 Deep dive — why "cps" and not "bpm"?
> Strudel measures musical time in **cycles**, not beats, because a pattern's
> internal subdivision is arbitrary and nested. `"a b c d"` and `"a b"` are both
> one cycle long; the first just happens to subdivide it into four. There is no
> privileged "beat". `cps` therefore measures how fast the *whole repeating
> structure* scrolls past, independent of how finely any given pattern carves it
> up. Tools that think in BPM convert at the edge — e.g. `setCpm(cpm)` divides by
> 60 and by the steps-per-cycle (`packages/core/repl.mjs:302,388`). Internally,
> everything is cycles and `cps`.

---

## 3. The lookahead principle

Here is the core idea in one sentence:

> **At every heartbeat, ask the pattern "what happens in the slice of cycle time
> that corresponds to the next little window of seconds?", and schedule all of
> those events on the audio clock — which, because we asked early, are all still
> in the future.**

Concretely, suppose the heartbeat fires every `0.1 s` and we always look
`~0.2 s` ahead. At audio-time `t = 5.00 s` we schedule everything up to
`5.20 s`. The audio thread then plays those events precisely. At `t ≈ 5.10 s`
the next heartbeat fires and schedules `5.20 → 5.30 s`, and so on. Each event is
handed to Web Audio well before it must sound, so a late heartbeat (say the
callback that *should* have fired at `5.10` actually fires at `5.13`) does not
cause a late *sound* — there is slack absorbing the jitter.

```
        heartbeat N                         heartbeat N+1
        fires at t≈5.00                     fires at t≈5.10
            │                                   │
   audio    ▼                                   ▼
   time  ───●───────────────────────────────────●──────────────▶
            5.00            5.10             5.20            5.30
            └──── already scheduled ─────────┘
            └──────── lookahead window ───────┘
                 events here are placed NOW,
                 to play THEN (all in the future)
```

The two knobs that govern this are **how far ahead we look** (bigger = more
robust against jitter, but more latency before a code change is heard) and **how
much fixed offset we add to every event** (`latency`, see §5). Everything below
is the precise machinery that implements this picture.

---

## 4. `zyklus` — the low-level lookahead clock

`packages/core/zyklus.mjs` is a tiny, self-contained, framework-agnostic clock
(it is destined to become its own library, see the comment at `zyklus.mjs:1`).
It knows nothing about patterns, cycles, or audio — it just calls a callback
repeatedly, slightly ahead of a moving **phase**.

### 4.1 The signature and its parameters

```js
function createClock(
  getTime,                       // () => seconds  (the audio clock)
  callback,                      // called slightly before each "cycle" tick
  duration = 0.05,               // seconds of clock-time advanced per callback
  interval = 0.1,                // setInterval period (the heartbeat), in seconds
  overlap = 0.1,                 // extra seconds added to each lookahead window
  setInterval = globalThis.setInterval,
  clearInterval = globalThis.clearInterval,
  round = true,
)                                                  // packages/core/zyklus.mjs:4
```

Two internal counters do all the work (`zyklus.mjs:14-17`):

- `tick` — counts how many callbacks have happened (a monotonically increasing
  integer).
- `phase` — the **next** clock-time, in seconds, that the callback will be
  invoked *for*. This is the leading edge of scheduling; it runs ahead of real
  time.
- `precision = 10**4` — `phase` is rounded to 4 decimals (0.1 ms) when `round`
  is on, to avoid floating-point drift accumulating in the running sum.
- `minLatency = 0.01` — a 10 ms cushion applied at the very first tick so we
  never try to schedule something for *exactly* now.

> #### 🔎 Deep dive — "duration" is not "interval", and that's the point
> It is easy to conflate the two. `interval` is the **real-world heartbeat**: how
> often `setInterval` wakes us up (every 0.1 s). `duration` is how much
> **clock-time the callback represents** each time it is called (0.05 s). They
> are deliberately *different*. Because `duration (0.05) < interval (0.1)`, each
> real wake-up usually advances `phase` by *two* callbacks (0.05 + 0.05 = 0.1) to
> keep up. The `while` loop below is what lets a single heartbeat emit several
> callbacks, so the clock-time `phase` keeps pace with — and stays ahead of —
> real time even though the heartbeat is coarse. When `cyclist` builds its clock
> it passes its own `interval` value as `duration` (`cyclist.mjs:83`), so in
> practice Strudel's tick granularity equals its scheduler interval; the
> distinction still matters for understanding the loop.

### 4.2 The heart: `onTick`

This is the entire scheduling engine, reproduced verbatim
(`packages/core/zyklus.mjs:20-33`):

```js
const onTick = () => {
  const t = getTime();                         // (1) where is the audio clock NOW?
  const lookahead = t + interval + overlap;    // (2) schedule everything up to here
  if (phase === 0) {
    phase = t + minLatency;                    // (3) first ever tick: start just ahead of now
  }
  // callback as long as we're inside the lookahead
  while (phase < lookahead) {                  // (4) emit ticks until we've filled the window
    phase = round ? Math.round(phase * precision) / precision : phase;
    callback(phase, duration, tick, t);        // (5) "something happens at clock-time `phase`"
    phase += duration;                         // (6) advance the leading edge
    tick++;
  }
};
```

Walk through it:

1. **`t = getTime()`** — sample the *real* (audio) clock. Everything else is
   measured relative to this.
2. **`lookahead = t + interval + overlap`** (`zyklus.mjs:22`) — the right edge of
   the window we will fill on this wake-up. With the defaults that is
   `t + 0.1 + 0.1 = t + 0.2 s`. **This is the "how far ahead we look" knob.**
3. **First-tick bootstrap** (`zyklus.mjs:23-25`) — on the very first call,
   `phase` is initialised to `t + minLatency` so we start a hair in the future,
   not in the past.
4. **`while (phase < lookahead)`** (`zyklus.mjs:27`) — keep emitting callbacks
   until the leading edge `phase` has caught up to the right edge of the window.
   Each call hands the callback a *future* clock-time.
5. **`callback(phase, duration, tick, t)`** (`zyklus.mjs:29`) — notice the
   arguments: `phase` is the clock-time this tick represents, `duration` is how
   much time it covers, `tick` is the counter, and `t` is *now*. The comment on
   that line is a load-bearing warning: **"callback has to skip / handle
   `phase < t`!"** — see the deep dive below.
6. **`phase += duration`** (`zyklus.mjs:30`) — advance the leading edge by one
   clock-cycle and loop.

```
            t (now)                         lookahead = t + interval + overlap
            │                                                    │
   ─────────●──────●──────●──────●──────●──────●──────●──────●────┼──▶  audio time
                   │      │      │      │      │      │      │    │
                   phase advances by `duration` each callback    │
                   └──── each ● is one callback(phase,…) ─────────┘
                         all fired during ONE setInterval wake-up
```

> #### 🔎 Deep dive — why a callback can be told about a time in the past
> The loop condition is `phase < lookahead`, **not** `t < phase < lookahead`. So
> if the main thread stalls — a long GC pause, a heavy re-render — and a heartbeat
> that *should* have fired at real-time 5.10 actually fires at 5.25, then `phase`
> (which only advanced to ~5.20 last time) is now **behind** `t`. The loop will
> still call the callback for those stale `phase` values where `phase < t`. That
> is *by design*: the clock does not silently drop ticks, it forwards them and
> lets the consumer decide. `cyclist` checks `if (phase < t) { return }` and
> skips the query (`cyclist.mjs:53-57`), and the worker clock prints
> `'TOO LATE'` (`clockworker.js:139-140`). The alternative — having the clock
> itself swallow late ticks — would make the cycle counter drift out of sync with
> wall time. Forwarding them keeps the *musical position* honest even when the
> machine hiccups; you lose a sound, not the beat.

### 4.3 Starting and stopping

```js
const start = () => {
  clear();                                       // idempotent
  onTick();                                       // fire once immediately…
  intervalID = setInterval(onTick, interval * 1000);  // …then every `interval` seconds
};                                                // packages/core/zyklus.mjs:35-39
```

`start` (`zyklus.mjs:35`) fires `onTick` once right away (so there is no
`interval`-long silence at the downbeat) and then installs the heartbeat.
`stop` (`zyklus.mjs:45`) resets both `tick` and `phase` to 0 — and because
`phase === 0` is the bootstrap sentinel, the next `start` re-anchors to the
clock afresh. `pause` (`zyklus.mjs:44`) just clears the interval **without**
resetting the counters, so resuming continues the timeline.

---

## 5. `cyclist` — the event scheduler

`zyklus` gives us a stream of "at clock-time `phase`, you may do work" callbacks.
`packages/core/cyclist.mjs` is the layer that turns each of those into "query the
pattern and fire its events on the audio clock." It is the default scheduler for
a single Strudel instance (`Cyclist`, `cyclist.mjs:10`).

### 5.1 What it tracks

The constructor (`cyclist.mjs:11-21`) sets up the bookkeeping:

```js
this.cps = 0.5;                       // current tempo (cycles per second)
this.num_ticks_since_cps_change = 0;  // ticks counted since the last tempo change
this.lastTick = 0;                    // audio time of the last clock callback
this.lastBegin = 0;                   // cycle-time where the last query began
this.lastEnd = 0;                     // cycle-time where the last query ended (= next begin)
this.num_cycles_at_cps_change = 0;    // cycle position when cps last changed
this.seconds_at_cps_change;           // clock phase (seconds) when cps last changed
this.latency = latency;               // fixed trigger offset, default 0.1  (cyclist.mjs:17,33)
```

The pair `(num_cycles_at_cps_change, seconds_at_cps_change)` is an **anchor
point**: a known `(cycle, seconds)` correspondence. Everything after a tempo
change is measured relative to that anchor, which is how Strudel keeps the
cycle↔seconds mapping exact across tempo changes.

### 5.2 The clock callback, step by step

`cyclist` builds its `zyklus` clock at `cyclist.mjs:34-88`, passing the audio
`getTime` and — crucially — **its own `interval` as the clock's `duration`**
(`cyclist.mjs:83`), with `overlap` and the secondary interval both hard-coded to
`0.1` (`cyclist.mjs:84-85`). The callback body (`cyclist.mjs:37-82`):

**(a) Maintain the tempo anchor** (`cyclist.mjs:38-44`):

```js
if (this.num_ticks_since_cps_change === 0) {
  this.num_cycles_at_cps_change = this.lastEnd;   // remember WHERE (cycles) we are
  this.seconds_at_cps_change = phase;             // remember WHEN (seconds) that was
}
this.num_ticks_since_cps_change++;
const seconds_since_cps_change = this.num_ticks_since_cps_change * duration;
const num_cycles_since_cps_change = seconds_since_cps_change * this.cps;
```

Note how cycle-progress is derived from *counting ticks* (`num_ticks × duration ×
cps`), not from reading the wall clock. This makes the cycle timeline immune to
clock jitter: the musical position advances by exactly `duration × cps` cycles
per tick, deterministically.

**(b) Compute the query window** `[begin, end)` in cycles (`cyclist.mjs:47-51`):

```js
const begin = this.lastEnd;                                    // resume where we stopped
this.lastBegin = begin;
const end = this.num_cycles_at_cps_change + num_cycles_since_cps_change;
this.lastEnd = end;                                            // next tick begins here
this.lastTick = phase;
```

Because `begin = lastEnd`, consecutive windows are **contiguous and
non-overlapping** in cycle space — every slice of the cycle timeline is queried
exactly once. (The clock's `overlap` adds slack in *seconds* for robustness; it
does not cause cycle events to be queried twice, because the cycle cursor
`lastEnd` only ever moves forward.)

**(c) Drop the tick if we are already late** (`cyclist.mjs:53-57`):

```js
if (phase < t) {
  console.log(`skip query: too late`);
  return;                          // honour zyklus's "handle phase < t yourself"
}
```

**(d) Query the pattern** over the cycle window (`cyclist.mjs:60`):

```js
const haps = this.pattern.queryArc(begin, end, { _cps: this.cps, cyclist: 'cyclist' });
```

This is the only place the pattern is actually evaluated. It returns the `Hap`s
whose parts intersect `[begin, end)`.

**(e) For each event with an onset, compute its audio-clock target and fire**
(`cyclist.mjs:62-77`):

```js
haps.forEach((hap) => {
  if (hap.hasOnset()) {                       // only events that START in this window
    const targetTime =
      (hap.whole.begin - this.num_cycles_at_cps_change) / this.cps  // cycles → seconds, since anchor
      + this.seconds_at_cps_change                                  // + anchor's wall time
      + latency;                                                    // + fixed safety offset
    const duration = hap.duration / this.cps;                       // event length in seconds
    const deadline = targetTime - phase;                            // legacy; see below
    onTrigger?.(hap, deadline, duration, this.cps, targetTime);
    if (hap.value.cps !== undefined && this.cps != hap.value.cps) { // pattern can change tempo!
      this.cps = hap.value.cps;
      this.num_ticks_since_cps_change = 0;                          // re-anchor next tick
    }
  }
});
```

### 5.3 The `targetTime` formula, derived

This single expression (`cyclist.mjs:64-65`) is where cycle-time becomes
audio-time. Read it as three terms:

```
                     hap.whole.begin − num_cycles_at_cps_change
   targetTime  =  ───────────────────────────────────────────────  +  seconds_at_cps_change  +  latency
                                      cps
                  └──────────────── (A) ───────────────┘             └──────── (B) ───────┘    └── (C) ──┘
```

- **(A)** How many *cycles* the event's onset is past the anchor, divided by
  `cps`, i.e. how many **seconds** past the anchor it falls. (`cycleToSeconds`
  applied to a cycle delta.)
- **(B)** The audio-clock time of the anchor itself.
- **(C)** `latency` — a flat `0.1 s` (`cyclist.mjs:17`) added to *every* event.

(A) + (B) place the event at its mathematically exact audio-clock onset; (C)
shifts the entire stream `0.1 s` into the future to guarantee there is always
positive headroom between "now" and "when this must sound", absorbing the
scheduling jitter discussed in §3.

> #### 🔎 Deep dive — why anchor to a `(cycle, seconds)` point instead of just `cycle / cps`?
> Naively, `targetTime = hap.whole.begin / cps + latency`. That is correct *only
> while `cps` never changes*. The moment you call `setCps` or a pattern emits a
> `cps` control, the slope of the cycle→seconds line changes. If you kept using
> `hap.whole.begin / cps_new`, every already-elapsed cycle would be retroactively
> re-timed and the music would jump. The anchor `(num_cycles_at_cps_change,
> seconds_at_cps_change)` pins the line to the exact point where the tempo
> changed, so only *future* cycles are stretched/compressed by the new `cps`.
> This is the timing equivalent of "tempo automation that doesn't rewrite
> history." The worker clock keeps the same bookkeeping
> (`clockworker.js:81-89`).

> #### 🔎 Deep dive — what is `deadline`, and why is it "dumb"?
> `deadline = targetTime - phase` (`cyclist.mjs:69`) is the time-from-now until
> the event, and the comment calls it *"dumb and only here for backwards
> compatibility"* (`cyclist.mjs:67-68`, referencing PR #1004). Modern outputs do
> **not** use it: they want the **absolute** `targetTime` so they can hand it
> straight to the audio clock. `deadline` is passed as the second argument of the
> scheduler's `onTrigger` (which `getTrigger` receives as `deadline`), but as
> we'll see in §8 the audio/MIDI/OSC paths all schedule against `targetTime`
> instead. Treat `deadline` as a vestige; reach for `targetTime`.

### 5.4 `now()` — reading the live cycle position

UIs (the visual feedback, the highlighted mini-notation) need to know "what cycle
are we *at* right now?" That is `now()` (`cyclist.mjs:90-96`):

```js
now() {
  if (!this.started) return 0;
  const secondsSinceLastTick = this.getTime() - this.lastTick - this.clock.duration;
  return this.lastBegin + secondsSinceLastTick * this.cps;
}
```

It interpolates: take the cycle position at the last tick (`lastBegin`), add the
seconds elapsed since (minus one `duration`, to compensate for the lookahead
offset) converted to cycles. The REPL wires this up as `setTime(() =>
scheduler.now())` (`packages/core/repl.mjs:226,409,454`).

---

## 6. All the time windows in one picture

Putting §4 and §5 together, here is everything happening at a single heartbeat,
with the default constants (`interval/duration = 0.1`, `overlap = 0.1`,
`latency = 0.1`):

```
 AUDIO TIME (seconds) ───────────────────────────────────────────────────────────▶

      t = now                     t + 0.2 = lookahead edge
        │                                │
 ───────●────────────────────────────────●──────────────────────────────────▶
        │◄──── interval (0.1) ───►│◄ overlap (0.1) ►│
        │                                │
        │   zyklus emits a callback for each `phase` in [t, t+0.2)
        │   cyclist queries the pattern over the matching CYCLE window [begin,end)
        │
        │                 each onset hap →  targetTime = onset_seconds + latency(0.1)
        │                                            │
        ▼                                            ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │  the +latency shift means even an event whose math onset == t is       │
   │  scheduled for t+0.1, i.e. always safely in the future                 │
   └──────────────────────────────────────────────────────────────────────┘

 CYCLE TIME (cycles) ────────────────────────────────────────────────────────────▶
        │
   begin = lastEnd                 end = anchor_cycles + ticks·duration·cps
        │                                │
 ───────[────────────────────────────────)──────────────────────────────────▶
        contiguous, non-overlapping, queried exactly once
```

Three independent "windows"/offsets, doing three different jobs — do not confuse
them:

| Quantity | Default | Lives in | Job |
|---|---|---|---|
| `interval` | 0.1 s | wall clock | how often we wake up |
| `overlap` | 0.1 s | wall clock | extra slack so a late wake-up still covers the gap |
| `lookahead` = `interval + overlap` | 0.2 s | audio clock | how far ahead each wake-up schedules |
| `latency` | 0.1 s | audio clock | fixed offset added to *every* event's onset |
| `duration` | 0.1 s* | clock-time | cycle-time advanced per callback (*`= interval` as wired by cyclist, `cyclist.mjs:83`) |
| `minLatency` | 0.01 s | audio clock | first-tick cushion only |

The **total delay** from "you would expect a sound now" to "you hear it" is
bounded by `latency` (0.1 s) — that is the deliberate, constant part. The
`lookahead` (0.2 s) is how much jitter the system can absorb before a sound is
actually dropped.

---

## 7. `neocyclist` + `clockworker` — multi-instance sync

`Cyclist` runs the clock on the page's main thread. That is fine for one
Strudel, but if you open several REPL instances (or several browser tabs) that
should play *together*, each main-thread clock would drift independently. The
**`NeoCyclist`** (`packages/core/neocyclist.mjs:10`) solves this by moving the
clock into a **`SharedWorker`** so every instance receives the *same* ticks.

The REPL chooses between them at construction time
(`packages/core/repl.mjs:73-75`):

```js
const scheduler =
  sync && typeof SharedWorker != 'undefined'
    ? new NeoCyclist(schedulerOptions)   // shared clock across instances/tabs
    : new Cyclist(schedulerOptions);     // single-instance fallback
```

### 7.1 The worker clock

`packages/core/clockworker.js` runs the **same `zyklus` `createClock`** (it
inlines a copy at `clockworker.js:117`, pending Firefox ESM-in-worker support,
see `clockworker.js:2-4`) but with a different time base: instead of the audio
clock it uses `performance.now() * 0.001` (`clockworker.js:6-10`). On every tick
it computes the cycle window and broadcasts it (`clockworker.js:25-44`) to all
connected clients over a `BroadcastChannel('strudeltick')`
(`clockworker.js:19,36`):

```js
sendMessage('tick', { begin, end, cps, time, cycle });   // clockworker.js:36-42
```

It mirrors all of `cyclist`'s cps-change bookkeeping
(`num_cycles_at_cps_change`, `num_ticks_since_cps_change`,
`num_seconds_at_cps_change`; `clockworker.js:12-15,81-89`) so the cycle math is
identical — the only difference is *who* runs it and that there is one of it for
all tabs. It also reference-counts clients so the clock stops only when the last
instance stops (`clockworker.js:58-70`).

### 7.2 The drift problem and `ClockCollator`

Here is the subtlety. The worker's clock is `performance.now()`. But events must
ultimately be scheduled on each instance's **audio clock**
(`AudioContext.currentTime`). **These two clocks tick at slightly different
rates and drift apart over time** (`neocyclist.mjs:16-19`). A tick message also
takes a variable, non-zero time to travel from worker to instance. If you naively
treated the worker's `time` as an audio-clock time, scheduling would slowly slide
out of alignment.

`ClockCollator` (`packages/core/util.mjs:382`) fixes this. It maintains a
**rolling average of the offset** between the two clocks:

```js
calculateOffset(currentTime) {
  const targetClockTime = this.getTargetClockTime();   // the AUDIO clock (neocyclist.mjs:20)
  const newOffsetTime = targetClockTime - currentTime; // instantaneous offset
  // …push into a ring buffer of size `weight` (16), average it…
  // …only adopt the new average if it moved by more than offsetDelta (0.005 s)…
  return this.offsetTime;                               // a STABLE offset
}                                                       // util.mjs:404-433
```

When a tick arrives, `NeoCyclist` converts the worker time into audio time before
doing anything else (`neocyclist.mjs:32`):

```js
const currentTime = this.collator.calculateOffset(time) + time;  // worker time → audio time
```

and then computes `targetTime` with the same shape as `cyclist`, but expressed
relative to the *current cycle* the worker reported (`neocyclist.mjs:43-47`):

```js
const timeUntilTrigger = cycleToSeconds(hap.whole.begin - this.cycle, this.cps);
const targetTime = timeUntilTrigger + currentTime + this.latency;   // latency = 0.1 (neocyclist.mjs:22)
onTrigger?.(hap, 0, duration, this.cps, targetTime);                // note: deadline is just 0 here
```

> #### 🔎 Deep dive — what the collator buys you, and its guard rails
> The collator is essentially a **low-pass filter on clock skew**. A single
> instantaneous offset sample is noisy (it includes the random message-delivery
> delay); averaging the last 16 (`weight`, `util.mjs:385`) smooths it. The
> `offsetDelta = 0.005` (`util.mjs:386`) hysteresis means the reference offset is
> only updated when skew exceeds 5 ms, so it doesn't jitter the schedule on every
> tick. And `checkAfterTime`/`resetAfterTime` (2 s / 8 s, `util.mjs:387-388`)
> handle the "laptop went to sleep" case: if more than 8 s elapse between
> samples, the rolling history is thrown away and rebuilt from scratch
> (`util.mjs:409-411`), because the old offset is meaningless after a long gap.
> The same collator is reused on the OSC path (§8.4) to align Strudel's clock to
> an *external* sequencer's wall clock.

---

## 8. From scheduler to output: the trigger pipeline

We now have, per event, a call to the scheduler's `onTrigger(hap, deadline,
duration, cps, targetTime)`. This section traces how that becomes actual sound,
MIDI, OSC, or a WebSocket message. The architecture here is covered in
[`extending-strudel.md` §5](./extending-strudel.md); here we focus purely on the
*timing* hand-off.

### 8.1 `getTrigger` — the signature converter and the `dominantTrigger` switch

The scheduler is given a single `onTrigger` callback, built by `getTrigger`
(`packages/core/repl.mjs:563-579`):

```js
export const getTrigger =
  ({ getTime, defaultOutput }) =>
  async (hap, deadline, duration, cps, t) => {        // ← scheduler's signature
    try {
      if (!hap.context.onTrigger || !hap.context.dominantTrigger) {
        await defaultOutput(hap, deadline, duration, cps, t);   // (1) WebAudio, unless suppressed
      }
      if (hap.context.onTrigger) {
        await hap.context.onTrigger(hap, getTime(), cps, t);    // (2) custom output(s)
      }
    } catch (err) {
      errorLogger(err, 'getTrigger');
    }
  };
```

Two timing-relevant things happen here:

1. **The default WebAudio output runs** *unless* the hap carries a custom trigger
   that is marked **dominant** (`dominantTrigger`, set by `Pattern.onTrigger(fn,
   dominant = true)`, `packages/core/pattern.mjs:875`). This is how `.midi()` or
   `.osc()` *replace* audio instead of doubling it.
2. **The signature is converted.** The scheduler passes `(hap, deadline,
   duration, cps, t)` where `t` is the absolute `targetTime`. But a
   `hap.context.onTrigger` (what your `.onTrigger(fn)` registers) is called as
   `(hap, currentTime, cps, targetTime)` — i.e. its second arg is **`getTime()`
   sampled fresh right now**, and `targetTime` is passed as the *fourth* arg
   (`repl.mjs:574`). So inside any custom output:

   ```js
   pat.onTrigger((hap, currentTime, cps, targetTime) => { … })
   //                   │ now (audio)        │ when to actually fire (audio)
   ```

   The gap `targetTime − currentTime` is your scheduling headroom (≈ `latency`
   plus whatever lookahead remains).

### 8.2 WebAudio / superdough — absolute scheduling on the audio clock

The default output is `webaudioOutput` (`packages/webaudio/webaudio.mjs:36-38`,
wired as `defaultOutput` at `webaudio.mjs:110`):

```js
export const webaudioOutput = (hap, _deadline, hapDuration, cps, t) => {
  return superdough(hap2value(hap), t, hapDuration, cps, hap.whole?.begin.valueOf());
};
```

It ignores `deadline` and passes the absolute `t` (= `targetTime`) straight to
`superdough`, whose contract is *"`t` is always the absolute target onset time"*
(`packages/superdough/superdough.mjs:461-464`). `superdough` then refuses to
schedule into the past — the safety net that makes the whole lookahead scheme
fail loudly rather than silently glitch (`superdough.mjs:484-489`):

```js
if (t < ac.currentTime) {
  console.warn(`[superdough]: cannot schedule sounds in the past (target: …, now: …)`);
  return;
}
```

From there, oscillators/samples are started with Web Audio's own sample-accurate
scheduling at time `t`. For one-shot or callback-style timing, superdough uses a
neat trick — `scheduleAtTime` (`packages/superdough/helpers.mjs:366-390`):

```js
export function scheduleAtTime(callback, targetTime, audioContext = getAudioContext()) {
  const currentTime = audioContext.currentTime;
  webAudioTimeout(audioContext, callback, currentTime, targetTime);
}
// a ConstantSourceNode is started now and stopped at targetTime; its `onended`
// fires the callback — a *sample-accurate* timer driven by the audio thread.
export function webAudioTimeout(audioContext, onComplete, startTime, stopTime) {
  const constantNode = new ConstantSourceNode(audioContext);
  /* muted, connected so onended fires reliably … */
  onceEnded(constantNode, () => { /* cleanup */ onComplete(); });
  constantNode.start(startTime);
  constantNode.stop(stopTime);                 // ← onended fires here, on the audio clock
}
```

> #### 🔎 Deep dive — why schedule callbacks via a silent oscillator?
> `setTimeout(cb, (targetTime − now) * 1000)` would fire `cb` on the main thread,
> with all the jitter we have been trying to escape. By instead starting a muted
> `ConstantSourceNode` and stopping it at `targetTime`, the browser's **audio
> thread** decides exactly when the node ends and fires `onended`. That callback
> is therefore aligned to the same sample-accurate clock everything else uses.
> This is the same mechanism MIDI relies on (next section) to land messages on
> time even though `WebMidi.playNote` is a main-thread call.

### 8.3 MIDI — riding the audio clock to time main-thread sends

`packages/midi/midi.mjs` cannot ask the OS MIDI stack to "play at audio-time t"
directly — `WebMidi.playNote` happens *now*, on the main thread. So it uses
superdough's `scheduleAtTime` to defer the send to precisely `targetTime`. The
`.midi()` output is a plain `Pattern.prototype.midi` (not via `register`, to
avoid the arg-reification trap noted in `extending-strudel.md`) whose
`onTrigger` receives `(hap, _currentTime, cps, targetTime)`
(`packages/midi/midi.mjs:340`) and hands `targetTime` down to every send helper
(`midi.mjs:265-281`):

```js
function sendNote(note, velocity, duration, device, midichan, targetTime) {
  /* … build the Note … */
  scheduleAtTime(() => {
    device.playNote(midiNote, midichan);    // fires on the audio clock at targetTime
  }, targetTime);                            // packages/midi/midi.mjs:278-280
}
```

Every MIDI message type (`sendCC`, `sendProgramChange`, `sendSysex`, `sendNRPN`,
`sendPitchBend`, `sendAftertouch`, `midi.mjs:185-261`) follows the identical
`scheduleAtTime(() => …, targetTime)` shape. Note duration is converted
cycles→seconds→ms and trimmed by `noteOffsetMs` (10 ms) to keep note-offs from
overlapping the next note-on (`midi.mjs:390-394,317`).

### 8.4 OSC — translating the audio clock to an external wall clock

OSC is the interesting case: the receiver (typically SuperDirt/SuperCollider) has
its **own** clock and schedules bundles by an absolute timestamp. So Strudel must
translate its audio-clock `targetTime` into the *receiver's* time base — which is
exactly what `ClockCollator` is for (§7.2). The OSC trigger
(`packages/osc/osc.mjs:60-73`):

```js
const collator = new ClockCollator({});                     // default target = Unix wall clock (util.mjs:444)
export async function oscTrigger(hap, currentTime, cps = 1, targetTime) {
  const controls = parseControlsFromHap(hap, cps);          // adds cps, cycle, delta (osc.mjs:34-52)
  const ts = collator.calculateTimestamp(currentTime, targetTime) * 1000;   // audio time → wall time (ms)
  const msg = { address: '/dirt/play', args: keyvals, timestamp: ts };
  /* … */
  ws.send(JSON.stringify(msg));                              // osc.mjs:64-73
}
export const osc = register('osc', (pat) => pat.onTrigger(oscTrigger));     // osc.mjs:86
```

`calculateTimestamp(currentTime, targetTime)` returns `offset + targetTime`
(`util.mjs:435-437`), where `offset` is the rolling audio-clock→wall-clock skew.
The result is the event's onset expressed on the *wall clock the OSC server
shares*, sent as a timestamp inside the bundle so the server can schedule it
precisely on its end. The message travels over a WebSocket to a small Node bridge
(`packages/osc/server.js`) that forwards it as UDP/OSC.

### 8.5 Custom WebSocket output (the `strudel-laser` pattern)

Your own outputs follow the same contract. The worked example in
[`docs/strudel-laser/`](../strudel-laser/) attaches a `.laser(host)` output whose
`onTrigger` receives `(hap, currentTime, cps, targetTime)` and forwards
`targetTime` (and a `durationSec` computed as `hap.duration / cps`) in its
JSON payload, letting the receiving device schedule against it — directly
mirroring how OSC ships `targetTime` downstream. The key timing lesson the
example encodes: **always propagate `targetTime` to the receiver** rather than
firing "now," so the consumer can compensate for transport delay the same way
SuperDirt does.

### 8.6 The whole pipeline, end to end

```
  ┌─────────────┐   setInterval heartbeat (every `interval`)
  │   zyklus    │───────────────────────────────────────────────┐
  │ createClock │   callback(phase, duration, tick, t)           │
  └─────────────┘                                                ▼
                                              ┌──────────────────────────────┐
                                              │  cyclist / neocyclist         │
                                              │  • ticks → cycle window       │
                                              │  • queryArc(begin,end)        │
                                              │  • per onset:                 │
                                              │      targetTime (audio secs)  │
                                              └───────────────┬───────────────┘
                                                              │ onTrigger(hap, deadline, dur, cps, targetTime)
                                                              ▼
                                              ┌──────────────────────────────┐
                                              │  getTrigger (repl.mjs:563)    │
                                              │  • dominantTrigger gate       │
                                              │  • signature → (hap, now,     │
                                              │      cps, targetTime)         │
                                              └───┬───────────────┬───────┬───┘
                            default (unless dominant)             │       │
                                  ▼                               ▼       ▼
                       ┌───────────────────┐        ┌──────────────┐  ┌──────────────┐
                       │ webaudioOutput →  │        │ .midi()      │  │ .osc()/custom│
                       │ superdough(t=…)   │        │ scheduleAtTime│  │ collator →   │
                       │ schedule @ audio  │        │ @ audio clock │  │ wall-clock ts│
                       │ clock (sample-acc)│        │ → WebMidi send│  │ → WebSocket  │
                       └───────────────────┘        └──────────────┘  └──────────────┘
```

---

## 9. A full numeric walkthrough

Let's trace `note("c e g")` (three events per cycle) at the default `cps = 0.5`,
starting from a cold `start()` at audio time `t₀ = 5.000 s`. Defaults:
`duration = interval = 0.1`, `overlap = 0.1`, `latency = 0.1`, `minLatency =
0.01`.

**Heartbeat 0** (`start()` calls `onTick` immediately, `zyklus.mjs:37`):

- `t = 5.000`, `lookahead = 5.000 + 0.1 + 0.1 = 5.200`.
- `phase` was 0 → bootstrap to `5.000 + 0.01 = 5.010` (`zyklus.mjs:24`).
- Loop, emitting a callback per `phase` while `phase < 5.200`:
  - `phase = 5.010` → `phase += 0.1` → `5.110` → `5.210` (stop, ≥ 5.200). So
    **two** callbacks this wake-up (at 5.010 and 5.110).
- First callback (`phase = 5.010`): it is the first tick since cps change, so the
  **anchor** is set: `num_cycles_at_cps_change = lastEnd = 0`,
  `seconds_at_cps_change = 5.010` (`cyclist.mjs:38-41`).
  - `num_ticks = 1`, `seconds_since = 1 × 0.1 = 0.1`, `cycles_since = 0.1 × 0.5 =
    0.05`.
  - Query window: `begin = 0`, `end = 0 + 0.05 = 0.05` cycles. → only the event
    at cycle 0 (the `c`) has its onset in `[0, 0.05)`.
  - `targetTime = (0 − 0) / 0.5 + 5.010 + 0.1 = 5.110 s`. The `c` is scheduled
    for audio-time **5.110** — 0.1 s in the future. ✓
- Second callback (`phase = 5.110`): `num_ticks = 2`, `cycles_since = 0.2 × 0.5 =
  0.1`. Window `begin = 0.05`, `end = 0.10`. No onset there (the `e` is at cycle
  ⅓ ≈ 0.333). Nothing fired.

**Heartbeat 1** (`setInterval` fires ~`t = 5.100`):

- `lookahead = 5.100 + 0.2 = 5.300`. `phase` resumed at `5.210`.
- Callbacks at `phase = 5.210` (window `0.10 → 0.15`), `5.310` would be ≥ 5.300 →
  one callback. Still no onset (next is at 0.333). Nothing fired yet — but the
  `c` scheduled last heartbeat is *already going to play* at 5.110, which is now
  in the past-but-scheduled, i.e. it sounds on time.

…and so on. By the time cycle-time reaches ⅓ (≈ audio-time `5.010 + (1/3)/0.5 =
5.010 + 0.667 = 5.677`, plus 0.1 latency ⇒ `e` plays at ~5.777), the
corresponding heartbeat will have queried the window containing it and scheduled
it. The crucial invariant holds throughout: **every event is handed to the audio
clock before its `targetTime`, and its `targetTime` is always `≥ now + (latency −
elapsed-within-window) > now`.**

---

## 10. Tuning, gotchas, and failure modes

**`latency` is your audible delay floor.** Every event is shifted `+0.1 s`
(`cyclist.mjs:17`). Lowering it tightens responsiveness but shrinks the safety
margin against the audio thread under-running; raising it makes timing more
robust at the cost of feeling laggy. It is a constructor option on the scheduler
(`schedulerOptions`, `repl.mjs:57-58`).

**`lookahead = interval + overlap` is your jitter budget.** If a main-thread
stall exceeds the lookahead, `cyclist` will see `phase < t` and **skip the
query** (`cyclist.mjs:53-57`) — you lose those events (a brief dropout) but the
cycle counter stays correct, so playback realigns on the next healthy heartbeat
rather than drifting. The worker clock logs `'TOO LATE'` for the analogous case
(`clockworker.js:140`).

**"cannot schedule sounds in the past."** If you see this warning
(`superdough.mjs:485`), an event's `targetTime` came out `< currentTime`. Causes:
an enormous main-thread stall (bigger than `latency + lookahead`), a `latency`
set too low, or extremely heavy per-hap user code in the query path. It is a
symptom that the lookahead headroom was exhausted.

**Tempo changes don't rewrite history.** Because of the `(cycles, seconds)`
anchor (§5.3), `setCps` and pattern-emitted `cps` controls (`cyclist.mjs:72-75`)
only retime *future* cycles. Re-anchoring resets `num_ticks_since_cps_change = 0`
so the next tick re-pins the line.

**Single-instance vs synced.** `Cyclist` (main-thread clock) is the default;
`NeoCyclist` (shared-worker clock + `ClockCollator`) is selected only when `sync`
is on and `SharedWorker` exists (`repl.mjs:73-75`). Mobile Chrome lacks
`SharedWorker`, so it falls back to `Cyclist` — meaning cross-tab sync silently
degrades there; this is intentional (`repl.mjs:73` comment).

**`now()` is interpolated, not exact.** UI position from `scheduler.now()`
(`cyclist.mjs:90`) is a linear interpolation between ticks and subtracts one
`duration` to account for lookahead; it is fine for highlighting but is not a
sample-accurate audio position.

**Offline rendering bypasses all of this.** `renderPatternAudio`
(`webaudio.mjs:40-103`) queries the whole arc up front, sorts haps by onset, and
calls `superdough` with `targetTime` measured from the render start — there is no
clock, no lookahead, no latency. Useful to keep in mind when reasoning about why
rendered output can be tighter than live output.

---

## 11. Quick reference

### Constants

| Constant | Value | Defined at | Meaning |
|---|---|---|---|
| `duration` | `0.05` (default) / `interval` as used by cyclist | `zyklus.mjs:8`, `cyclist.mjs:83` | clock-time advanced per callback |
| `interval` | `0.1 s` | `zyklus.mjs:9` | setInterval heartbeat period |
| `overlap` | `0.1 s` | `zyklus.mjs:9`, `cyclist.mjs:84` | extra lookahead slack |
| `minLatency` | `0.01 s` | `zyklus.mjs:17` | first-tick cushion |
| `latency` | `0.1 s` | `cyclist.mjs:17`, `neocyclist.mjs:22` | fixed per-event onset offset |
| `precision` | `10⁴` | `zyklus.mjs:16` | phase rounding (0.1 ms) |
| `cps` | `0.5` | `cyclist.mjs:24` | default cycles/second |
| collator `weight` / `offsetDelta` | `16` / `0.005 s` | `util.mjs:385-386` | drift filter window / hysteresis |

### Key functions and where they live

| What | Where |
|---|---|
| Low-level lookahead clock | `createClock` — `packages/core/zyklus.mjs:4` |
| The lookahead loop | `onTick` — `packages/core/zyklus.mjs:20` |
| Single-instance scheduler | `Cyclist` — `packages/core/cyclist.mjs:10` |
| `targetTime` formula | `packages/core/cyclist.mjs:64` |
| Live cycle position | `Cyclist.now` — `packages/core/cyclist.mjs:90` |
| Synced scheduler | `NeoCyclist` — `packages/core/neocyclist.mjs:10` |
| Shared worker clock | `packages/core/clockworker.js` |
| Drift correction | `ClockCollator` — `packages/core/util.mjs:382` |
| cycles→seconds | `cycleToSeconds` — `packages/core/util.mjs:377` |
| Scheduler→output adapter | `getTrigger` — `packages/core/repl.mjs:563` |
| Scheduler selection | `packages/core/repl.mjs:73` |
| Audio clock source | `getAudioContext().currentTime` — `packages/webaudio/webaudio.mjs:109`, `packages/repl/repl-component.mjs:41` |
| Default audio output | `webaudioOutput` — `packages/webaudio/webaudio.mjs:36` |
| Absolute-time scheduling | `superdough` (`t` = onset) — `packages/superdough/superdough.mjs:461`; past-guard `:484` |
| Sample-accurate callback timer | `scheduleAtTime` / `webAudioTimeout` — `packages/superdough/helpers.mjs:366,372` |
| MIDI scheduling | `sendNote` etc. — `packages/midi/midi.mjs:265`; trigger `:340` |
| OSC timestamp translation | `oscTrigger` — `packages/osc/osc.mjs:60`; `calculateTimestamp` `util.mjs:435` |

### The one mental model to keep

> The **interval clock** decides *when Strudel gets a chance to work*. The
> **pattern** decides *what happens, in cycles*. `cps` converts cycles to
> **audio-clock seconds**, and `latency` pushes them safely into the future. The
> **audio clock** — never the interval clock — decides *when anything actually
> happens*. Every output (audio, MIDI, OSC, WebSocket) is just a different way of
> honouring the same `targetTime`.

---

*See also:* [`extending-strudel.md`](./extending-strudel.md) for the `register()`
mechanism, controls, the `onTrigger`/`dominantTrigger` pipeline, and two worked
extension examples; and [`docs/strudel-laser/`](../strudel-laser/) for a
build-tested custom WebSocket output that schedules against `targetTime`.
