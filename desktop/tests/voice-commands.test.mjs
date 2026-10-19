import assert from "node:assert/strict";
import test from "node:test";

import { findWakePhrase, parseVoiceCommand, settledWords, spokenText } from "../voice/commands.mjs";

/** Feeds partial transcripts through settledWords, as the worker does, and returns what was shown after each. */
function shownOver(partials) {
  let shown = [];
  let previous = [];
  return partials.map((text) => {
    const words = text.split(" ");
    shown = settledWords(shown, previous, words);
    previous = words;
    return shown.join(" ");
  });
}

test("live words show only what two transcripts in a row agree on, and never go back", () => {
  // Real partials for "tell me a short joke about computers and coffee", without the wake-phrase lookback.
  const shown = shownOver(["Tell me a short story", "Tell me a short joke about the", "Tell me a short joke about computer science.", "Tell me a short joke about computers and", "Tell me a short joke about computers and coffee."]);
  assert.deepEqual(shown, ["", "Tell me a short", "Tell me a short joke about", "Tell me a short joke about", "Tell me a short joke about computers and"]);
  for (let at = 1; at < shown.length; at += 1) assert.ok(shown[at].startsWith(shown[at - 1]), `"${shown[at]}" takes back "${shown[at - 1]}"`);
  assert.deepEqual(shownOver(["What is the", "what is the tallest", "What is the tallest mountain."]), ["", "what is the", "what is the tallest"], "a change of case or punctuation neither counts nor shows");
});

test("the live words drop leftover wake-phrase audio but keep the user's own first word", () => {
  assert.equal(spokenText("Hey Jarvis, open"), "open");
  assert.equal(spokenText("This, opened Spotify and"), "opened Spotify and");
  assert.equal(spokenText("This file is old"), "This file is old");
  assert.equal(spokenText("vis,"), "");
});

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
