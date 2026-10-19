import assert from "node:assert/strict";
import test from "node:test";

import { faceState, faceVisible, moodFor, placeFace } from "../avatar-mood.mjs";

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

test("the face keeps its spot while that spot is on a screen, else goes to the main screen's corner", () => {
  const size = { width: 400, height: 150 };
  const laptop = { x: 0, y: 25, width: 1512, height: 920 };
  const external = { x: 1512, y: 0, width: 2560, height: 1415 };
  assert.deepEqual(placeFace({ x: 2000, y: 600 }, size, [laptop, external]), { x: 2000, y: 600 });
  assert.deepEqual(placeFace({ x: 2000, y: 600 }, size, [laptop]), { x: 1088, y: 771 }, "external screen unplugged");
  assert.deepEqual(placeFace(null, size, [laptop]), { x: 1088, y: 771 });
  assert.deepEqual(placeFace({ x: 1300, y: 100 }, size, [laptop]), { x: 1088, y: 771 }, "half off the edge");
});
