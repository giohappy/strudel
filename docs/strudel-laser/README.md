# @yourname/strudel-laser — worked example

This is the **complete, build-tested** companion package for *Example B* in
[`../technical-manual/extending-strudel.md`](../technical-manual/extending-strudel.md#example-b--a-standalone-remotely-installable-package).

It is a standalone Strudel extension (i.e. **not** part of the Strudel monorepo)
that demonstrates the three ways to extend Strudel from an external package:

| File | What it shows |
|---|---|
| `laser.mjs` | a new control (`beam`/`focus` + `laserbeam` alias), a pure pattern function (`.strobe(n)`, built on `ply`), and a custom `onTrigger` WebSocket output (`.laser(host)`) |
| `index.mjs` | the side-effect barrel (`import './laser.mjs'; export *`) |
| `vite.config.js` | a library build that keeps `@strudel/core` **external** (never bundled) |
| `package.json` | the `publishConfig.main → dist/index.mjs` convention used by the real Strudel packages |
| `e2e-test.mjs` | an end-to-end integration test against the real `@strudel/core` |

## Build

```bash
npm install
npm run build      # -> dist/index.mjs, with @strudel/core left external
```

## Test

`e2e-test.mjs` loads the built `dist/index.mjs` via `evalScope` (exactly as the
REPL would), then queries patterns and drives the `onTrigger` path with a mocked
WebSocket. It validates: control merging + aliasing, the pure function and its
referential transparency, and that `.laser()` sets `dominantTrigger` and emits
correctly-shaped messages.

```bash
node e2e-test.mjs
```

> The test resolves `@strudel/core` and `@strudel/mini` from `node_modules`. When
> run standalone, `npm install` provides them; inside this repo you can instead
> symlink them from `packages/` (see the guide). Either way the package code is
> unchanged — that is the point of keeping core external.

## Use in a REPL

```js
await evalScope(import('@yourname/strudel-laser')); // or a CDN URL

note("c3 e3 g3").beam("red:0.8").strobe(4).laser("ws://localhost:9000")
```

To actually drive hardware you would run a tiny Node WebSocket→device bridge,
mirroring `packages/osc/server.js`.
