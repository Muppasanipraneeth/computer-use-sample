// One-step app actions bypass the desktop agent. Spotify's top search result is not necessarily the requested
// recording: verify its title and (when named) artist before confirming, and restore playback on a mismatch.
// Commands that don't match stay with the understanding model / agent. macOS only.
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const QUICK_KINDS = new Set(["play", "pause", "resume", "next", "previous", "volume", "open", "quit"]);
// "Quit" as the speech recognizer hears it: Moonshine often writes "quick" or "quite" ("Quick the slack app", real
// output). Safe because the rest must be exactly an installed app's name.
const QUIT = /^(?:quit|quits|quick|quite|kwit|close|exit|shut down|kill)\s+(?:the\s+)?(.+?)(?:\s+app(?:lication)?)?$/i;
// Words that mean "some music", not a song to search for: "play music" resumes what was playing.
const GENERIC_MUSIC = /^(some |the )?(music|songs?|a song|something|anything|spotify|my music)$/i;
// Other places to play from: those go to the agent, which knows how to use them.
const OTHER_PLAYERS = /\b(youtube|apple music|music app|itunes|netflix|prime video|soundcloud|video|movie|podcast app|vlc|in (?:chrome|safari|the browser))\b/i;

const MULTI_STEP = /\b(?:and then|after that|and also|and (?:open|launch|read|summarize|send|write|play|search|find|check|tell|create|add))\b/i;
const MUSIC_COLLECTION = /\b(?:album|playlist|mix|radio|station)\b/i;

// People say "Chrome", not "Google Chrome": an app named after its maker also answers to the rest of its name.
const MAKER = /^(?:google|microsoft|adobe|mozilla|apple)\s+(.+)$/i;

/** Lowercased name (and short name, "chrome") → real name of every app in the usual folders, read once. */
export function installedApps(folders = defaultAppFolders()) {
  const apps = new Map();
  for (const folder of folders) {
    let names = [];
    try {
      names = readdirSync(folder);
    } catch {
      continue;
    }
    for (const name of names) if (name.endsWith(".app")) apps.set(name.slice(0, -4).toLowerCase(), name.slice(0, -4));
  }
  for (const name of [...apps.values()]) {
    const short = MAKER.exec(name)?.[1].toLowerCase();
    if (short && !apps.has(short)) apps.set(short, name);
  }
  return apps;
}

/**
 * Roughly how a word sounds, so the recognizer's spellings of a name it doesn't know match it: "crime" and "chrome"
 * both become "krm". Consonants carry it; vowels after the first letter are dropped.
 */
function soundOf(text) {
  const word = text.toLowerCase().replace(/[^a-z]/g, "")
    .replace(/ph/g, "f").replace(/ch(?=r)|sch/g, "k").replace(/ck/g, "k").replace(/c(?=[eiy])/g, "s")
    .replace(/[cq]/g, "k").replace(/x/g, "ks").replace(/z/g, "s").replace(/gh/g, "");
  return (word.slice(0, 1) + word.slice(1).replace(/[aeiouyhw]/g, "")).replace(/(.)\1+/g, "$1");
}

/**
 * The installed app a spoken name means: its exact (or short) name, else, for opening only, the one app that sounds
 * the same ("Open crime." → Google Chrome, real output). Quitting never guesses: the wrong app could lose work.
 */
function appNamed(apps, name, { soundAlike = false } = {}) {
  const exact = apps.get(name.toLowerCase());
  if (exact || !soundAlike) return exact;
  const sound = soundOf(name);
  if (sound.length < 3) return undefined;
  const same = new Set([...apps].filter(([key]) => soundOf(key) === sound).map(([, real]) => real));
  return same.size === 1 ? [...same][0] : undefined;
}

function defaultAppFolders() {
  return ["/Applications", "/System/Applications", "/System/Applications/Utilities", path.join(os.homedir(), "Applications")];
}

/** Strips what speech and politeness add around a command: "Hey Jarvis, please play X." → "play X". */
function bare(text) {
  return String(text ?? "")
    .trim()
    .replace(/^(hey |ok |okay )?jarvis\b[\s,!.:]*/i, "")
    .replace(/^(please|can you|could you|would you)\s+/i, "")
    .replace(/[\s,]*(please|for me|now|thanks|thank you)?[.!?\s]*$/i, "")
    .trim();
}

/**
 * A quick action for plain wording, or null. `apps` is installedApps(). Conservative on purpose: when in doubt it
 * returns null and the understanding model (then the agent) decides.
 */
