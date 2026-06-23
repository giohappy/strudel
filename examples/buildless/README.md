# buildless examples

These examples show you how strudel can be used in a regular html file, without the need for a build tool.

Most examples are using [skypack](https://www.skypack.dev/)

## strudel-to-midi.html

Embeds the official `<strudel-editor>` REPL component, lets you set how many cycles to render,
and renders the code to a downloadable Standard MIDI File using `scripts/strudel-midi`
(no audio, no scheduler). Each labelled voice (`name:` / `$:`) becomes its own MIDI track.

Serve over http (modules + relative imports don't work from `file://`):

```sh
npx serve .            # from the repo root
# then open http://localhost:3000/examples/buildless/strudel-to-midi.html
```
