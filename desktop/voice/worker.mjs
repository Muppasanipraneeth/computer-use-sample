// Electron utility process: wake word → end-of-speech → speech-to-text, all on this machine (sherpa-onnx).
// Input: { type: "init", paths } once, then { type: "audio", samples: Float32Array } at 16 kHz, plus
//   { type: "listen-now", hold?, lookbackSeconds? } (push-to-talk; hold: until "release"), { type: "release", cancel? },
//   { type: "speaking", on, followUp }.
// Output: { type: "ready" | "error" | "state" | "command" | "partial" }; "partial" is the words so far while the user
// talks. Jarvis's own voice is speaker.mjs, a separate process.
//
// Duplex-style conversation: while Jarvis talks, the microphone stays open. Speech from the user cuts Jarvis off
// (barge-in) and becomes the next command; right after Jarvis finishes, a short follow-up window takes a reply
// without the wake phrase. Chromium's echo cancellation removes Jarvis's own voice from the microphone signal.
import { createRequire } from "node:module";

import { findWakePhrase } from "./commands.mjs";

const require = createRequire(import.meta.url);
const sherpa = require("sherpa-onnx-node");

const RATE = 16000;
const VAD_WINDOW = 512;
const RING_SECONDS = 4;
// Audio kept from before the wake detection. Measured detection lag for "Hey Jarvis" is ~0.35 s: 0.6 s leaked "-vis"
// into the transcript ("This, opened…"). 0.45 s keeps a quick first word ("Stop") with a little margin; any leftover
// wake-phrase audio is stripped from the text by parseVoiceCommand.
const WAKE_LOOKBACK_SECONDS = 0.45;
const NO_SPEECH_SECONDS = 5;
const MAX_COMMAND_SECONDS = 15;
// Hold-to-talk: pauses don't end the request, letting go does. A little audio after the release keeps the last word.
const MAX_HOLD_SECONDS = 60;
const RELEASE_TAIL_SECONDS = 0.2;
// Barge-in and follow-up: speech must last this long (and be this loud) before it counts as the user talking.
const ONSET_SECONDS = 0.25;
const ONSET_MIN_DBFS = -42;
const FOLLOW_UP_SECONDS = 6;
// The recognizer wake path transcribes utterances up to this long while waiting for "Hey Jarvis".
const IDLE_UTTERANCE_SECONDS = 12;
// While the user talks, what they've said so far is transcribed again at most this often, so it shows as they speak.
const PARTIAL_SECONDS = 0.5;

let spotter;
let recognizer;
let vadConfig;
let stream;
let total = 0; // absolute samples received
const ring = new Float32Array(RATE * RING_SECONDS);
let capture = null; // { vad, pending, start, speechSeen, segments, source, held?, releaseAt?, heard, heardLength, partialAt, partial }
// While Jarvis speaks ("speaking") or just finished ("following"), a VAD watches for the user starting to talk.
let watch = null; // { mode: "speaking" | "following", vad, pending, run, until }
// While waiting for the wake phrase, a VAD cuts utterances for the recognizer wake path.
let idle = null; // { vad, pending }
// Settings → Voice. With the wake word off, only push-to-talk starts a request; talking over Jarvis still works.
const prefs = { wakeWord: true, followUp: true };
// JARVIS_VOICE_DEBUG=1 logs the mic level every 2 s, each wake, barge-in and transcript to the app's stderr.
const DEBUG = process.env.JARVIS_VOICE_DEBUG === "1";
let levelPeak = 0;
let levelSince = 0;

function debug(line) {
  if (DEBUG) console.error(`[voice] ${line}`);
}

function post(message) {
  process.parentPort.postMessage(message);
}

function dbfs(value) {
  return value > 0 ? 20 * Math.log10(value) : -Infinity;
}

function load(paths) {
  spotter = new sherpa.KeywordSpotter({
    featConfig: { sampleRate: RATE, featureDim: 80 },
    modelConfig: { transducer: paths.kws, tokens: paths.kwsTokens, numThreads: 1 },
    keywordsFile: paths.keywords,
  });
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: RATE, featureDim: 80 },
    modelConfig: { moonshine: paths.moonshine, tokens: paths.moonshineTokens, numThreads: 2 },
  });
  vadConfig = {
    sileroVad: { model: paths.vad, threshold: 0.5, minSilenceDuration: 0.7, minSpeechDuration: 0.2, windowSize: VAD_WINDOW },
    sampleRate: RATE,
  };
  stream = spotter.createStream();
}

