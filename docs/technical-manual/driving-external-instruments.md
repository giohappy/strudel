# Driving External Instruments: MIDI, OSC, and Hosting VSTs

> How to make Strudel play an external sound source — a DAW, a hardware synth, or
> a VST plugin — and **keep the timing tight**. This document explains why Strudel's
> MIDI and OSC outputs behave very differently with respect to timing, what that
> means for the common "Strudel → virtual MIDI port → DAW" setup, and how to host
> VST plugins through SuperCollider + SuperDirt + the VSTPlugin extension so that
> Strudel's scheduling timestamp is actually honored.
>
> This is the practical companion to [`clock-and-timing.md`](./clock-and-timing.md).
> That document explains *how* the scheduler computes an accurate `targetTime` for
> every event. This one explains *what each output does with that `targetTime`* —
> which is the difference between rock-solid and jittery external timing. Every
> claim about Strudel's own code carries a `file:line` anchor.

---

## Table of contents

1. [The problem: one timestamp, two fates](#1-the-problem-one-timestamp-two-fates)
2. [How `.midi()` schedules — and where the timestamp is lost](#2-how-midi-schedules--and-where-the-timestamp-is-lost)
3. [How `.osc()` schedules — and why the timestamp survives](#3-how-osc-schedules--and-why-the-timestamp-survives)
4. [Choosing a path for an external DAW / VST host](#4-choosing-a-path-for-an-external-daw--vst-host)
5. [Setup: SuperDirt + VSTPlugin](#5-setup-superdirt--vstplugin)
6. [The per-note VST-instrument timing caveat](#6-the-per-note-vst-instrument-timing-caveat)
7. [If you still want a custom proxy](#7-if-you-still-want-a-custom-proxy)
8. [Quick reference](#8-quick-reference)

---

## 1. The problem: one timestamp, two fates

Every event Strudel plays is a `Hap` carrying a musical onset (in cycles). The
scheduler (`cyclist` / `neocyclist`) converts that onset into an **absolute target
time on the Web Audio clock** — `targetTime` — *ahead* of the moment it actually
needs to sound. (See [`clock-and-timing.md`](./clock-and-timing.md) for the full
derivation; the short version is `targetTime = (begin − anchorCycle)/cps +
anchorSeconds + latency`, `packages/core/cyclist.mjs:64`.)

That `targetTime` is the single most valuable number in the system for timing. The
WebAudio output uses it directly, so internal Strudel sound is sample-accurate. But
when you send events *out of the browser*, what happens to `targetTime` depends
entirely on which output you use:

```
                                  ┌─────────────────────────────────────────────┐
   scheduler computes targetTime  │  what the output does with it                │
   (audio-clock accurate)         │                                               │
            │                     │  .midi()  →  fires playNote() "now" at        │
            ▼                     │              targetTime, but sends NO          │
   getTrigger (repl.mjs:563)      │              timestamp downstream  ── jitter   │
            │                     │                                               │
            ├──────────────────►  │  .osc()   →  ENCODES targetTime as an OSC      │
            │                     │              bundle timestamp  ── absorbed     │
            ▼                     │                                               │
   hap.context.onTrigger(...)     └─────────────────────────────────────────────┘
```

The asymmetry is the whole story, so the next two sections look at each path in the
code.

> #### 🔎 Deep dive — `getTrigger` feeds both paths the same `targetTime`
>
> The scheduler calls one trigger function per onset. `getTrigger`
> (`packages/core/repl.mjs:563`) receives `(hap, deadline, duration, cps, t)` where
> `t` **is** `targetTime`, runs the default WebAudio output unless a custom output
> has claimed dominance, then calls the custom output as
> `hap.context.onTrigger(hap, getTime(), cps, t)` — i.e. `(hap, currentTime=now,
> cps, targetTime)`. So both `.midi()` and `.osc()` are handed the *same* accurate
> `targetTime` plus the current audio time. What differs is purely what each does
> with them.

---

## 2. How `.midi()` schedules — and where the timestamp is lost

`.midi()` is `Pattern.prototype.midi` (`packages/midi/midi.mjs:294` — a direct
prototype method, **not** a `register()`ed function, because its first argument is a
device-name string, not a pattern). Its `onTrigger` (`midi.mjs:340`) unpacks the hap
and dispatches each message type through a small family of `send*` helpers. Note-on
goes through `sendNote` (`midi.mjs:265`):

```js
function sendNote(note, velocity, duration, device, midichan, targetTime) {
  // ...validation...
  const midiNote = new Note(midiNumber, { attack: velocity, duration });
  scheduleAtTime(() => {
    device.playNote(midiNote, midichan);
  }, targetTime);
}
```

`scheduleAtTime` (`packages/superdough/helpers.mjs:366`) is a clever audio-thread
timer: it starts a muted `ConstantSourceNode` now and stops it at `targetTime`; the
node's `onended` event fires the callback (`helpers.mjs:372` `webAudioTimeout`). So
the *timer itself* is sample-accurate — it fires the callback at `targetTime` on the
audio thread, not via a jittery `setTimeout`.

**But look at what the callback does:** `device.playNote(...)`. That is a *WebMidi.js*
call that sends the MIDI message **immediately, on the JS main thread, the moment the
callback fires**. Strudel does **not** pass `targetTime` to WebMIDI as a future
timestamp (the Web MIDI API and WebMidi.js both support `output.send(data, timestamp)`
/ a `time` option — Strudel does not use it here). From the `playNote` boundary
onward, `targetTime` no longer exists. The message now has to traverse:

```
playNote() ──► WebMidi.js ──► browser Web MIDI ──► OS MIDI stack ──► virtual port ──► DAW
   (main thread dispatch)                          (e.g. WinMM)      (loopMIDI)
```

Each hop adds latency *and jitter*. The audio-thread timer removed `setTimeout`
jitter, but everything after `playNote` is uncompensated.

> #### 🔎 Deep dive — why this bites hardest on Windows
>
> On Windows, Chrome's Web MIDI implementation uses the legacy **WinMM** API, which
> has **no output timestamping** — it sends messages immediately regardless of any
> timestamp. So even if Strudel *did* hand WebMIDI a future `targetTime`, the OS
> would discard it. Combined with a user-space virtual port like **loopMIDI**, this
> is the root of the jitter you observe: it is below the `playNote` call, outside
> anything Strudel can schedule. macOS CoreMIDI and modern WinRT MIDI *can* honor
> output timestamps, but Strudel's current code doesn't supply one, so the point is
> moot today on every platform.

The practical jitter on a healthy system is usually a few milliseconds — fine for
sustained or pad material, audible on tight percussion.

---

## 3. How `.osc()` schedules — and why the timestamp survives

`.osc()` does the opposite. It is `register('osc', (pat) => pat.onTrigger(oscTrigger))`
(`packages/osc/osc.mjs:86`), and `oscTrigger` (`osc.mjs:60`) **keeps** `targetTime`
and ships it as data:

```js
export async function oscTrigger(hap, currentTime, cps = 1, targetTime) {
  const ws = await connect();
  const controls = parseControlsFromHap(hap, cps);
  const keyvals = Object.entries(controls).flat();
  const ts = collator.calculateTimestamp(currentTime, targetTime) * 1000;
  const msg = { address: '/dirt/play', args: keyvals, timestamp: ts };
  // ...optional host/port override...
  ws.send(JSON.stringify(msg));
}
```

Two things matter here:

1. `collator.calculateTimestamp(currentTime, targetTime)` (`packages/core/util.mjs:435`,
   a `ClockCollator`) translates the audio-clock `targetTime` into the *receiver's*
   wall-clock domain, low-pass-filtering clock drift so the mapping is stable. The
   result (in ms) is attached to the message as `timestamp`.
2. The message is sent over a WebSocket to a local bridge — it is **not** "play now."

The bridge is shipped in the repo as `packages/osc/server.js`. It:

```js
const WS_PORT = 8080;                  // server.js:14
const OSC_REMOTE_PORT = 57120;         // server.js:16  (SuperCollider langPort)
// ...
let msg = { address: data['address'], args: data['args'] };
if ('timestamp' in data) {
  msg = { timeTag: osc.timeTag(0, data['timestamp']), packets: [msg] };  // server.js:51-52
}
udpPort.send(msg, osc_host, osc_port);
```

So Strudel's `targetTime` becomes a real **NTP OSC time tag** on a UDP bundle. A
receiver that honors OSC bundle time tags — like SuperCollider / SuperDirt — schedules
the event at that absolute moment on *its* clock. The WebSocket and UDP transport
jitter is **absorbed**, because nothing plays on arrival; it plays at the time tag.

```
.osc()  ──►  WS ws://localhost:8080  ──►  server.js  ──►  UDP 127.0.0.1:57120
hap+targetTime    (jitter here…)          (NTP timeTag)     (…and here is absorbed)
                                                                   │
                                                                   ▼
                                              SuperCollider schedules at the timeTag
```

This is why, for tight external timing, **OSC is structurally better than MIDI in
Strudel today** — provided something downstream actually schedules to the timestamp.

To run the bridge from this repo:

```bash
node packages/osc/server.js
# [Sending OSC] 127.0.0.1:57120
# [Listening WS] ws://localhost:8080
```

(It is also the package's `bin`, so a published `@strudel/osc` exposes it as an
executable.)

---

## 4. Choosing a path for an external DAW / VST host

The catch: OSC's timestamp only helps if the receiver schedules to it, and **DAWs do
not speak OSC for note events**. Strudel's OSC target is SuperCollider / SuperDirt.
So the decision tree is:

| Goal | Best option | Timing |
| --- | --- | --- |
| Host VST **effects** over Strudel/SC sounds | SuperDirt + VSTPlugin | sample-accurate |
| Trigger SuperCollider's own synths/samples | SuperDirt (`.osc()`) | sample-accurate |
| Host a VST **instrument**, per-note | SuperDirt + VSTPlugin | good, *minor* residual jitter — see §6 |
| Drive a specific DAW you must use | `.midi()` → virtual port | jittery (§2); often "good enough" |

If your VSTs can live inside SuperCollider (most can), the SuperDirt + VSTPlugin route
gives you Strudel's timestamp end-to-end with **no custom code**, and removes the
virtual-MIDI-port / OS-MIDI hop entirely. That is the setup the rest of this document
covers.

> A generic "OSC → MIDI" translator does **not** rescue MIDI timing unless it has its
> own scheduler that honors the bundle time tag. Most fire on arrival, throwing the
> timestamp away again — back to §2.

---

## 5. Setup: SuperDirt + VSTPlugin

### 5.1 Install the pieces

1. **SuperCollider** (`sclang` + `scsynth`) — <https://supercollider.github.io>.
2. **VSTPlugin extension** by Christof Ressi — a *separate* download (it is **not** in
   sc3-plugins). Get the release matching **both** your OS and your SuperCollider
   version from its releases page, and unzip it into your user extensions dir:
   ```supercollider
   Platform.userExtensionDir;   // evaluate to reveal the folder; drop VSTPlugin-x.y.z/ in
   ```
   Recompile the class library (`Ctrl/Cmd+Shift+L`), then scan installed plugins:
   ```supercollider
   VSTPlugin.search;                       // scans the system VST/VST3 folders
   VSTPlugin.pluginList(s, sorted: true);  // list what was found — note the exact key
   ```
3. **SuperDirt** quark (this is what understands `/dirt/play`):
   ```supercollider
   Quarks.install("SuperDirt");   // pulls SuperDirt + Vowel + Dirt-Samples
   ```

### 5.2 Boot with headroom for VST graphs

VST signal graphs are large; the server defaults will throw `exceeded number of
interconnect buffers`. Use a startup file (`startup.scd`):

```supercollider
(
s = Server.default;
s.options.numWireBufs = 1024;       // raise further if you still see "interconnect buffers"
s.options.memSize     = 1024 * 256; // 256 MB
s.options.maxLogins   = 4;
s.waitForBoot {
    ~dirt = SuperDirt(2, s);
    ~dirt.loadSoundFiles;
    s.sync;

    // A VST-instrument voice. SuperDirt spawns one per event (like a sampler voice).
    SynthDef(\vsti, { |out, freq=440, gate=1, amp=0.8, pan=0, sustain=1|
        var env = EnvGen.kr(Env.asr(0.002, 1, 0.1), gate, doneAction: 2)
                  * EnvGen.kr(Env([1, 1, 0], [sustain, 0]), doneAction: 2);
        var sig = VSTPlugin.ar(nil, 2, info: \myVst);  // <-- your plugin key from pluginList
        OffsetOut.ar(out, DirtPan.ar(sig, ~dirt.numChannels, pan, env * amp));
    }).add;
    s.sync;

    ~dirt.start(57120, [0, 0]);   // listen on the port server.js forwards to
};
)
```

### 5.3 Open the plugin and route Strudel to it

**VST effect on an orbit (sample-accurate — recommended where it fits).** Process
SuperCollider/sample output through a VST reverb, compressor, etc.:

```supercollider
(
SynthDef(\vstFx, { |out|
    var sig = In.ar(out, ~dirt.numChannels);
    sig = VSTPlugin.ar(sig, ~dirt.numChannels, info: \myFxPlugin);
    ReplaceOut.ar(out, sig);
}).add;
~fx = VSTPluginController(Synth.after(~dirt.orbits[0].group, \vstFx,
        [\out, ~dirt.orbits[0].dryBus])).open("MyReverb.vst3");
)
```

**VST instrument, per note.** Instantiate a persistent controller for the `\vsti`
synth and open the plugin:

```supercollider
~vsti = VSTPluginController(Synth.head(s, \vsti, [\out, 0])).open("MyPiano.vst3", verbose: true);
```

Then, from **Strudel**, select the synth by name via the `s` control and send over OSC:

```javascript
note("c e g a").s("vsti").osc()
```

`s("vsti")` makes SuperDirt route the event to your `\vsti` SynthDef, and `.osc()`
ships it (with the time tag) through the bridge from §3.

---

## 6. The per-note VST-instrument timing caveat

Here is the honest, slightly ironic part for a project whose whole goal is tight
timing:

- **VST effects** and **SuperCollider's own synths** are **sample-accurate**. The
  event arrives as a timestamped OSC bundle, SuperDirt schedules node creation in a
  time-tagged bundle to `scsynth`, and the server honors it to the sample.
- **VST instruments, per note,** carry a small **residual jitter**. The note-on/off
  has to reach the plugin via `VSTPluginController`, whose MIDI is sent from the
  **language** (`sclang`) — *outside* the precisely time-tagged server bundle. That
  last language→VST hop adds small, undefined latency. The SuperCollider/Tidal
  community treats robust per-note VSTi hosting as a known rough edge ("proof of
  concept"); the most developed effort to study is **TidalVST**, which rides
  `/dirt/play` with an `oLatency` offset and maps VST parameters.

This is still **far better than loopMIDI/WinMM**: it is one machine, no virtual MIDI
port, no OS MIDI stack, and the event reaches SuperCollider at the right time via the
time tag. Only the final in-process MIDI dispatch to the plugin is uncompensated — and
that is the *only* place where a small custom scheduler could still earn its keep.

---

## 7. If you still want a custom proxy

A "desktop proxy buffer" that stabilizes Strudel's output is a legitimate
architecture — it is, in essence, what SuperDirt already does for the OSC path. If you
build one anyway (e.g. to drive a specific DAW, or to schedule MIDI to a VST via a
better OS MIDI API), the key design rule is:

> **Consume Strudel's already-computed `targetTime`; do not re-derive timing.**

Strudel hands you `targetTime` for free on the OSC path (the `timestamp` field, §3),
and you can expose the same on a custom WebSocket output by following the
`onTrigger(hap, currentTime, cps, targetTime)` pattern (see
[`extending-strudel.md`](./extending-strudel.md) and the `docs/strudel-laser` example
— *propagate `targetTime`, never fire "now"*). The proxy then becomes a simple
priority queue: receive `{event, targetTime}`, hold it, and emit at `targetTime` using
a high-resolution local scheduler (and, on Windows, a MIDI API that honors output
timestamps). You are not rebuilding the clock — you are extending its reach by one
hop.

---

## 8. Quick reference

| Thing | Value / location |
| --- | --- |
| `targetTime` formula | `packages/core/cyclist.mjs:64` |
| Trigger fan-out | `getTrigger`, `packages/core/repl.mjs:563` |
| MIDI note send | `sendNote` → `scheduleAtTime(playNote, targetTime)`, `packages/midi/midi.mjs:265,278` |
| MIDI is `prototype`, not `register` | `Pattern.prototype.midi`, `packages/midi/midi.mjs:294` |
| Audio-thread timer | `scheduleAtTime` / `webAudioTimeout`, `packages/superdough/helpers.mjs:366,372` |
| OSC trigger | `oscTrigger`, `packages/osc/osc.mjs:60`; registered `osc.mjs:86` |
| OSC timestamp build | `collator.calculateTimestamp(...) * 1000`, `packages/osc/osc.mjs:64` |
| OSC bridge ports | WS `8080` → UDP `127.0.0.1:57120`, `packages/osc/server.js:14,16` |
| OSC bundle time tag | `osc.timeTag(0, timestamp)`, `packages/osc/server.js:51-52` |
| Run the bridge | `node packages/osc/server.js` |

**External references**

- [VSTPlugin — SuperCollider Help](https://depts.washington.edu/dxscdoc/Help/Classes/VSTPlugin.html)
- [VSTPluginController — SuperCollider Help](https://depts.washington.edu/dxscdoc/Help/Classes/VSTPluginController.html)
- [SuperDirt + VSTPlugin integration (scsynth.org)](https://scsynth.org/t/superdirt-and-vstplugin-integration/2868)
- [Using VSTPlugin with Tidal (Tidal Club)](https://uzu.lurk.org/t/using-vstplugin-with-tidal/2352)
- [TidalVST](https://github.com/thgrund/TidalVST)

---

*See also: [`clock-and-timing.md`](./clock-and-timing.md) for how `targetTime` is
computed, and [`extending-strudel.md`](./extending-strudel.md) for writing your own
output via `onTrigger`.*
