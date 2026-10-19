import assert from "node:assert/strict";
import test from "node:test";

import { sentences } from "../voice/speaker.mjs";

test("replies stream sentence by sentence, keeping every word", () => {
  const text = "Opening Spotify for Runway. Excellent taste, naturally! Ready?  Proceeding.";
  const parts = sentences(text);
  assert.deepEqual(parts, ["Opening Spotify for Runway.", "Excellent taste, naturally!", "Ready? Proceeding."]);
  assert.equal(parts.join(" "), text.replace(/\s+/g, " "));
});

test("fragments too short to say on their own ride with the next sentence", () => {
  assert.deepEqual(sentences("Done. The folder is on your desktop."), ["Done. The folder is on your desktop."]);
  assert.deepEqual(sentences("No punctuation at the end"), ["No punctuation at the end"]);
  assert.deepEqual(sentences("   "), []);
});
