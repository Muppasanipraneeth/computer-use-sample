import assert from "node:assert/strict";
import test from "node:test";

import { faceCaption, faceMode, faceScale, faceState, faceVisible, moodFor, placeFace, snapFace } from "../avatar-mood.mjs";

test("while the user talks and Jarvis thinks, the caption is their words, never Jarvis's last reply", () => {
  const face = { text: "Playing Blinding Lights by The Weeknd.", heard: "open slack and" };
  assert.deepEqual(faceCaption({ ...face, voice: "hearing" }), { caption: "open slack and", heard: true });
  assert.deepEqual(faceCaption({ ...face, voice: "thinking" }), { caption: "open slack and", heard: true });
  assert.deepEqual(faceCaption({ ...face, voice: "hearing", heard: "" }), { caption: "", heard: false }, "no words yet: Listening…");
  assert.deepEqual(faceCaption({ ...face, voice: "speaking" }), { caption: "Playing Blinding Lights by The Weeknd.", heard: false });
});

test("a conversation shows the face; a background task does only while it works, asks or just finished", () => {
  assert.equal(faceState("speaking", "working"), "speaking", "talking wins over the task");
  assert.equal(faceState("listening", "working"), "working");
  assert.equal(faceState("following", null), "following", "stays through the follow-up window instead of flickering");
  assert.equal(faceVisible("listening", null), false);
  assert.equal(faceVisible("off", "done"), true, "a finished task still gets its reaction with voice off");
});

test("the mood follows the outcome first, then the words", () => {
  assert.equal(moodFor("All done! Spotify is playing.", "failed"), "sorry", "a failure is never cheerful");
  assert.equal(moodFor("Sorry, I couldn't find that file."), "sorry");
  assert.equal(moodFor("Which account, work or personal?"), "curious");
  assert.equal(moodFor('Shall I send it?"'), "curious");
  assert.equal(moodFor("Obviously the weather is still weather."), "wink");
  assert.equal(moodFor("It's 24 degrees in Hyderabad.", "completed"), "happy");
  assert.equal(moodFor("Opening Spotify now."), "neutral");
});

test("the face keeps a dragged spot while that spot is on a screen, else goes to its preset on the main screen", () => {
  const size = { width: 420, height: 230 };
  const laptop = { x: 0, y: 25, width: 1512, height: 920 };
  const external = { x: 1512, y: 0, width: 2560, height: 1415 };
  assert.deepEqual(placeFace({ x: 2000, y: 600 }, size, [laptop, external]), { x: 2000, y: 600 });
  assert.deepEqual(placeFace({ x: 2000, y: 600 }, size, [laptop]), { x: 546, y: 705 }, "external screen unplugged: bottom-centre");
  assert.deepEqual(placeFace(null, size, [laptop]), { x: 546, y: 705 });
  assert.deepEqual(placeFace({ spot: "top-right" }, size, [laptop]), { x: 1082, y: 35 });
  assert.deepEqual(placeFace({ x: 1300, y: 100 }, size, [laptop]), { x: 546, y: 705 }, "half off the edge");
});

test("a drop near a preset snaps to it; anywhere else stays put", () => {
  const size = { width: 420, height: 230 };
  const laptop = { x: 0, y: 25, width: 1512, height: 920 };
  assert.deepEqual(snapFace({ x: 520, y: 690 }, size, laptop), { spot: "bottom-center", x: 546, y: 705 });
  assert.deepEqual(snapFace({ x: 1070, y: 60 }, size, laptop), { spot: "top-right", x: 1082, y: 35 });
  assert.deepEqual(snapFace({ x: 300.4, y: 400.6 }, size, laptop), { x: 300, y: 401 });
});

test("older on/off settings map onto the new modes, and unknown sizes fall back to medium", () => {
  assert.equal(faceMode(true), "always");
  assert.equal(faceMode(false), "off");
  assert.equal(faceMode("talking"), "talking");
  assert.equal(faceMode(undefined), "always");
  assert.equal(faceScale("large"), 1.25);
  assert.equal(faceScale("huge"), 1);
});
