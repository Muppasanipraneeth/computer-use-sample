// Hold Control to talk. The native watcher (desktop/native/control-key.swift) reports "down", "up" and "other"; this
// decides what counts as talking. A hold must last HOLD_MS with nothing else pressed, so Ctrl+C, Ctrl+click and quick
// taps never open the microphone; the audio from the moment Control went down is kept (the worker looks back), so
// the first word isn't lost to the wait.
export const HOLD_MS = 250;

/**
 * @param {{ start: () => void, end: () => void, cancel: () => void, holdMs?: number,
 *   setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} handlers
 *   start: Control has been held alone long enough, so listen. end: released, so take what was said.
 *   cancel: another key joined after listening began, so it was a shortcut after all.
 */
export function createHoldKey({ start, end, cancel, holdMs = HOLD_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let phase = "idle"; // idle | pressing | talking | spoiled (part of a shortcut; ignored until Control is released)
  let timer = null;
  const stopTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  return {
    handle(line) {
      if (line === "down" && phase === "idle") {
        phase = "pressing";
        timer = setTimer(() => {
          timer = null;
          phase = "talking";
          start();
        }, holdMs);
      } else if (line === "other") {
        stopTimer();
        if (phase === "talking") cancel();
        if (phase !== "idle") phase = "spoiled";
      } else if (line === "up") {
        stopTimer();
        const was = phase;
        phase = "idle";
        if (was === "talking") end();
      }
    },
    /** The watcher went away mid-hold: whatever was being heard is dropped. */
    reset() {
      stopTimer();
      if (phase === "talking") cancel();
      phase = "idle";
    },
  };
}
