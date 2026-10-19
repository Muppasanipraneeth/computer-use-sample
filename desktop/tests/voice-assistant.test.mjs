import assert from "node:assert/strict";
import test from "node:test";

import {
  aboutUser,
  chatSelectorsFromOmpStdout,
  followUpInstructions,
  parseFollowUp,
  parseUnderstanding,
  pickUnderstandingModel,
  quickFollowUp,
  resultInstructions,
  spokenSummary,
  typedNeedsUnderstanding,
  understandingInstructions,
} from "../voice/assistant.mjs";

test("obvious follow-ups are decided without the model; questions and look-alikes are not", () => {
  const kind = (text) => quickFollowUp(text)?.kind ?? null;
  assert.equal(kind("stop"), "stop");
  assert.equal(kind("Never mind."), "stop");
  assert.deepEqual(quickFollowUp("also set the volume to 30%"), { kind: "add", say: "Got it, adding that.", message: "Set the volume to 30%", understood: true });
  assert.deepEqual(quickFollowUp("after that, open Notes"), { kind: "queue", say: "Okay, I'll do that next.", message: "Open Notes", understood: true });
  assert.equal(quickFollowUp("no, play Runaway instead").message, "Play Runaway instead");
  assert.equal(kind("actually use Chrome"), "redirect");
  for (const text of ["then what?", "actually, what time is it", "no worries", "nothing happened", "stop the music after this song plays", "also what's the weather"]) {
    assert.equal(kind(text), null, text);
  }
});

test("a routine needs a valid time and days, or the user is sent to Settings instead of running it once", () => {
  const routine = parseUnderstanding('{"kind":"schedule","say":"Every morning at 8.","prompt":"Tell me the top tech news.","time":"08:00","days":[1,0,6,5,4,3,2,2,9]}', "every morning at 8 news");
  assert.deepEqual(routine, { kind: "schedule", say: "Every morning at 8.", prompt: "Tell me the top tech news.", time: "08:00", days: [0, 1, 2, 3, 4, 5, 6], understood: true });
  for (const bad of ['"time":"8am","days":[1]', '"time":"24:00","days":[1]', '"time":"08:00","days":[]']) {
    assert.equal(parseUnderstanding(`{"kind":"schedule","say":"Sure.","prompt":"News.",${bad}}`, "every day news").kind, "answer", bad);
  }
  assert.deepEqual(parseUnderstanding('{"kind":"remember","say":"Noted.","prompt":"Prefers Spotify over Apple Music"}', "remember i like spotify"), {
    kind: "remember",
    say: "Noted.",
    prompt: "Prefers Spotify over Apple Music",
    understood: true,
  });
});

test("only typed routines and memory requests wait for the model", () => {
  for (const text of ["every morning at 8 tell me the news", "On weekdays at 6pm remind me to stretch", "Remember that I prefer Spotify", "daily summary of my inbox"]) {
    assert.equal(typedNeedsUnderstanding(text), true, text);
  }
  for (const text of ["open spotify and play black and white", "what's the weather in hyderabad", "tell me everything about Rust"]) {
    assert.equal(typedNeedsUnderstanding(text), false, text);
  }
});

test("a follow-up decision keeps its message only when it changes or queues work", () => {
  assert.deepEqual(parseFollowUp('{"kind":"queue","say":"I\'ll check the weather after this.","message":"Check the weather in Hyderabad."}', "then weather"), {
    kind: "queue",
    say: "I'll check the weather after this.",
    message: "Check the weather in Hyderabad.",
    understood: true,
  });
  assert.deepEqual(parseFollowUp('{"kind":"answer","say":"I\'m searching Spotify now.","message":"stray"}', "what are you doing"), {
    kind: "answer",
    say: "I'm searching Spotify now.",
    message: "",
    understood: true,
  });
});

test("an unusable follow-up decision hands the words to the running task", () => {
  const said = "use chrome instead";
  const fallback = { kind: "add", say: "Got it, I'll factor that in.", message: said, understood: false };
  for (const stdout of ["", "{nope}", '{"kind":"pause","say":"Ok."}', '{"kind":"redirect","say":"Switching.","message":""}', '{"kind":"stop","say":""}']) {
    assert.deepEqual(parseFollowUp(stdout, said), fallback, stdout);
  }
});

test("the follow-up prompt names the running task, its paused state and only recent progress", () => {
  const progress = Array.from({ length: 12 }, (_, index) => `step ${index + 1}`);
  const text = followUpInstructions({ running: "Play Black and White on Spotify", progress, paused: true });
  assert.match(text, /Running task \(paused\): "Play Black and White on Spotify"/);
  assert.match(text, /- step 12/);
  assert.doesNotMatch(text, /- step 4\n/);
});

