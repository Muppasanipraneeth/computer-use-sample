import assert from "node:assert/strict";
import test from "node:test";

import { checkQuickAction, matchQuickAction, runQuickAction } from "../quick-actions.mjs";

const withSpotify = new Map([["spotify", "Spotify"], ["slack", "Slack"], ["google chrome", "Google Chrome"]]);
const withoutSpotify = new Map([["slack", "Slack"]]);
const match = (text, apps = withSpotify) => matchQuickAction(text, apps, "darwin");

test("plain music commands run at once in Spotify, whatever the polite wrapping", () => {
  assert.deepEqual(match("Hey Jarvis, please play Blinding Lights by The Weeknd."), { do: "play", query: "Blinding Lights by The Weeknd" });
  assert.deepEqual(match("i wanna hear that one song Shape of You from Ed Sheeran"), { do: "play", query: "Shape of You by Ed Sheeran" });
  assert.deepEqual(match("play the song called Levitating"), { do: "play", query: "Levitating" });
  assert.deepEqual(match("put on runaway on spotify"), { do: "play", query: "runaway" });
  assert.deepEqual(match("play some music"), { do: "resume" }, "no song named: carry on with what was playing");
  assert.deepEqual(match("pause the music"), { do: "pause" });
  assert.deepEqual(match("skip this song"), { do: "next" });
  assert.deepEqual(match("previous track"), { do: "previous" });
});

test("anything that isn't plainly a one-step command is left to the model and agent", () => {
  assert.equal(match("play lofi on youtube"), null, "another service");
  assert.equal(match("stop"), null, "bare stop means stop the task");
  assert.equal(match("play Blinding Lights", withoutSpotify), null, "no Spotify installed");
  assert.equal(match("can you play something chill?"), null, "questions go to the model");
  assert.equal(match("play Blinding Lights by The Weeknd and then open Slack"), null, "multi-step request belongs to the agent");
  assert.equal(match("play Blinding Lights and open Slack"), null, "a second action must not get lost");
  assert.equal(match("open the quarterly report and summarize it"), null, "not an installed app");
  assert.equal(matchQuickAction("play Blinding Lights", withSpotify, "win32"), null, "macOS only");
  assert.equal(match("play my running playlist"), null, "a playlist needs the richer app path");
});

test("open only names installed apps, with their real names; volume stays in range", () => {
  assert.deepEqual(match("open slack"), { do: "open", app: "Slack" });
  assert.deepEqual(match("launch the google chrome app"), { do: "open", app: "Google Chrome" });
  assert.deepEqual(match("set the volume to 30%"), { do: "volume", level: 30 });
  assert.equal(match("volume 300"), null);
});

test("the model's quick action is checked before it runs", () => {
  const check = (quick, apps = withSpotify, platform = "darwin", request = "") => checkQuickAction(quick, apps, platform, request);
  assert.deepEqual(check({ do: "play", query: "  Blinding  Lights The Weeknd " }), { do: "play", query: "Blinding Lights The Weeknd" });
  assert.deepEqual(check({ do: "play", query: "music" }), { do: "resume" });
  assert.equal(check({ do: "play", query: "" }), null);
  assert.equal(check({ do: "play", query: "x" }, withoutSpotify), null);
  assert.deepEqual(check({ do: "open", app: "SLACK" }), { do: "open", app: "Slack" });
  assert.equal(check({ do: "open", app: "Photoshop" }), null, "not installed");
  assert.equal(check({ do: "volume", level: 140 }), null);
  assert.equal(check({ do: "play", query: "Blinding Lights by The Weeknd" }, withSpotify, "darwin", "play it on YouTube"), null);
  assert.equal(check({ do: "play", query: "Blinding Lights by The Weeknd" }, withSpotify, "darwin", "play it and then open Slack"), null);
  assert.equal(check({ do: "play", query: "running" }, withSpotify, "darwin", "play my running playlist"), null);
  assert.equal(check({ do: "delete-everything" }), null);
  assert.equal(check(undefined), null);
});