function remember(samples) {
  for (let i = 0; i < samples.length; i += 1) ring[(total + i) % ring.length] = samples[i];
  total += samples.length;
}

function recall(from) {
  const start = Math.max(from, total - ring.length);
  const out = new Float32Array(Math.max(0, total - start));
  for (let i = 0; i < out.length; i += 1) out[i] = ring[(start + i) % ring.length];
  return out;
}

/** Feeds 512-sample windows to the VAD, calling onWindow after each; false stops early. Returns the unfed tail. */
function windows(vad, pending, samples, onWindow) {
  const joined = new Float32Array(pending.length + samples.length);
  joined.set(pending);
  joined.set(samples, pending.length);
  let offset = 0;
  while (offset + VAD_WINDOW <= joined.length) {
    const window = joined.subarray(offset, offset + VAD_WINDOW);
    offset += VAD_WINDOW;
    vad.acceptWaveform(window);
    if (onWindow(window) === false) break;
  }
  return joined.slice(offset);
}

function feedCapture(samples, keep = true) {
  // Everything heard since the request began, for the live transcript; the VAD only hands over finished segments.
  if (keep) {
    capture.heard.push(samples);
    capture.heardLength += samples.length;
  }
  capture.pending = windows(capture.vad, capture.pending, samples, () => {
    if (capture.vad.isDetected()) capture.speechSeen = true;
  });
  while (!capture.vad.isEmpty()) {
    // false: copy out of the addon; Electron's V8 memory cage rejects external buffers.
    capture.segments.push(capture.vad.front(false).samples);
    capture.vad.pop();
  }
}

function newCapture(vad, source, held, speechSeen, heard) {
  return { vad, pending: new Float32Array(0), start: total, speechSeen, segments: [], source, held, heard: [heard], heardLength: heard.length, partialAt: total + PARTIAL_SECONDS * RATE, partial: "" };
}

function startCapture(from, source, held = false) {
  watch = null;
  idle = null;
  post({ type: "state", state: "hearing", source });
  const seconds = (held ? MAX_HOLD_SECONDS : MAX_COMMAND_SECONDS) + 5;
  const lookback = recall(from);
  capture = newCapture(new sherpa.Vad(vadConfig, seconds), source, held, false, lookback);
  feedCapture(lookback, false);
}

