import assert from "node:assert/strict";
import test from "node:test";

import { createDucker, duckedVolume, parseVolumeSettings } from "../voice/ducking.mjs";

test("ducking cuts loud audio to a quarter and leaves quiet audio alone", () => {
  assert.equal(duckedVolume(80), 20);
  assert.equal(duckedVolume(40), 10);
  assert.equal(duckedVolume(20), 8, "never below an audible floor");
  assert.equal(duckedVolume(12), null, "already quiet");
  assert.equal(duckedVolume(NaN), null);
});

test("AppleScript volume settings parse, including mute and missing values", () => {
  assert.deepEqual(parseVolumeSettings("output volume:56, input volume:75, alert volume:100, output muted:false"), { volume: 56, muted: false });
  assert.deepEqual(parseVolumeSettings("output volume:0, input volume:75, alert volume:100, output muted:true"), { volume: 0, muted: true });
  // External displays and some audio interfaces report "missing value" for the volume.
  assert.deepEqual(parseVolumeSettings("output volume:missing value, input volume:75, alert volume:100, output muted:false"), { volume: null, muted: false });
});

test("off macOS the ducker never touches the system", async () => {
  const ducker = createDucker("win32");
  await ducker.duck();
  await ducker.restore();
  await ducker.hold();
  await ducker.release();
  ducker.restoreNow();
});
