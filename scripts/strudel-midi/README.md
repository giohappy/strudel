# strudel-midi

Headless renderer that evaluates Strudel code (no audio, no scheduler), extracts each
track's events by querying it over a time span, and writes a Standard MIDI File.

## Files

- `smf.mjs` — pure, dependency-free: hap→MIDI-event mapping (`extractEvents`) and a
  Standard MIDI File writer (`buildMidiFile`, `vlq`). No `@strudel/*` imports.
- `strudel2midi.mjs` — Strudel-facing runner: loads builtins, captures `$:`/`label:`
  tracks, queries them, and writes the `.mid`. Exposes `strudelToMidi(code, opts)` and a CLI.
- `smf.test.mjs` — `node smf.test.mjs` (no workspace install needed).

## CLI

```sh
node scripts/strudel-midi/strudel2midi.mjs song.js out.mid --cycles 8 --cps 0.5 --beatsPerCycle 4
```

## Programmatic (works in Node and the browser)

```js
import { strudelToMidi } from './strudel2midi.mjs';

const code = `
drums: s("bd sd")
bass:  note("c2 <eb2 g2>").s("sawtooth")
auto:  cc(74, sine.segment(16))
`;

const { tracks, warnings, bytes } = await strudelToMidi(code, {
  cycles: 8,
  cps: 0.5,           // cycles per second; BPM = beatsPerCycle * cps * 60
  beatsPerCycle: 4,
  soundMap: { bd: 36, sd: 38, hh: 42 }, // map sample names -> MIDI notes
  skipUnmappedSounds: true,             // otherwise drum hits with no note are dropped (with a warning)
});

// `bytes` is a Uint8Array.
// Node:    (await import('node:fs')).writeFileSync('out.mid', bytes)
// Browser: const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/midi' }))
```

## Environment support

Both modules are isomorphic:

- `smf.mjs` uses only `Math`, bitwise ops and `Uint8Array` — runs anywhere.
- `strudel2midi.mjs`'s importable API (`strudelToMidi`, `captureTracks`) uses no Node-only
  APIs. The file system (`node:fs`) is imported lazily and the CLI entrypoint is guarded by
  `typeof process !== 'undefined'`, so importing the module in a browser never touches
  `process` or `fs`. `@strudel/core` and `@strudel/transpiler` are browser-first.

**Caveat (browser):** `captureTracks` temporarily overrides `Pattern.prototype.p` (and
restores it) to harvest tracks during `evaluate()`. Use it for one-shot exports rather than
concurrently with a live REPL evaluation, which also relies on `.p()`.

## How tracks are captured

The transpiler rewrites `name: pattern` into `pattern.p('name')` (and `$:` into `.p('$')`).
`.p()` is normally injected by the live-coding repl; here the runner installs its own
capturing `.p()`, so after `evaluate()` you have one queryable `Pattern` per track.
Each track becomes one MIDI track.

## Event mapping rules (`extractEvents`)

- **Notes**: from `note`/`freq` (and `soundMap`-mapped `s`). Only emitted at `hasOnset()`,
  so notes are not double-counted. **Multicycle notes are supported** — duration comes from
  the note's `whole`, which may span several cycles.
- **Sounds**: a hap with no note but an `s` is looked up in `soundMap`. Unmapped sounds are
  skipped (with a warning) when `skipUnmappedSounds` is true.
- **Control change (`cc`)**: from `ccn` + `ccv` (set via `control()`, `.ccn()/.ccv()`, or the
  `cc(ccn, ccv)` helper). `ccv` is `0..1`, scaled to `0..127`, matching `@strudel/midi`.
  - A CC value is only emitted if it is **timed** (has a `whole`): use `segment(n)` or place
    it inside a discrete pattern. An **untimed** continuous signal (no `whole`) is skipped
    with a warning.
  - CC density follows the **structural** (leftmost) pattern. The `cc(ccn, ccv)` helper makes
    the value pattern structural, so `cc(74, sine.segment(16))` yields 16 events/cycle.
- **Velocity** = `gain * velocity` (defaults `1 * 0.9`), scaled to `0..127`.
- **Channel** from `midichan`/`channel` (1-based), mapped to the 0–15 MIDI nibble.

Continuous controls without `ccn`/`ccv` (e.g. raw `lpf(sine)`) are not MIDI notes and are
ignored; route them through `cc()` if you want CC automation.
