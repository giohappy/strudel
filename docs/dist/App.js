import React, {useCallback, useEffect, useLayoutEffect, useRef, useState} from "../_snowpack/pkg/react.js";
import logo from "./logo.svg.proxy.js";
import cx from "./cx.js";
import * as Tone from "../_snowpack/pkg/tone.js";
import useCycle from "./useCycle.js";
import * as tunes from "./tunes.js";
import {evaluate} from "./evaluate.js";
import CodeMirror from "./CodeMirror.js";
import hot from "../hot.js";
import {isNote} from "../_snowpack/pkg/tone.js";
import {useWebMidi} from "./midi.js";
const [_, codeParam] = window.location.href.split("#");
const decoded = atob(codeParam || "");
const getHotCode = async () => {
  return fetch("/hot.js").then((res) => res.text()).then((src) => {
    return src.split("export default").slice(-1)[0].trim();
  });
};
const defaultSynth = new Tone.PolySynth().chain(new Tone.Gain(0.5), Tone.Destination);
defaultSynth.set({
  oscillator: {type: "triangle"},
  envelope: {
    release: 0.01
  }
});
function getRandomTune() {
  const allTunes = Object.values(tunes);
  const randomItem = (arr) => arr[Math.floor(Math.random() * arr.length)];
  return randomItem(allTunes);
}
const randomTune = getRandomTune();
function App() {
  const [mode, setMode] = useState("javascript");
  const [code, setCode] = useState(decoded || randomTune);
  const [log, setLog] = useState("");
  const logBox = useRef();
  const [error, setError] = useState();
  const [pattern, setPattern] = useState();
  const [activePattern, setActivePattern] = useState();
  const activatePattern = (_pattern = pattern) => {
    setActivePattern(() => _pattern);
    window.location.hash = "#" + btoa(code);
    !cycle.started && cycle.start();
  };
  const [isHot, setIsHot] = useState(false);
  const pushLog = (message) => setLog((log2) => log2 + `${log2 ? "\n\n" : ""}${message}`);
  const logCycle = (_events, cycle2) => {
    if (_events.length) {
      pushLog(`# cycle ${cycle2}
` + _events.map((e) => e.show()).join("\n"));
    }
  };
  const cycle = useCycle({
    onEvent: useCallback((time, event) => {
      try {
        if (!event.value?.onTrigger) {
          const note = event.value?.value || event.value;
          if (!isNote(note)) {
            throw new Error("not a note: " + note);
          }
          defaultSynth.triggerAttackRelease(note, event.duration, time);
        } else {
          const {onTrigger} = event.value;
          onTrigger(time, event);
        }
      } catch (err) {
        console.warn(err);
        err.message = "unplayable event: " + err?.message;
        pushLog(err.message);
      }
    }, []),
    onQuery: useCallback((span) => {
      try {
        return activePattern?.query(span) || [];
      } catch (err) {
        setError(err);
        return [];
      }
    }, [activePattern]),
    onSchedule: useCallback((_events, cycle2) => logCycle(_events, cycle2), [activePattern]),
    ready: !!activePattern
  });
  useLayoutEffect(() => {
    const handleKeyPress = (e) => {
      if (e.ctrlKey || e.altKey) {
        switch (e.code) {
          case "Enter":
            activatePattern();
            break;
          case "Period":
            cycle.stop();
        }
      }
    };
    document.addEventListener("keypress", handleKeyPress);
    return () => document.removeEventListener("keypress", handleKeyPress);
  }, [pattern]);
  useEffect(() => {
    let _code = code;
    if (isHot) {
      if (typeof hot !== "string") {
        getHotCode().then((_code2) => {
          setCode(_code2);
          setMode("javascript");
        });
        activatePattern(hot);
        return;
      } else {
        _code = hot;
        setCode(_code);
      }
    }
    try {
      const parsed = evaluate(_code);
      setPattern(() => parsed.pattern);
      if (isHot) {
        activatePattern(parsed.pattern);
      }
      setMode(parsed.mode);
      setError(void 0);
    } catch (err) {
      console.warn(err);
      setError(err);
    }
  }, [code, isHot]);
  useLayoutEffect(() => {
    logBox.current.scrollTop = logBox.current?.scrollHeight;
  }, [log]);
  useWebMidi({
    ready: useCallback(({outputs}) => {
      pushLog(`WebMidi ready! Just add .midi(${outputs.map((o) => `"${o.name}"`).join(" | ")}) to the pattern. `);
    }, []),
    connected: useCallback(({outputs}) => {
      pushLog(`Midi device connected! Available: ${outputs.map((o) => `"${o.name}"`).join(", ")}`);
    }, []),
    disconnected: useCallback(({outputs}) => {
      pushLog(`Midi device disconnected! Available: ${outputs.map((o) => `"${o.name}"`).join(", ")}`);
    }, [])
  });
  return /* @__PURE__ */ React.createElement("div", {
    className: "min-h-screen bg-[#2A3236] flex flex-col"
  }, /* @__PURE__ */ React.createElement("header", {
    className: "flex-none w-full h-16 px-2 flex border-b border-gray-200 bg-white justify-between"
  }, /* @__PURE__ */ React.createElement("div", {
    className: "flex items-center space-x-2"
  }, /* @__PURE__ */ React.createElement("img", {
    src: logo,
    className: "Tidal-logo w-16 h-16",
    alt: "logo"
  }), /* @__PURE__ */ React.createElement("h1", {
    className: "text-2xl"
  }, "Strudel REPL")), /* @__PURE__ */ React.createElement("div", {
    className: "flex space-x-4"
  }, /* @__PURE__ */ React.createElement("button", {
    onClick: () => {
      const _code = getRandomTune();
      console.log("tune", _code);
      setCode(_code);
      const parsed = evaluate(_code);
      setActivePattern(parsed.pattern);
    }
  }, "🎲 random tune"), window.location.href.includes("http://localhost:8080") && /* @__PURE__ */ React.createElement("button", {
    onClick: () => {
      if (isHot || confirm("Really switch? You might loose your current pattern..")) {
        setIsHot((h) => !h);
      }
    }
  }, "🔥 toggle hot mode"))), /* @__PURE__ */ React.createElement("section", {
    className: "grow flex flex-col text-gray-100"
  }, /* @__PURE__ */ React.createElement("div", {
    className: "grow relative"
  }, /* @__PURE__ */ React.createElement("div", {
    className: cx("h-full  bg-[#2A3236]", error ? "focus:ring-red-500" : "focus:ring-slate-800")
  }, /* @__PURE__ */ React.createElement(CodeMirror, {
    value: code,
    readOnly: isHot,
    options: {
      mode,
      theme: "material",
      lineNumbers: true
    },
    onChange: (_2, __, value) => {
      if (!isHot) {
        setCode(value);
      }
    }
  }), /* @__PURE__ */ React.createElement("span", {
    className: "p-4 absolute top-0 right-0 text-xs whitespace-pre text-right"
  }, !cycle.started ? `press ctrl+enter to play
` : !isHot && activePattern !== pattern ? `ctrl+enter to update
` : "no changes\n", !isHot && /* @__PURE__ */ React.createElement(React.Fragment, null, {pegjs: "mini"}[mode] || mode, " mode"), isHot && "🔥 hot mode: go to hot.js to edit pattern, then save")), error && /* @__PURE__ */ React.createElement("div", {
    className: "absolute right-2 bottom-2 text-red-500"
  }, error?.message || "unknown error")), /* @__PURE__ */ React.createElement("button", {
    className: "flex-none w-full border border-gray-700 p-2 bg-slate-700 hover:bg-slate-500",
    onClick: () => {
      if (!cycle.started) {
        activatePattern();
      } else {
        cycle.stop();
      }
    }
  }, cycle.started ? "pause" : "play"), /* @__PURE__ */ React.createElement("textarea", {
    className: "grow bg-[#283237] border-0 text-xs min-h-[200px]",
    value: log,
    readOnly: true,
    ref: logBox,
    style: {fontFamily: "monospace"}
  })));
}
export default App;