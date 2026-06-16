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
// NOT via register(). Why: register() always reify()s a method's arguments
// (pattern.mjs:1813), so a connection URL like "ws://host:port" would be parsed
// as mini-notation and throw. Config-style args (ports, URLs, option objects)
// must bypass register and be handled by hand.
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
