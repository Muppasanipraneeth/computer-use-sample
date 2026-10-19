import assert from "node:assert/strict";
import test from "node:test";

import { findWakePhrase, parseVoiceCommand } from "../voice/commands.mjs";

test("stop words stop, even when the first sound was clipped", () => {
  for (const said of ["Stop.", "Top", "stop it", "Please stop now", "STOP THE RUN!"]) {
    assert.deepEqual(parseVoiceCommand(said), { action: "stop" }, said);
  }
});

test("cancel words cancel a pending voice prompt", () => {
  for (const said of ["Cancel.", "never mind", "Nevermind", "forget it"]) {
    assert.deepEqual(parseVoiceCommand(said), { action: "cancel" }, said);
  }
});

test("anything else becomes the prompt, cleaned but not rewritten", () => {
  // Real Moonshine output from the spike.
  assert.deepEqual(parseVoiceCommand(" open Spotify and play the song Runway. "), {
    action: "run",
    prompt: "Open Spotify and play the song Runway.",
  });
  // A task that merely contains a stop word is still a task.
  assert.equal(parseVoiceCommand("stop the music in Spotify").action, "run");
  assert.equal(parseVoiceCommand("Top 5 Hacker News stories").action, "run");
  assert.deepEqual(parseVoiceCommand("   "), { action: "none" });
});

test("leftover wake-phrase audio is stripped before parsing", () => {
  // Shape of the real end-to-end transcript, where the lookback included the wake phrase.
  assert.deepEqual(parseVoiceCommand("Hey Jarvis, open Spotify and play the song Runway."), {
    action: "run",
    prompt: "Open Spotify and play the song Runway.",
  });
  assert.deepEqual(parseVoiceCommand("vis, stop"), { action: "stop" });
  assert.deepEqual(parseVoiceCommand("Jarvis."), { action: "none" });
  // The word inside a task is left alone.
  assert.equal(parseVoiceCommand("Ask Jarvis about the weather").prompt, "Ask Jarvis about the weather");
  // The tail of "Jar-vis" heard as its own word, from the real end-to-end transcript.
  assert.equal(parseVoiceCommand("This, opened Spotify and played the song Runway.").prompt, "Opened Spotify and played the song Runway.");
  // Without the pause punctuation it is the user's own first word.
  assert.equal(parseVoiceCommand("This file is old, delete it").prompt, "This file is old, delete it");
});

test("the recognizer wakes Jarvis on the wake phrase and keeps the request that follows", () => {
  // Real Moonshine output: the keyword spotter missed these.
  assert.equal(findWakePhrase("Hey Jarvis, are you there?"), "are you there?");
  assert.equal(findWakePhrase("Hey, hey, hey, hey, Jarvis. I didn't say this."), "I didn't say this.");
  assert.equal(findWakePhrase("Hey Jarvis."), "");
  assert.equal(findWakePhrase("Jarvis, open Spotify"), "open Spotify");
  assert.equal(findWakePhrase("Okay, Javis tell me a joke"), "tell me a joke");
});

test("ordinary speech and near-misses don't wake Jarvis", () => {
  for (const said of ["Can you tell me a joke?", "So I was asking about Elon Musk.", "Hey Travis, over here", "This is it.", "I told Jarvis already", ""]) {
    assert.equal(findWakePhrase(said), null, said);
  }
});
