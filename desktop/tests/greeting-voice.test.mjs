import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { decodeGreeting, encodeGreeting, greetingKey, greetingText, joinChunks, pruneGreetings, readGreeting, writeGreeting } from "../greeting-voice.mjs";

test("the greeting names the user only when there is a name", () => {
  assert.equal(greetingText("Good morning", "  Praneeth "), "Good morning, Praneeth. Jarvis is here.");
  assert.equal(greetingText("Working late"), "Working late. Jarvis is here.");
});

test("a cached greeting survives the round trip, and a damaged file reads as missing", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "jarvis-greet-"));
  try {
    const samples = joinChunks([Float32Array.of(0.1, -0.2), new Float32Array(0), Float32Array.of(0.3)]);
    const key = greetingKey("af_heart", greetingText("Good evening", "Asha"));
    await writeGreeting(directory, key, samples, 24000);
    const back = await readGreeting(directory, key);
    assert.equal(back.sampleRate, 24000);
    assert.deepEqual([...back.samples].map((value) => Number(value.toFixed(3))), [0.1, -0.2, 0.3]);
    writeFileSync(path.join(directory, "bad.jvg"), "JVG1xx");
    assert.equal(await readGreeting(directory, "bad"), null);
    assert.equal(await readGreeting(directory, "missing"), null);
    assert.equal(decodeGreeting(encodeGreeting(new Float32Array(0), 24000)), null, "an empty render is not a greeting");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a new name or voice gets its own file and old ones are pruned", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "jarvis-greet-"));
  try {
    const old = greetingKey("af_heart", greetingText("Good morning", "Pran"));
    const next = greetingKey("bf_emma", greetingText("Good morning", "Pran"));
    assert.notEqual(old, next);
    await writeGreeting(directory, old, Float32Array.of(0.1), 24000);
    await writeGreeting(directory, next, Float32Array.of(0.1), 24000);
    await pruneGreetings(directory, [next]);
    assert.deepEqual(readdirSync(directory), [`${next}.jvg`]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
