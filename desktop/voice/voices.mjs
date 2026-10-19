// Jarvis's selectable voices: the English speakers of Kokoro v1.0 (kokoro-int8-multi-lang-v1_0), whose speaker ids
// 0–27 are exactly this list in this order. Its own module, not speaker.mjs, so the main process can list voices
// without loading the sherpa-onnx native addon.
const KOKORO_ENGLISH = [
  "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
  "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck", "am_santa",
  "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
  "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
];

// Heart: the voice Kokoro's authors grade highest (A). Measured against Bella, Emma and Nicole: 98 % of its words heard
// back correctly by the recognizer (Bella 91 %, Emma 67 %).
export const DEFAULT_VOICE = "af_heart";

/** @type {ReadonlyArray<{ id: string, sid: number, name: string, accent: "American" | "British", gender: "female" | "male" }>} */
export const VOICES = Object.freeze(
  KOKORO_ENGLISH.map((id, sid) => {
    const word = id.slice(3);
    return Object.freeze({
      id,
      sid,
      name: word[0].toUpperCase() + word.slice(1),
      accent: id[0] === "b" ? "British" : "American",
      gender: id[1] === "m" ? "male" : "female",
    });
  }),
);

export function findVoice(id) {
  return VOICES.find((voice) => voice.id === id) ?? null;
}