export function matchQuickAction(text, apps, platform = process.platform) {
  if (platform !== "darwin" || String(text ?? "").includes("?") || MULTI_STEP.test(text)) return null;
  const words = bare(text);
  if (!words || words.length > 120) return null;
  const spotify = apps.has("spotify");
  if (spotify && !OTHER_PLAYERS.test(words)) {
    if (/^(pause|stop)( the)?( music| song| track| spotify| playback| playing)?$/i.test(words) && !/^stop$/i.test(words)) return { do: "pause" };
    if (/^(resume|unpause|continue)( the)?( music| song| track| spotify| playback| playing)?$/i.test(words)) return { do: "resume" };
    if (/^((play )?(the )?next( song| track)?|skip( this)?( song| track)?)$/i.test(words)) return { do: "next" };
    if (/^((play )?(the )?(previous|last)( song| track)|go back a (song|track))$/i.test(words)) return { do: "previous" };
    const play = words.match(/^(?:play|put on|start playing|listen to|i (?:wanna |want to |would like to )(?:hear|listen to))\s+(?:(?:the|that|a)(?: one)?\s+(?:song|track)(?:\s+(?:called|named))?\s+)?(.+?)(?:\s+(?:on|in|from|using)\s+spotify)?$/i);
    if (play) {
      if (GENERIC_MUSIC.test(play[1])) return { do: "resume" };
      if (MUSIC_COLLECTION.test(play[1])) return null;
      const from = /^(.+?)\s+from\s+(.+)$/i.exec(play[1]);
      return { do: "play", query: from ? `${from[1]} by ${from[2]}` : play[1] };
    }
  }
  const volume = words.match(/^(?:set (?:the )?)?volume(?: to)? (\d{1,3})(?:\s*%| percent)?$/i);
  if (volume && Number(volume[1]) <= 100) return { do: "volume", level: Number(volume[1]) };
  const open = words.match(/^(?:open|launch|start)\s+(?:the\s+)?(.+?)(?:\s+app)?$/i);
  const opening = open ? appNamed(apps, open[1], { soundAlike: true }) : undefined;
  if (opening) return { do: "open", app: opening };
  const quit = words.replace(/,/g, "").match(QUIT); // "Quits, Spotify" (real output)
  const quitting = quit ? appNamed(apps, quit[1]) : undefined;
  if (quitting && quitting.toLowerCase() !== "jarvis") return { do: "quit", app: quitting };
  return null;
}

/** The understanding model's "quick" field, checked; null if absent or not runnable here. */
export function checkQuickAction(quick, apps, platform = process.platform, request = "") {
  if (platform !== "darwin" || !quick || typeof quick !== "object" || !QUICK_KINDS.has(quick.do)) return null;
  // The model cannot silently move a YouTube request into Spotify or drop a second requested step.
  if (OTHER_PLAYERS.test(request) || MULTI_STEP.test(request)) return null;
  if (["play", "pause", "resume", "next", "previous"].includes(quick.do) && !apps.has("spotify")) return null;
  if (quick.do === "play" && MUSIC_COLLECTION.test(request)) return null;
  if (quick.do === "play") {
    const query = typeof quick.query === "string" ? quick.query.replace(/\s+/g, " ").trim().slice(0, 120) : "";
    if (!query) return null;
    return GENERIC_MUSIC.test(query) ? { do: "resume" } : { do: "play", query };
  }
  if (quick.do === "volume") {
    const level = Math.round(Number(quick.level));
    return Number.isFinite(level) && level >= 0 && level <= 100 ? { do: "volume", level } : null;
  }
  if (quick.do === "open" || quick.do === "quit") {
    const app = typeof quick.app === "string" ? apps.get(quick.app.trim().toLowerCase()) : undefined;
    return app && !(quick.do === "quit" && app.toLowerCase() === "jarvis") ? { do: quick.do, app } : null;
  }
  return { do: quick.do };
}

/** The text of an AppleScript string literal. */
function quoted(text) {
  return `"${String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function run(file, args, timeout = 6000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout }, (error, stdout) => resolve({ ok: !error, out: String(stdout ?? "").trim() }));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const NOW_PLAYING = 'tell application "Spotify" to return (player state as string) & "\t" & name of current track & "\t" & artist of current track & "\t" & id of current track & "\t" & player position';

async function nowPlaying(exec) {
  const result = await exec("osascript", ["-e", NOW_PLAYING], 3000);
  if (!result.ok) return null;
  const [state, name, artist, id, position] = result.out.split("\t");
  return state && name && artist ? { state, name, artist, id, position: Number(position) } : null;
}

function requestedSong(query) {
  const by = /\s+by\s+([^]+)$/i.exec(query);
  return by && by.index > 0
    ? { title: query.slice(0, by.index), artist: by[1].trim() }
    : { title: query, artist: null };
}

function sameWords(left, right) {
  return left.normalize("NFKD").toLowerCase().replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim() ===
    right.normalize("NFKD").toLowerCase().replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function matchesSong(requested, playing) {
  // "Levitating (feat. DaBaby)" is the same title; a remix, cover or unrelated track is not.
  const title = playing.name.replace(/\s*\((?:feat\.?|featuring)\b[^)]*\)\s*$/i, "").trim();
  return sameWords(requested.title, title) && (!requested.artist || sameWords(requested.artist, playing.artist));
}

async function spotifyReady(exec, wait) {
  const command = (script) => exec("osascript", ["-e", script], 3000);
  if ((await command('application "Spotify" is running')).out === "true") return true;
  if (!(await exec("open", ["-g", "-a", "Spotify"], 6000)).ok) return false;
  for (let tries = 0; tries < 16; tries += 1) {
    await wait(250);
    if ((await command('application "Spotify" is running')).out === "true") return true;
  }
  return false;
}

async function restorePlayback(exec, wait, before) {
  const command = (script) => exec("osascript", ["-e", script], 3000);
  if (before?.id?.startsWith("spotify:track:")) {
    await command(`tell application "Spotify" to play track ${quoted(before.id)}`);
    if (Number.isFinite(before.position)) {
      await command(`tell application "Spotify" to set player position to ${before.position}`);
    }
  }
  // Spotify can finish a queued search after play track returns. Wait, then pause so an unverified result stays
  // silent even if restoring the previous song failed.
  await wait(350);
  await command('tell application "Spotify" to pause');
  const actual = await nowPlaying(exec);
  return Boolean(before?.id && actual?.id === before.id && actual.state === "paused");
}

/**
 * Quits an app the AppleScript way (as ⌘Q would: it saves state, and may ask about unsaved work), then checks that it
 * actually went. Asking `tell application … to quit` of an app that isn't running would launch it first, so that is
 * checked before.
 */
async function quitApp(app, { exec, wait }) {
  const running = async () => (await exec("osascript", ["-e", `application ${quoted(app)} is running`], 3000)).out === "true";
  if (!(await running())) return { ok: true, say: `${app} isn't open.` };
  if (!(await exec("osascript", ["-e", `tell application ${quoted(app)} to quit`], 6000)).ok) {
    return { ok: false, say: `I couldn't quit ${app}.` };
  }
  for (let tries = 0; tries < 12; tries += 1) {
    if (!(await running())) return { ok: true, say: `Quit ${app}.` };
    await wait(250);
  }
  return { ok: false, say: `${app} is still open; it may be asking you something.` };
}

