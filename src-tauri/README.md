# @strudel/tauri

Rust source files for building native desktop apps using Tauri

## Usage

Install [Rust](https://rustup.rs/) on your system.

From the project root:

- install Strudel dependencies

```js
pnpm i
```

- to run Strudel for development

```js
pnpm tauri dev
```

- to build the binary and installer/bundle

```js
pnpm tauri build
```

The binary and installer can be found in the 'src-tauri/target/release/bundle' directory

## Configuring MIDI and OSC

The desktop app talks to MIDI and OSC through two native bridges (`src/midibridge.rs`
and `src/oscbridge.rs`), driven from the pattern methods `.midi()` and `.osc()`.

### MIDI

At startup the bridge opens **every** available MIDI _output_ port on the system and
connects to all of them. Messages are routed to a port by the name you pass to `.midi()`:

1. first by an **exact** match against a port name, then
2. by a **substring** match (`port_name.contains(requested)`), so a partial name works.

If you call `.midi()` with no argument it defaults to `'IAC'` (the macOS IAC Driver).
**There is no IAC driver on Windows or Linux**, so on those platforms you must pass the
name of a virtual MIDI port explicitly.

```js
note("c a f e").midi('IAC Driver Bus 1') // macOS, IAC Driver
note("c a f e").midi('loopMIDI Port')    // Windows, loopMIDI
note("c a f e").midi('loopMIDI')         // substring match also works
note("c a f e").midichan(2).midi('loopMIDI Port') // channel 1–16 (default 1)
```

**Setting up a loopback port:**

- **macOS** — enable the IAC Driver in _Audio MIDI Setup → MIDI Studio_.
- **Windows** — install [loopMIDI](https://www.tobias-erichsen.de/software/loopmidi.html)
  and create a port (default name `loopMIDI Port`).
- **Linux** — use ALSA's virtual MIDI (`sudo modprobe snd-virmidi`) or a tool like
  `a2jmidid` / your DAW's virtual port.

Then point your receiver (DAW / synth / hardware) at the same port as its MIDI _input_.

To see the exact port names, open the in-app **Console** panel: on startup the bridge logs
`Found N midi devices!` followed by each port name. If you see _"No MIDI devices found"_,
no MIDI output port was visible.

> Note: ports are enumerated **once at startup**. Create your loopback port _before_
> launching Strudel — if you add it later you must restart the app for it to appear.

### OSC

The OSC bridge is not configurable from the pattern. It binds locally to
`127.0.0.1:57122` and sends to `127.0.0.1:57120`, which is [SuperDirt](https://github.com/musikinformatik/SuperDirt)'s
default listening port. Each message is sent as an OSC bundle whose timetag carries the
scheduling information, so SuperDirt handles the timing.

```js
s("bd sd").osc() // sends to SuperDirt on 127.0.0.1:57120
```

Just make sure SuperDirt is running and listening on port 57120.
