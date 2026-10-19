import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_VOICE, findVoice, VOICES } from "../voice/voices.mjs";

test("the voice list is Kokoro v1.0's 28 English speakers, each at its speaker id", () => {
  assert.equal(VOICES.length, 28);
  VOICES.forEach((voice, index) => {
    assert.equal(voice.sid, index);
    assert.match(voice.id, /^[ab][fm]_[a-z]+$/);
    assert.equal(voice.accent, voice.id[0] === "a" ? "American" : "British");
    assert.equal(voice.gender, voice.id[1] === "f" ? "female" : "male");
    assert.match(voice.name, /^[A-Z][a-z]+$/);
  });
  assert.deepEqual(
    [VOICES[0].id, VOICES[3].id, VOICES[10].id, VOICES[11].id, VOICES[19].id, VOICES[20].id, VOICES[24].id, VOICES[27].id],
    ["af_alloy", "af_heart", "af_sky", "am_adam", "am_santa", "bf_alice", "bm_daniel", "bm_lewis"],
  );
  assert.equal(new Set(VOICES.map((voice) => voice.id)).size, 28);
});

test("Heart is the default, and unknown ids are not voices", () => {
  assert.deepEqual(findVoice(DEFAULT_VOICE), { id: "af_heart", sid: 3, name: "Heart", accent: "American", gender: "female" });
  assert.equal(findVoice("bf_emma").accent, "British");
  assert.equal(findVoice("zf_xiaobei"), null);
  assert.equal(findVoice(undefined), null);
});
