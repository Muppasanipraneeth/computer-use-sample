// Electron utility process: Jarvis's voice (Kokoro v1.0, sherpa-onnx). Separate from the listening worker because
// Kokoro needs about a second per sentence, and a listener busy synthesizing would miss the user talking over it.
// Input: { type: "init", paths } once, { type: "voice", id } (a VOICES id) any time, { type: "speak", id, text },
// { type: "cancel", id }.
// Output: { type: "ready" | "error" }, { type: "chunk", id, samples, sampleRate, last } per sentence, as each is ready.
import { createRequire } from "node:module";

import { DEFAULT_VOICE, findVoice } from "./voices.mjs";

const require = createRequire(import.meta.url);
const sherpa = require("sherpa-onnx-node");

let paths = null;
let voice = findVoice(DEFAULT_VOICE);
// One engine per accent: Kokoro reads its lexicon (US or GB pronunciations) at load time, and the lexicon is fixed per
// instance. The second accent loads (~0.4 s) only when a voice with it is first used.
const engines = new Map();
const cancelled = new Set();

function engine(accent) {
  if (!engines.has(accent)) {
    engines.set(accent, new sherpa.OfflineTts({ model: { kokoro: { ...paths.tts, lexicon: paths.ttsLexicons[accent] }, numThreads: 4 }, maxNumSentences: 1 }));
  }
  return engines.get(accent);
}

function post(message) {
  process.parentPort.postMessage(message);
}

/** Sentences, so the first one plays while the rest are generated. Very short ones ride with the next. */
export function sentences(text) {
  const parts = String(text).replace(/\s+/g, " ").trim().match(/[^.!?]+(?:[.!?]+["')\]]*|$)\s*/g) ?? [];
  const out = [];
  for (const part of parts.map((item) => item.trim()).filter(Boolean)) {
    if (out.length > 0 && out.at(-1).length < 12) out[out.length - 1] += ` ${part}`;
    else out.push(part);
  }
  return out;
}

function speak({ id, text }) {
  const queue = sentences(text);
  // The voice is fixed per reply, so a change mid-reply never switches speakers between sentences.
  const { sid, accent } = voice;
  // One sentence per event-loop turn, so a cancel (barge-in) is seen between sentences.
  const next = () => {
    if (cancelled.delete(id) || queue.length === 0) {
      if (queue.length > 0) post({ type: "chunk", id, samples: new Float32Array(0), sampleRate: 24000, last: true });
      return;
    }
    try {
      const audio = engine(accent).generate({ text: queue.shift(), sid, speed: 1.0, enableExternalBuffer: false });
      post({ type: "chunk", id, samples: Float32Array.from(audio.samples), sampleRate: audio.sampleRate, last: queue.length === 0 });
      if (queue.length > 0) setImmediate(next);
    } catch (error) {
      post({ type: "chunk", id, samples: new Float32Array(0), sampleRate: 24000, last: true, error: error instanceof Error ? error.message : String(error) });
    }
  };
  if (queue.length === 0) post({ type: "chunk", id, samples: new Float32Array(0), sampleRate: 24000, last: true });
  else next();
}

if (process.parentPort) {
  process.parentPort.on("message", ({ data }) => {
    try {
      if (data.type === "init") {
        paths = data.paths;
        engine(voice.accent);
        post({ type: "ready" });
      } else if (data.type === "voice") voice = findVoice(data.id) ?? voice;
      else if (data.type === "speak" && paths) speak(data);
      else if (data.type === "cancel") cancelled.add(data.id);
    } catch (error) {
      post({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  });
}
