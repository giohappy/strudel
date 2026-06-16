// End-to-end integration test for @yourname/strudel-laser against real @strudel/core.
// Loads the BUILT dist artifact (not the source) to validate the published package.
import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import { evalScope } from '@strudel/core';

mini.miniAllStrings(); // activate mini-notation string parsing (as the REPL does)

const { note } = core;

let failures = 0;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name} ${detail}`);
    failures++;
  }
}

// --- Mock WebSocket so .laser() can run without a real server -----------------
const sent = [];
class MockWebSocket {
  static OPEN = 1;
  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.OPEN;
    this._listeners = {};
    // fire 'open' on next tick
    queueMicrotask(() => this._listeners.open?.());
  }
  addEventListener(type, cb) {
    this._listeners[type] = cb;
  }
  send(data) {
    sent.push(JSON.parse(data));
  }
}
globalThis.WebSocket = MockWebSocket;

// --- Load the BUILT package via evalScope (mirrors REPL: exports -> globalThis) ---
console.log('\n# Loading built dist/index.mjs via evalScope (registers side effects)');
const [mod] = await evalScope(import('./dist/index.mjs'));
check('module exports beam + strobe', typeof mod.beam === 'function' && typeof mod.strobe === 'function');
check('functions injected into globalThis (REPL scope)', typeof globalThis.beam === 'function' && typeof globalThis.strobe === 'function');
check('chainable methods installed on Pattern.prototype (incl. direct .laser)',
  typeof core.Pattern.prototype.beam === 'function' &&
  typeof core.Pattern.prototype.strobe === 'function' &&
  typeof core.Pattern.prototype.laser === 'function');

// --- Test 1: the new multi-key control `beam` --------------------------------
console.log('\n# Test 1: control beam("red:0.8") merges { beam, focus } into the value');
{
  const haps = note('c').beam('red:0.8').queryArc(0, 1);
  check('one event in cycle', haps.length === 1, `got ${haps.length}`);
  check('value = {note,beam,focus}', eq(haps[0].value, { note: 'c', beam: 'red', focus: 0.8 }), JSON.stringify(haps[0].value));
  // alias works too
  const aliasHaps = note('c').laserbeam('green:1').queryArc(0, 1);
  check('alias .laserbeam() works', aliasHaps[0].value.beam === 'green');
}

// --- Test 2: the pure pattern function `strobe` ------------------------------
console.log('\n# Test 2: .strobe(4) retriggers each of 3 notes 4x = 12, tags strobe:4');
{
  const haps = note('c e g').strobe(4).queryArc(0, 1);
  check('12 events per cycle (3 notes x4)', haps.length === 12, `got ${haps.length}`);
  check('every event tagged strobe:4', haps.every((h) => h.value.strobe === 4));
  check('standalone form strobe(2, pat) works', mod.strobe(2, note('c')).queryArc(0, 1).length === 2);
  // purity: querying the same window twice yields identical haps
  const a = note('c e').strobe(3).queryArc(0, 1).map((h) => h.value);
  const b = note('c e').strobe(3).queryArc(0, 1).map((h) => h.value);
  check('referential transparency: same window -> same haps', eq(a, b));
}

// --- Test 3: the onTrigger output `.laser()` ---------------------------------
console.log('\n# Test 3: .laser(host) attaches a dominant trigger and sends WS messages');
{
  const pat = note('c4 e4').beam('blue').laser('ws://localhost:9999');
  const cps = 1;
  const haps = pat.queryArc(0, 1);
  check('dominantTrigger flag set (suppresses default audio)', haps.every((h) => h.context.dominantTrigger === true));
  check('onTrigger attached to every hap', haps.every((h) => typeof h.context.onTrigger === 'function'));

  // Replicate what getTrigger does: call hap.context.onTrigger(hap, currentTime, cps, targetTime)
  sent.length = 0;
  for (const hap of haps) {
    if (hap.hasOnset()) {
      const targetTime = hap.whole.begin.valueOf() / cps;
      await hap.context.onTrigger(hap, 0, cps, targetTime);
    }
  }
  // give the awaited connect() microtasks a moment
  await new Promise((r) => setTimeout(r, 10));

  check('2 messages sent over WebSocket', sent.length === 2, `got ${sent.length}`);
  check('messages carry numeric midinote', sent.every((m) => typeof m.midinote === 'number'));
  check('messages carry beam:"blue", focus default 1', sent.every((m) => m.beam === 'blue' && m.focus === 1));
  check('messages carry durationSec + targetTime + cps', sent.every((m) => 'durationSec' in m && 'targetTime' in m && m.cps === 1));
  console.log('  sample message:', JSON.stringify(sent[0]));
}

console.log(`\n${failures === 0 ? '🎉 ALL CHECKS PASSED' : `💥 ${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
