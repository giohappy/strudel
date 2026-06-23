/*
smf.mjs - dependency-free Standard MIDI File writer + Strudel-hap -> MIDI-event mapping.

This module is intentionally pure: it does NOT import @strudel/*. It operates on
plain "hap-like" objects so it can be unit tested without installing the workspace.

A hap-like object only needs:
  - hap.whole  : { begin, end } | undefined   (begin/end expose .valueOf() -> cycles)
  - hap.value  : the controls object ({ note, s, ccn, ccv, gain, ... })
  - hap.hasOnset() : boolean
  - hap.duration   : { valueOf() -> cycles }   (the *whole* duration, may be > 1 cycle)
*/

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const num = (x) => (typeof x?.valueOf === 'function' ? x.valueOf() : x);

// Default note resolver: handles numeric note and freq only.
// String note names (e.g. "c4") require an injected resolver (e.g. @strudel/core's valueToMidi),
// because parsing them needs the note table that lives in core.
export function defaultResolveNote(value) {
  if (typeof value.freq === 'number') {
    return (12 * Math.log(value.freq / 440)) / Math.LN2 + 69;
  }
  if (typeof value.note === 'number') {
    return value.note;
  }
  return undefined;
}

/**
 * Map Strudel haps to a flat list of MIDI events ({type:'note'|'cc', tick, ...}).
 * Returns { events, warnings }.
 *
 * Options:
 *  - cps, beatsPerCycle, ppq : timing. ticksPerCycle = ppq * beatsPerCycle.
 *  - defaultChannel (1-based), defaultVelocity (0..1), defaultGain (0..1)
 *  - soundMap : { [s]: midiNote } - map sample/sound names to a MIDI note number
 *  - skipUnmappedSounds : if true (default), sound haps with no note and no soundMap entry are skipped (with a warning)
 *  - resolveNote : (value) => midiNumber | undefined   (injected; falls back to defaultResolveNote)
 *  - warn : (msg) => void
 */
export function extractEvents(haps, options = {}) {
  const {
    beatsPerCycle = 4,
    ppq = 480,
    defaultChannel = 1,
    defaultVelocity = 0.9,
    defaultGain = 1,
    soundMap = {},
    skipUnmappedSounds = true,
    resolveNote = defaultResolveNote,
    warn = () => {},
  } = options;

  const ticksPerCycle = ppq * beatsPerCycle;
  const events = [];
  const warnings = [];
  const note = (msg) => {
    warnings.push(msg);
    warn(msg);
  };

  const channelOf = (v) => clamp(Math.round((v.midichan ?? v.channel ?? defaultChannel) - 1), 0, 15);

  for (const hap of haps) {
    const v = hap.value ?? {};
    const hasWhole = hap.whole != null;

    // ---- Control change (cc) -------------------------------------------------
    // Produced by control([ccn, ccv]) / .ccn().ccv() (and the cc() helper in the runner).
    // ccv is 0..1 in Strudel and scaled to 0..127, mirroring @strudel/midi.
    if (v.ccn !== undefined && v.ccv !== undefined) {
      if (!hasWhole) {
        // Continuous signal with no timing structure: needs segment() or an outer
        // discrete pattern to become a timed event. Skip rather than guess.
        note(`cc: skipping untimed value (no whole) for ccn=${v.ccn} - use .segment(n) or an outer pattern`);
        continue;
      }
      if (!hap.hasOnset()) continue; // ignore fragments split across the query window
      if (typeof v.ccv !== 'number') {
        note(`cc: skipping non-numeric ccv for ccn=${v.ccn}`);
        continue;
      }
      events.push({
        type: 'cc',
        tick: Math.round(num(hap.whole.begin) * ticksPerCycle),
        ccn: clamp(Math.round(v.ccn), 0, 127),
        ccv: clamp(Math.round(v.ccv * 127), 0, 127),
        channel: channelOf(v),
      });
      continue;
    }

    // ---- Note ----------------------------------------------------------------
    let midi = resolveNote(v);

    if (midi === undefined && v.s !== undefined) {
      // Optional sound mapping: map a sample/sound name to a MIDI note.
      if (Object.prototype.hasOwnProperty.call(soundMap, v.s)) {
        midi = soundMap[v.s];
      } else if (skipUnmappedSounds) {
        note(`sound: skipping unmapped sound "${v.s}" (add it to soundMap to include it)`);
        continue;
      } else {
        continue;
      }
    }

    if (midi === undefined) continue; // nothing note-like and nothing mappable

    if (!hasWhole) {
      note(`note: skipping untimed note value (no whole)`);
      continue;
    }
    // Only emit at the onset. Multicycle notes are still supported: a note whose
    // whole spans several cycles onsets once, and hap.duration covers the full whole.
    if (!hap.hasOnset()) continue;

    const gain = typeof v.gain === 'number' ? v.gain : defaultGain;
    const velocity = typeof v.velocity === 'number' ? v.velocity : defaultVelocity;
    const durationTicks = Math.max(1, Math.round(num(hap.duration) * ticksPerCycle));

    events.push({
      type: 'note',
      tick: Math.round(num(hap.whole.begin) * ticksPerCycle),
      durationTicks,
      midi: clamp(Math.round(midi), 0, 127),
      velocity: clamp(Math.round(gain * velocity * 127), 0, 127),
      channel: channelOf(v),
    });
  }

  return { events, warnings };
}

