// Gets music out of the way of a voice exchange, the way Siri does. Echo cancellation only removes sound this app
// plays itself, so a song from Spotify reaches the recognizer at full strength.
// - Spotify and Apple Music are paused for the whole exchange (listening, thinking, Jarvis speaking) and resumed after.
// - Any other sound (a browser video) can't be paused from outside, so the system volume drops to a quarter (about
//   −12 dB) while Jarvis listens, and comes back up while Jarvis speaks so its voice isn't ducked too. macOS only.
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The volume to duck to, or null to leave it alone (already quiet). Volumes are macOS's 0–100 output scale. */
export function duckedVolume(volume) {
  if (!Number.isFinite(volume) || volume <= 12) return null;
  return Math.max(8, Math.round(volume / 4));
}

/** Parses AppleScript's "output volume:56, input volume:75, alert volume:100, output muted:false". */
export function parseVolumeSettings(text) {
  const volume = Number(/output volume:(\d+)/.exec(text)?.[1]);
  return { volume: Number.isFinite(volume) ? volume : null, muted: /output muted:true/.test(text) };
}

async function readSettings() {
  const { stdout } = await run("osascript", ["-e", "get volume settings"], { timeout: 2000 });
  return parseVolumeSettings(stdout);
}

// Pauses the player if it is running and playing; never launches it. Prints "paused" when it did.
const PAUSE_IF_PLAYING = (player) =>
  `if application "${player}" is running then\ntell application "${player}"\nif player state is playing then\npause\nreturn "paused"\nend if\nend tell\nend if\nreturn ""`;
const RESUME_IF_PAUSED = (player) => `if application "${player}" is running then\ntell application "${player}"\nif player state is paused then play\nend tell\nend if`;
const PLAYERS = ["Spotify", "Music"];

export function createDucker(platform = process.platform) {
  let saved = null; // { volume, ducked } while ducked
  let paused = null; // players Jarvis paused, while held
  let queue = Promise.resolve();
  // Serialize: a fast wake → transcribe → listen sequence must not interleave reads and writes.
  const enqueue = (job) => (queue = queue.then(job).catch(() => {}));

  return {
    /** Pauses Spotify / Apple Music until release(). */
    hold: () =>
      enqueue(async () => {
        if (platform !== "darwin" || paused) return;
        paused = [];
        for (const player of PLAYERS) {
          try {
            const { stdout } = await run("osascript", ["-e", PAUSE_IF_PLAYING(player)], { timeout: 2000 });
            if (stdout.trim() === "paused") paused.push(player);
          } catch {
            // Not installed, or Automation permission declined: volume ducking still covers it while listening.
          }
        }
      }),
    release: () =>
      enqueue(async () => {
        if (!paused) return;
        const players = paused;
        paused = null;
        for (const player of players) {
          try {
            // Still paused means nobody touched it meanwhile; a track the user changed or stopped stays their call.
            await run("osascript", ["-e", RESUME_IF_PAUSED(player)], { timeout: 2000 });
          } catch {
            // Quit meanwhile.
          }
        }
      }),
    duck: () =>
      enqueue(async () => {
        if (platform !== "darwin" || saved) return;
        const { volume, muted } = await readSettings();
        const ducked = muted ? null : duckedVolume(volume);
        if (ducked === null) return;
        await run("osascript", ["-e", `set volume output volume ${ducked}`], { timeout: 2000 });
        saved = { volume, ducked };
      }),
    restore: () =>
      enqueue(async () => {
        if (!saved) return;
        const previous = saved;
        saved = null;
        // If the user changed the volume while ducked, their choice wins.
        const { volume } = await readSettings();
        if (volume === previous.ducked) await run("osascript", ["-e", `set volume output volume ${previous.volume}`], { timeout: 2000 });
      }),
    /** For app quit, when there is no time for the async queue. */
    restoreNow: () => {
      const previous = saved;
      const players = paused ?? [];
      saved = null;
      paused = null;
      try {
        if (previous) execFileSync("osascript", ["-e", `set volume output volume ${previous.volume}`], { timeout: 2000 });
        for (const player of players) execFileSync("osascript", ["-e", RESUME_IF_PAUSED(player)], { timeout: 2000 });
      } catch {
        // Best effort while quitting.
      }
    },
  };
}