test("a model reply becomes what Jarvis says and the cleaned task for the agent", () => {
  // Real claude-haiku-5-5 output shape, wrapped in the chatter omp may print around it.
  const stdout = 'Thinking…\n{"kind":"task","say":"I\'ll open Spotify and play Runaway.","prompt":"Open Spotify and play the song \\"Runaway\\"."}\n';
  assert.deepEqual(parseUnderstanding(stdout, "put on the song runaway in spotify"), {
    kind: "task",
    say: "I'll open Spotify and play Runaway.",
    prompt: 'Open Spotify and play the song "Runaway".',
    understood: true,
  });
});

test("unusable replies fall back to running the words as spoken", () => {
  const said = "open finder";
  const fallback = { kind: "task", say: "On it.", prompt: said, understood: false };
  for (const stdout of ["", "omp timed out", "{not json}", '{"kind":"dance","say":"Sure."}', '{"kind":"task","say":"On it.","prompt":""}', '{"kind":"answer","say":""}']) {
    assert.deepEqual(parseUnderstanding(stdout, said), fallback, stdout);
  }
});

test("only tasks carry a prompt; background speech is ignored silently", () => {
  assert.deepEqual(parseUnderstanding('{"kind":"answer","say":"Yes, I\'m here.","prompt":"stray"}', "are you there"), {
    kind: "answer",
    say: "Yes, I'm here.",
    prompt: "",
    understood: true,
  });
  assert.deepEqual(parseUnderstanding('{"kind":"ignore","say":"","prompt":""}', "baby baby oh"), { kind: "ignore", say: "", prompt: "", understood: true });
});

test("the fastest available model handles understanding", () => {
  assert.equal(pickUnderstandingModel(["cursor/gemini-3.5-flash", "anthropic/claude-haiku-4-5", "anthropic/claude-haiku-5-5"]), "anthropic/claude-haiku-5-5");
  assert.equal(pickUnderstandingModel(["cursor/gemini-3.5-flash", "openai/gpt-6"]), "cursor/gemini-3.5-flash");
  assert.equal(pickUnderstandingModel(["openai/gpt-6"]), null);
});

test("chat model selectors come from omp's model list, skipping other kinds and noise", () => {
  const stdout = `warn: something\n${JSON.stringify({ models: [{ kind: "chat", selector: "anthropic/claude-haiku-5-5" }, { kind: "image", selector: "openai/gpt-image-2" }, { kind: "chat" }] })}`;
  assert.deepEqual(chatSelectorsFromOmpStdout(stdout), ["anthropic/claude-haiku-5-5"]);
  assert.deepEqual(chatSelectorsFromOmpStdout("no json here"), []);
});

test("a finished run is summed up in a sentence or two of plain speech", () => {
  const reply = "**Done.** Runway is playing in Spotify.\n\n- Opened Spotify\n- Searched for Runway\n- Pressed play on the top result, which was the 2026 single by the original artist.";
  const spoken = spokenSummary({ status: "completed", reply });
  assert.equal(spoken.startsWith("Done. Runway is playing in Spotify."), true, spoken);
  assert.equal(/[*`#]|^- /m.test(spoken), false, spoken);
  assert.equal(spoken.length <= 220, true, spoken);
  assert.equal(spokenSummary({ status: "completed", reply: null }), "Done.");
  assert.equal(spokenSummary({ status: "cancelled" }), "Stopped.");
  assert.equal(spokenSummary({ status: "failed", error: "Spotify is not installed. Install it first." }), "That didn't work. Spotify is not installed. Install it first.");
  assert.equal(spokenSummary({ status: "failed", error: null }), "That didn't work.");
});

test("the user's profile tells Jarvis what to call them and where they live, and nothing else", () => {
  const profile = { name: "Praneeth", callMe: "P", location: "Austin, TX", about: "Vegetarian." };
  const understanding = understandingInstructions({ now: "now", source: "wake", personality: "witty", profile });
  assert.match(understanding, /About the user/);
  assert.match(understanding, /Their name is Praneeth; call them P\./);
  assert.match(understanding, /They live in Austin, TX; use it for weather/);
  assert.match(understanding, /put their location in prompt/);
  assert.match(understanding, /Notes from them: Vegetarian\./);
  assert.match(resultInstructions("witty", profile), /call them P\./);

  assert.deepEqual(aboutUser({ name: "Praneeth", callMe: "", location: "", about: "" }), [
    "About the user (from their profile; don't assume anything it doesn't say):",
    "Call them Praneeth.",
  ]);
  const nameOnly = understandingInstructions({ now: "now", source: "wake", profile: { name: "Praneeth" } });
  assert.doesNotMatch(nameOnly, /They live in|their location/);
  for (const empty of [undefined, null, { name: " ", location: "" }]) {
    assert.doesNotMatch(understandingInstructions({ now: "now", source: "wake", profile: empty }), /About the user/);
    assert.doesNotMatch(resultInstructions("witty", empty), /About the user/);
  }
});
