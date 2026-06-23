/*
Pure tests for smf.mjs - runnable with plain `node smf.test.mjs` (no @strudel install needed).
Uses hand-built hap-like objects to exercise the mapping rules.
*/
import assert from 'node:assert/strict';
import { extractEvents, buildMidiFile, vlq } from './smf.mjs';

// Minimal hap-like factory. begin/end/dur are in cycles.
function hap({ begin, end, value, partBegin = begin }) {
  const whole = begin == null ? undefined : { begin: { valueOf: () => begin }, end: { valueOf: () => end } };
  return {
    whole,
    value,
    duration: { valueOf: () => (end ?? begin) - begin },
    hasOnset: () => whole != null && whole.begin.valueOf() === partBegin,
  };
}

const opts = { ppq: 480, beatsPerCycle: 4 }; // ticksPerCycle = 1920

// --- vlq encoding (spec examples) ---
assert.deepEqual(vlq(0), [0x00]);
assert.deepEqual(vlq(127), [0x7f]);
assert.deepEqual(vlq(128), [0x81, 0x00]);
assert.deepEqual(vlq(0x100000), [0xc0, 0x80, 0x00]);

// --- multicycle note: spans 3 cycles, single onset, full duration ---
{
  const { events } = extractEvents([hap({ begin: 2, end: 5, value: { note: 60 } })], opts);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'note');
  assert.equal(events[0].midi, 60);
  assert.equal(events[0].tick, 2 * 1920);
  assert.equal(events[0].durationTicks, 3 * 1920); // 3 cycles, not clamped to 1
}

// --- fragmented part (no onset) is skipped, multicycle still counted once ---
{
  const haps = [
    hap({ begin: 0, end: 3, value: { note: 62 }, partBegin: 1 }), // fragment, no onset
    hap({ begin: 0, end: 3, value: { note: 62 }, partBegin: 0 }), // real onset
  ];
  const { events } = extractEvents(haps, opts);
  assert.equal(events.length, 1);
  assert.equal(events[0].durationTicks, 3 * 1920);
}

// --- velocity = gain * velocity, channel is 1-based -> 0-based nibble ---
{
  const { events } = extractEvents([hap({ begin: 0, end: 1, value: { note: 64, gain: 0.5, velocity: 0.8, midichan: 3 } })], opts);
  assert.equal(events[0].velocity, Math.round(0.5 * 0.8 * 127));
  assert.equal(events[0].channel, 2);
}

// --- cc: timed (whole present) -> emitted, ccv 0..1 scaled to 0..127 ---
{
  const { events } = extractEvents([hap({ begin: 0, end: 0.25, value: { ccn: 74, ccv: 0.5 } })], opts);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'cc');
  assert.equal(events[0].ccn, 74);
  assert.equal(events[0].ccv, Math.round(0.5 * 127)); // 64
}

// --- cc: untimed (no whole) -> skipped + warning ---
{
  const { events, warnings } = extractEvents([hap({ begin: null, value: { ccn: 74, ccv: 0.9 } })], opts);
  assert.equal(events.length, 0);
  assert.match(warnings[0], /no whole/);
}

// --- sound mapping: mapped -> note, unmapped -> skipped by default ---
{
  const haps = [
    hap({ begin: 0, end: 0.5, value: { s: 'bd' } }),
    hap({ begin: 0.5, end: 1, value: { s: 'mystery' } }),
  ];
  const { events, warnings } = extractEvents(haps, { ...opts, soundMap: { bd: 36 } });
  assert.equal(events.length, 1);
  assert.equal(events[0].midi, 36);
  assert.match(warnings[0], /unmapped sound "mystery"/);
}

// --- string note requires injected resolver; default skips it ---
{
  const r = extractEvents([hap({ begin: 0, end: 1, value: { note: 'c4' } })], opts);
  assert.equal(r.events.length, 0); // default resolver can't parse "c4"
  const r2 = extractEvents([hap({ begin: 0, end: 1, value: { note: 'c4' } })], {
    ...opts,
    resolveNote: () => 72,
  });
  assert.equal(r2.events[0].midi, 72);
}

// --- SMF: valid header + two tracks, parseable lengths ---
{
  const { events } = extractEvents([hap({ begin: 0, end: 1, value: { note: 60 } })], opts);
  const bytes = buildMidiFile([{ name: 'a', events }, { name: 'b', events }], { ppq: 480, cps: 0.5, beatsPerCycle: 4 });
  const dec = new TextDecoder();
  assert.equal(dec.decode(bytes.slice(0, 4)), 'MThd');
  assert.equal(bytes[7], 6); // header length (u32 at bytes 4..7)
  assert.equal(bytes[9], 1); // format 1 (u16 at bytes 8..9)
  assert.equal(bytes[11], 2); // 2 tracks (u16 at bytes 10..11)
  // first MTrk right after the 14-byte header
  assert.equal(dec.decode(bytes.slice(14, 18)), 'MTrk');
}

console.log('all smf.mjs tests passed');
