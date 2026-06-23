/*
strudel2midi.mjs - headless Strudel -> Standard MIDI File renderer.

Pipeline:
  1. load the Strudel builtins into globalThis (evalScope)
  2. capture the named tracks declared with `$:` / `name:` syntax by intercepting `.p()`
  3. transpile + evaluate the code (no scheduler, no audio)
  4. query each track over N cycles (the "Arc") to get its haps/events
  5. map haps -> MIDI events (notes + cc + optional sound mapping) and write a .mid file

Usage:
  node scripts/strudel-midi/strudel2midi.mjs <input.(js|txt)> [output.mid] [--cycles 8] [--cps 0.5]

Or programmatically (works in the browser too - returns a Uint8Array):
  import { strudelToMidi } from './strudel2midi.mjs';
  const { tracks, bytes, warnings } = await strudelToMidi(code, { cycles: 8, soundMap: { bd: 36 } });
  // browser: const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/midi' }));

This module is isomorphic: the importable API (strudelToMidi / captureTracks) uses no
Node-only APIs. The file system and CLI bits are loaded lazily and only run under Node.
*/
import { evalScope, evaluate, Pattern, valueToMidi, silence } from '@strudel/core';
import { transpiler } from '@strudel/transpiler';
import { extractEvents, buildMidiFile } from './smf.mjs';

let scopeReady;
async function ensureScope() {
  // load once; evalScope tolerates a module failing to load (it just warns)
  scopeReady ||= evalScope(
    import('@strudel/core'),
    import('@strudel/mini'),
    import('@strudel/tonal').catch(() => ({})),
  );
  await scopeReady;

  // Convenience CC helper so users can write `cc(74, sine.segment(16))`.
  // ccv is 0..1 in Strudel; the value pattern is made *structural* (placed left) so its
  // density drives the CC events. A continuous signal with no segment()/outer structure
  // stays "untimed" (no whole) and is skipped with a warning at extraction time.
  if (typeof globalThis.cc !== 'function' && typeof globalThis.ccv === 'function') {
    globalThis.cc = (ccn, ccv) => globalThis.ccv(ccv).ccn(ccn);
  }

  // Tempo/transport globals (setcps, hush, ...) normally live inside the live repl, not in
  // evalScope. Stub them as no-ops returning silence so pasted REPL tunes don't crash here.
  // Tempo is controlled via the cps/beatsPerCycle options instead. (all()/each() are captured
  // per-eval in captureTracks() and actually applied to the tracks.)
  for (const name of ['setcps', 'setCps', 'setcpm', 'setCpm', 'hush', 'all', 'each']) {
    if (typeof globalThis[name] !== 'function') {
      globalThis[name] = () => silence;
    }
  }
}

// Resolve note names ("c4"), numbers and freq via core; undefined when not note-like.
const resolveNote = (value) => {
  try {
    return valueToMidi(value);
  } catch {
    return undefined;
  }
};

/**
 * Evaluate Strudel code and capture the patterns declared with `$:` / `label:`,
 * plus any all()/each() transforms registered during evaluation.
 * Returns { tracks: { name: Pattern }, allTransforms: fn[], eachTransform: fn|undefined }.
 */
export async function captureTracks(code) {
  await ensureScope();

  const tracks = {};
  let anon = 0;
  const allTransforms = [];
  let eachTransform;

  // `.p()` is normally injected by the repl; headless we define our own capturing version.
  // The transpiler turns `name: pat` into `pat.p('name')` and `$: pat` into `pat.p('$')`.
  const prevP = Pattern.prototype.p;
  const prevAll = globalThis.all;
  const prevEach = globalThis.each;

  Pattern.prototype.p = function (id) {
    const key = String(id).includes('$') ? `$${anon++}` : String(id);
    tracks[key] = this;
    return this;
  };
  // Capture the repl combinators so strudelToMidi can apply them to the tracks.
  // (Like the repl, all() accumulates and each() keeps the last assignment.)
  globalThis.all = (transform) => {
    allTransforms.push(transform);
    return silence;
  };
  globalThis.each = (transform) => {
    eachTransform = transform;
    return silence;
  };

  try {
    await evaluate(code, transpiler);
  } finally {
    if (prevP) Pattern.prototype.p = prevP;
    else delete Pattern.prototype.p;
    globalThis.all = prevAll;
    globalThis.each = prevEach;
  }
  return { tracks, allTransforms, eachTransform };
}