// ---- Standard MIDI File encoding -------------------------------------------

// Variable Length Quantity (MIDI delta-time encoding).
export function vlq(value) {
  if (value < 0) throw new Error('vlq: value must be >= 0');
  let buffer = value & 0x7f;
  while ((value >>= 7)) {
    buffer <<= 8;
    buffer |= (value & 0x7f) | 0x80;
  }
  const bytes = [];
  while (true) {
    bytes.push(buffer & 0xff);
    if (buffer & 0x80) buffer >>= 8;
    else break;
  }
  return bytes;
}

function str(s) {
  return [...s].map((c) => c.charCodeAt(0) & 0xff);
}
function u16(n) {
  return [(n >> 8) & 0xff, n & 0xff];
}
function u32(n) {
  return [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
function chunk(id, data) {
  return [...str(id), ...u32(data.length), ...data];
}

// Turn a track's events into raw MTrk bytes (with note-off pairs and delta times).
function trackBytes(name, events, { tempoMicros } = {}) {
  // Expand notes into on/off, keep cc as-is.
  const timed = [];
  for (const e of events) {
    if (e.type === 'note') {
      timed.push({ tick: e.tick, order: 1, bytes: [0x90 | e.channel, e.midi, e.velocity] });
      timed.push({ tick: e.tick + e.durationTicks, order: 0, bytes: [0x80 | e.channel, e.midi, 0] });
    } else if (e.type === 'cc') {
      timed.push({ tick: e.tick, order: 0, bytes: [0xb0 | e.channel, e.ccn, e.ccv] });
    }
  }
  // Stable sort by tick, then note-offs / cc (order 0) before note-ons (order 1).
  timed.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const data = [];
  if (name) data.push(...vlq(0), 0xff, 0x03, ...vlq(name.length), ...str(name));
  if (typeof tempoMicros === 'number') {
    data.push(...vlq(0), 0xff, 0x51, 0x03, (tempoMicros >> 16) & 0xff, (tempoMicros >> 8) & 0xff, tempoMicros & 0xff);
  }

  let last = 0;
  for (const ev of timed) {
    const delta = ev.tick - last;
    last = ev.tick;
    data.push(...vlq(delta), ...ev.bytes);
  }
  data.push(...vlq(0), 0xff, 0x2f, 0x00); // end of track
  return chunk('MTrk', data);
}

/**
 * Build a Standard MIDI File (format 1) as a Uint8Array.
 * tracks: [{ name, events }]  (events from extractEvents)
 * opts: { ppq, cps, beatsPerCycle }  (tempo is derived: BPM = beatsPerCycle * cps * 60)
 */
export function buildMidiFile(tracks, opts = {}) {
  const { ppq = 480, cps = 0.5, beatsPerCycle = 4 } = opts;
  const bpm = beatsPerCycle * cps * 60;
  const tempoMicros = Math.round(60000000 / bpm);

  const trackChunks = tracks.map((t, i) =>
    // Put the tempo meta on the first track.
    trackBytes(t.name, t.events, i === 0 ? { tempoMicros } : {}),
  );

  const header = chunk('MThd', [...u16(1), ...u16(trackChunks.length), ...u16(ppq)]);
  return Uint8Array.from([...header, ...trackChunks.flat()]);
}