function joined(parts, length) {
  const out = new Float32Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * The words so far, re-transcribed from everything heard. Moonshine decodes 2 s of speech in ~25 ms, but this worker is
 * single-threaded, so the next decode waits at least four times as long as this one took: a long request never
 * crowds out the audio that decides when it ends.
 */
function postPartial() {
  if (!capture.speechSeen || total < capture.partialAt) return;
  const started = performance.now();
  const text = transcribe(joined(capture.heard, capture.heardLength));
  const seconds = (performance.now() - started) / 1000;
  capture.partialAt = total + Math.round(Math.max(PARTIAL_SECONDS, seconds * 4) * RATE);
  if (!text || text === capture.partial) return;
  capture.partial = text;
  post({ type: "partial", text, source: capture.source });
}

function transcribe(speech) {
  const decoding = recognizer.createStream();
  decoding.acceptWaveform({ samples: speech, sampleRate: RATE });
  recognizer.decode(decoding);
  return recognizer.getResult(decoding).text.trim();
}

function finishCapture() {
  // A held request may end mid-word; flush so the speech still in the VAD counts.
  if (capture.segments.length === 0 || capture.held) {
    capture.vad.flush();
    while (!capture.vad.isEmpty()) {
      capture.segments.push(capture.vad.front(false).samples);
      capture.vad.pop();
    }
  }
  const { segments, source } = capture;
  capture = null;
  stream = spotter.createStream();
  if (segments.length === 0) {
    post({ type: "state", state: "listening", note: source === "wake" || source === "push-to-talk" ? "no-speech" : undefined, source });
    return;
  }
  post({ type: "state", state: "transcribing" });
  const speech = joined(segments, segments.reduce((sum, part) => sum + part.length, 0));
  const text = transcribe(speech);
  debug(`heard (${(speech.length / RATE).toFixed(1)} s, ${source}): "${text}"`);
  post({ type: "command", text, source, seconds: +(speech.length / RATE).toFixed(2) });
  post({ type: "state", state: "listening" });
}

function startWatch(mode) {
  reportWatch();
  idle = null;
  watch = { mode, vad: new sherpa.Vad(vadConfig, 30), pending: new Float32Array(0), run: 0, until: mode === "following" ? total + FOLLOW_UP_SECONDS * RATE : Infinity, seen: { windows: 0, speech: 0, loud: 0, longest: 0 } };
  if (mode === "following") post({ type: "state", state: "following" });
}

// Debug: what the watch saw when nobody interrupted, to tell "the user didn't talk" from "echo cancellation ate it".
function reportWatch() {
  if (!DEBUG || !watch || watch.seen.windows === 0) return;
  const { windows: total, speech, loud, longest } = watch.seen;
  debug(`no ${watch.mode === "speaking" ? "barge-in" : "follow-up"}: speech in ${Math.round((speech / total) * 100)} % of windows, loud speech ${Math.round((loud / total) * 100)} %, longest run ${(longest / RATE).toFixed(2)} s`);
}

function endWatch() {
  reportWatch();
  const wasFollowing = watch?.mode === "following";
  watch = null;
  stream = spotter.createStream();
  if (wasFollowing) post({ type: "state", state: "listening" });
}

/**
 * Detects the user starting to talk: VAD speech that is also loud enough, sustained for ONSET_SECONDS. The same VAD
 * then carries on as the command capture. It has tracked the utterance from its first sound; a fresh VAD started
 * mid-word cut "Wait, stop. Tell me one about Mars instead." down to its first 0.3 s in testing.
 */
function feedWatch(samples) {
  let level = 0;
  let started = false;
  watch.pending = windows(watch.vad, watch.pending, samples, (window) => {
    let sum = 0;
    for (const sample of window) sum += sample * sample;
    level = dbfs(Math.sqrt(sum / window.length));
    const speech = watch.vad.isDetected();
    watch.run = speech && level >= ONSET_MIN_DBFS ? watch.run + window.length : 0;
    watch.seen.windows += 1;
    if (speech) watch.seen.speech += 1;
    if (speech && level >= ONSET_MIN_DBFS) watch.seen.loud += 1;
    watch.seen.longest = Math.max(watch.seen.longest, watch.run);
    started = watch.run >= ONSET_SECONDS * RATE;
    return !started;
  });
  // Finished segments are earlier sounds (a cough, a word too quiet to count); the utterance in progress is not one yet.
  while (!watch.vad.isEmpty()) watch.vad.pop();
  if (!started) {
    if (total >= watch.until) endWatch();
    return;
  }
  const source = watch.mode === "speaking" ? "barge-in" : "follow-up";
  debug(`${source} at ${level.toFixed(1)} dBFS`);
  post({ type: "state", state: "hearing", source });
  // The onset that counted as talking is already behind us; the ring still holds it, so the live words start with it.
  const onset = recall(total - Math.round((ONSET_SECONDS + 0.2) * RATE));
  capture = newCapture(watch.vad, source, false, true, onset);
  const rest = watch.pending;
  watch = null;
  feedCapture(rest, false);
}

/**
 * Second wake path: every utterance heard while waiting is transcribed (Moonshine: ~25 ms for 2 s of speech), and a
 * transcript starting with "Hey Jarvis" wakes Jarvis even when the keyword spotter missed it. The spotter, tuned on
 * synthetic voices, missed real ones: the user's natural "Hey Jarvis" in a live session, and one test clip three times
 * in a row that Moonshine transcribed word for word. Returns true when it woke.
 */
function feedIdle(samples) {
  idle ??= { vad: new sherpa.Vad(vadConfig, 30), pending: new Float32Array(0) };
  idle.pending = windows(idle.vad, idle.pending, samples, () => true);
  while (!idle.vad.isEmpty()) {
    const speech = idle.vad.front(false).samples;
    idle.vad.pop();
    // Long stretches are songs or other people talking, not someone addressing Jarvis.
    if (speech.length > IDLE_UTTERANCE_SECONDS * RATE) continue;
    const request = findWakePhrase(transcribe(speech));
    if (request === null) continue;
    debug("wake (recognizer): Hey Jarvis");
    idle = null;
    if (!request) {
      // Just the wake phrase: listen for the request that follows, as after a spotter wake.
      startCapture(total, "wake");
      return true;
    }
    post({ type: "state", state: "hearing", source: "wake" });
    debug(`heard (${(speech.length / RATE).toFixed(1)} s, wake): "${request}"`);
    post({ type: "command", text: request, source: "wake", seconds: +(speech.length / RATE).toFixed(2) });
    post({ type: "state", state: "listening" });
    stream = spotter.createStream();
    return true;
  }
  return false;
}

function onAudio(samples) {
  remember(samples);
  if (DEBUG) {
    for (const sample of samples) levelPeak = Math.max(levelPeak, Math.abs(sample));
    if (total - levelSince >= 2 * RATE) {
      debug(`mic level: peak ${dbfs(levelPeak).toFixed(1)} dBFS over 2 s${watch ? ` (${watch.mode})` : ""}`);
      levelPeak = 0;
      levelSince = total;
    }
  }
  if (capture) {
    feedCapture(samples);
    const elapsed = (total - capture.start) / RATE;
    if (capture.held) {
      if ((capture.releaseAt !== undefined && total >= capture.releaseAt) || elapsed > MAX_HOLD_SECONDS) return finishCapture();
    } else if (capture.segments.length > 0 || elapsed > MAX_COMMAND_SECONDS || (!capture.speechSeen && elapsed > NO_SPEECH_SECONDS)) {
      // A finished segment means the user paused after speaking: the command is complete.
      return finishCapture();
    }
    postPartial();
    return;
  }
  if (watch) {
    feedWatch(samples);
    return;
  }
  if (!prefs.wakeWord) return;
  if (feedIdle(samples)) return;
  stream.acceptWaveform({ samples, sampleRate: RATE });
  while (spotter.isReady(stream)) {
    spotter.decode(stream);
    const result = spotter.getResult(stream);
    if (result.keyword) {
      debug("wake: Hey Jarvis");
      // Keyword timestamps restart after the decoder's internal resets (any long pause), so they are not an absolute
      // clock. Anchor on the sample count instead: detection lags the phrase by ~0.3–0.5 s (100 ms chunks + model
      // latency). Looking back a little extra protects the first word; leftover wake words are stripped from the text.
      startCapture(total - Math.round(WAKE_LOOKBACK_SECONDS * RATE), "wake");
      return;
    }
  }
}

process.parentPort.on("message", ({ data }) => {
  try {
    if (data.type === "init") {
      load(data.paths);
      post({ type: "ready" });
      post({ type: "state", state: "listening" });
    } else if (data.type === "audio" && spotter) {
      onAudio(data.samples);
    } else if (data.type === "listen-now" && spotter && !capture) {
      // Push-to-talk: no wake phrase to skip. A held key started a moment before it counted as a hold, so look back.
      const lookback = Math.round(Math.min(Math.max(Number(data.lookbackSeconds) || 0, 0), 1) * RATE);
      startCapture(total - lookback, "push-to-talk", data.hold === true);
    } else if (data.type === "release" && capture?.held) {
      if (data.cancel) {
        // It was a shortcut (Ctrl+C) after all: drop what was heard.
        capture = null;
        stream = spotter.createStream();
        post({ type: "state", state: "listening" });
      } else capture.releaseAt ??= total + Math.round(RELEASE_TAIL_SECONDS * RATE);
    } else if (data.type === "speaking" && spotter && !capture) {
      if (data.on) startWatch("speaking");
      else if (data.followUp && prefs.followUp) startWatch("following");
      else endWatch();
    } else if (data.type === "prefs") {
      prefs.wakeWord = data.wakeWord !== false;
      prefs.followUp = data.followUp !== false;
      if (!prefs.wakeWord) idle = null;
    }
  } catch (error) {
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
});