/**
 * Execute without web or agent calls. A failed attempted action returns a truthful spoken failure, not a task
 * fallback that might repeat the action or search the web. `exec`/`wait` are the OS boundary used by behavior tests.
 */
export async function runQuickAction(action, { exec = run, wait = sleep } = {}) {
  const command = (script) => exec("osascript", ["-e", script], 3000);
  if (action.do === "open") {
    const opened = await exec("open", ["-a", action.app], 6000);
    return { ok: opened.ok, say: opened.ok ? `Opened ${action.app}.` : `I couldn't open ${action.app}.` };
  }
  if (action.do === "quit") return quitApp(action.app, { exec, wait });
  if (action.do === "volume") {
    const set = await command(`set volume output volume ${action.level}`);
    return { ok: set.ok, say: set.ok ? `Volume at ${action.level} percent.` : "I couldn't change the volume." };
  }
  if (!(await spotifyReady(exec, wait))) return { ok: false, say: "I couldn't open Spotify." };
  if (action.do === "pause") {
    const paused = await command('tell application "Spotify" to pause');
    return { ok: paused.ok, say: paused.ok ? "Paused." : "I couldn't pause Spotify." };
  }
  if (action.do === "play") {
    const before = await nowPlaying(exec);
    const volume = await command('tell application "Spotify" to return sound volume');
    const savedVolume = Number(volume.out);
    if (!volume.ok || !Number.isFinite(savedVolume) || !(await command('tell application "Spotify" to set sound volume to 0')).ok) {
      return { ok: false, say: "I couldn't prepare Spotify to play that." };
    }
    try {
      const played = await command(`tell application "Spotify" to play track ${quoted(`spotify:search:${action.query}`)}`);
      const requested = requestedSong(action.query);
      let current = null;
      if (played.ok) {
        for (let tries = 0; tries < 4; tries += 1) {
          current = await nowPlaying(exec);
          if (current?.state === "playing" && matchesSong(requested, current)) {
            // Spotify may report a candidate before its asynchronous search settles. Keep it muted and check that
            // the same track is still playing a moment later before telling the user it succeeded.
            await wait(350);
            const settled = await nowPlaying(exec);
            if (settled?.state === "playing" && settled.id === current.id && matchesSong(requested, settled)) {
              return { ok: true, say: `Playing ${settled.name} by ${settled.artist}.` };
            }
          }
          await wait(150);
        }
      }
      const restored = await restorePlayback(exec, wait, before);
      const name = requested.artist ? `${requested.title} by ${requested.artist}` : requested.title;
      return { ok: false, say: `Spotify couldn't verify ${name}.${restored ? " Your previous song is paused." : " Please check Spotify's player."}` };
    } finally {
      await command(`tell application "Spotify" to set sound volume to ${savedVolume}`);
    }
  }
  const before = await nowPlaying(exec);
  const script = {
    resume: 'tell application "Spotify" to play',
    next: 'tell application "Spotify" to next track',
    previous: 'tell application "Spotify" to previous track',
  }[action.do];
  if (!(await command(script)).ok) return { ok: false, say: "Spotify couldn't change the music." };
  for (let tries = 0; tries < 6; tries += 1) {
    const current = await nowPlaying(exec);
    if (current?.state === "playing" &&
      (action.do === "resume" || current.id !== before?.id)) {
      return { ok: true, say: `Playing ${current.name} by ${current.artist}.` };
    }
    await wait(150);
  }
  return { ok: false, say: "Spotify couldn't change the music." };
}