// Simulate Spotify at the OS command boundary, not a model/tool echo: the returned track is a plausible cover of
// the requested title. The observable contract is no false "Playing …", restored playback and restored volume.
function spotifySession(searchResult, changeAfterCandidate = null) {
  const calls = [];
  let track = { state: "paused", name: "Old Song", artist: "Original Artist", id: "spotify:track:old", position: 42 };
  let volume = 73;
  const exec = async (_file, args) => {
    const script = args.at(-1);
    calls.push(script);
    if (script === 'application "Spotify" is running') return { ok: true, out: "true" };
    if (script.includes("return sound volume")) return { ok: true, out: String(volume) };
    if (script.includes("set sound volume to")) {
      volume = Number(script.match(/to (\d+)$/)[1]);
      return { ok: true, out: "" };
    }
    if (script.includes('return (player state as string)')) {
      return { ok: true, out: [track.state, track.name, track.artist, track.id, track.position].join("\t") };
    }
    if (script.includes('spotify:search:')) track = { ...searchResult, state: "playing", position: 0 };
    if (script.includes('spotify:track:old')) track = { state: "playing", name: "Old Song", artist: "Original Artist", id: "spotify:track:old", position: 0 };
    if (script.includes("set player position")) track.position = 42;
    if (script.includes("to pause")) track.state = "paused";
    return { ok: true, out: "" };
  };
  const wait = async (ms) => {
    if (ms === 350 && changeAfterCandidate) track = { ...changeAfterCandidate, state: "playing", position: 0 };
  };
  return { exec, wait, calls, state: () => ({ track, volume }) };
}

test("a cover cannot count as the requested artist, and playback is restored without a web fallback", async () => {
  const session = spotifySession({ name: "Blinding Lights", artist: "TommyMuzzic", id: "spotify:track:cover" });
  const result = await runQuickAction({ do: "play", query: "Blinding Lights by The Weeknd" }, session);
  assert.equal(result.ok, false);
  assert.match(result.say, /Spotify couldn't verify Blinding Lights by The Weeknd/);
  assert.deepEqual(session.state(), {
    track: { state: "paused", name: "Old Song", artist: "Original Artist", id: "spotify:track:old", position: 42 },
    volume: 73,
  });
  assert.equal(session.calls.some((call) => call.includes("spotify:track:old")), true);
  assert.equal(session.calls.some((call) => call.includes("http")), false);
});

test("Spotify's actual matching track is confirmed, including a featuring suffix", async () => {
  const session = spotifySession({ name: "Levitating (feat. DaBaby)", artist: "Dua Lipa", id: "spotify:track:duelipa" });
  const result = await runQuickAction({ do: "play", query: "Levitating by Dua Lipa" }, session);
  assert.deepEqual(result, { ok: true, say: "Playing Levitating (feat. DaBaby) by Dua Lipa." });
  assert.equal(session.state().volume, 73);
  assert.equal(session.state().track.id, "spotify:track:duelipa");
});

test("a late Spotify result cannot turn an early matching candidate into a false success", async () => {
  const session = spotifySession(
    { name: "Blinding Lights", artist: "The Weeknd", id: "spotify:track:right" },
    { name: "Blinding Lights", artist: "TommyMuzzic", id: "spotify:track:cover" },
  );
  const result = await runQuickAction({ do: "play", query: "Blinding Lights by The Weeknd" }, session);
  assert.equal(result.ok, false);
  assert.match(result.say, /Spotify couldn't verify/);
  assert.match(result.say, /Please check Spotify's player/, "do not claim to have restored a track after a late override");
  assert.equal(session.state().track.id, "spotify:track:cover");
  assert.equal(session.state().track.state, "paused");
  assert.equal(session.state().volume, 73);
});