/**
 * Render Strudel code to a Standard MIDI File.
 * options: { cycles, cps, beatsPerCycle, ppq, soundMap, skipUnmappedSounds,
 *            defaultChannel, defaultVelocity, defaultGain, warn }
 * Returns { tracks: { name: events[] }, warnings, bytes }.
 */
export async function strudelToMidi(code, options = {}) {
  const {
    cycles = 4,
    cps = 0.5,
    beatsPerCycle = 4,
    ppq = 480,
    warn = (m) => console.warn('[strudel2midi]', m),
    ...mapOptions
  } = options;

  const { tracks: patterns, allTransforms, eachTransform } = await captureTracks(code);
  const names = Object.keys(patterns);
  if (!names.length) {
    warn('no tracks found - declare patterns with `$:` or `name:` so they are captured');
  }

  const eventsByTrack = {};
  const midiTracks = [];
  const allWarnings = [];
  for (const name of names) {
    // each() applies per labelled track; all() applies on top (repl order: each, then all).
    // Applied per-track to keep one MIDI track per voice - identical to the repl for transforms
    // that distribute over stack (fast/slow/rev/gain/lpf/ply/...). Transforms intended to act on
    // the merged stack (e.g. arp on a combined chord) will instead act per track.
    let pat = patterns[name];
    if (eachTransform) pat = eachTransform(pat);
    for (const transform of allTransforms) pat = transform(pat);
    const haps = pat.queryArc(0, cycles);
    const { events, warnings } = extractEvents(haps, {
      cps,
      beatsPerCycle,
      ppq,
      resolveNote,
      warn: (m) => warn(`${name}: ${m}`),
      ...mapOptions,
    });
    eventsByTrack[name] = events;
    allWarnings.push(...warnings.map((w) => `${name}: ${w}`));
    midiTracks.push({ name, events });
  }

  const bytes = buildMidiFile(midiTracks, { ppq, cps, beatsPerCycle });
  return { tracks: eventsByTrack, warnings: allWarnings, bytes };
}

// ---- CLI -------------------------------------------------------------------
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) flags[a.slice(2)] = argv[++i];
    else positional.push(a);
  }
  return { positional, flags };
}

async function main() {
  // Node-only deps are imported lazily so this module stays browser-safe.
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const input = positional[0];
  if (!input) {
    console.error('usage: node strudel2midi.mjs <input.js> [output.mid] [--cycles N] [--cps C] [--beatsPerCycle B]');
    process.exit(1);
  }
  const output = positional[1] || input.replace(/\.[^.]+$/, '') + '.mid';
  const code = readFileSync(input, 'utf8');

  const { tracks, warnings, bytes } = await strudelToMidi(code, {
    cycles: flags.cycles ? Number(flags.cycles) : undefined,
    cps: flags.cps ? Number(flags.cps) : undefined,
    beatsPerCycle: flags.beatsPerCycle ? Number(flags.beatsPerCycle) : undefined,
  });

  writeFileSync(output, bytes);
  const counts = Object.entries(tracks)
    .map(([n, e]) => `${n}=${e.length}`)
    .join(', ');
  console.log(`wrote ${output} (${bytes.length} bytes) - tracks: ${counts || 'none'}`);
  if (warnings.length) console.log(`${warnings.length} warning(s)`);
}

// Run as a CLI only under Node when invoked directly. Guarded so importing this
// module in a browser never touches `process`.
const isNodeCli =
  typeof process !== 'undefined' &&
  process.argv?.[1] &&
  import.meta.url === `file://${process.argv[1]}`;
if (isNodeCli) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
