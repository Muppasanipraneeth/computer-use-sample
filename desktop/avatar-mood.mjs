// What the floating Jarvis face shows: which expression, and whether it's on screen at all. Pure, so it's tested
// without a window. The face itself is drawn by renderer/avatar.js.

// Voice states that mean a conversation is happening (the face stays through the follow-up window, so it doesn't
// flicker between sentences), and task states worth a face when the main window is out of the way.
const TALKING = new Set(["hearing", "transcribing", "thinking", "speaking", "following"]);
const TASK = new Set(["working", "asking", "done"]);

/** The expression's state: a conversation wins over a background task, which wins over idle. */
export function faceState(voiceState, taskState) {
  if (TALKING.has(voiceState)) return voiceState;
  if (TASK.has(taskState)) return taskState;
  return "idle";
}

export function faceVisible(voiceState, taskState) {
  return faceState(voiceState, taskState) !== "idle";
}

// While the user talks and Jarvis works out the reply, the caption is the user's own words (the prompt as heard).
const HEARING = new Set(["hearing", "transcribing", "thinking"]);

/**
 * What the caption says: the user's words while they talk and Jarvis thinks, else what Jarvis last said or a task's
 * line. `heard` marks the user's words so they're drawn differently. An empty caption falls back to "Listening…" etc.
 */
export function faceCaption({ voice, text, heard }) {
  if (HEARING.has(voice)) return { caption: heard ?? "", heard: Boolean(heard) };
  return { caption: text ?? "", heard: false };
}

const SORRY = /\b(sorry|couldn'?t|can'?t|cannot|unable|failed|failure|error|didn'?t work|no luck|unfortunately|broke)\b/i;
// Dry, deadpan markers: the witty persona's sarcasm gets a wink rather than a grin.
const WRY = /\b(obviously|of course|clearly|apparently|allegedly|pretend|shockingly|naturally|as if|how original)\b/i;
const HAPPY = /(!|\b(done|great|nice|perfect|awesome|good news|all set|got it|here you go|enjoy|ready)\b)/i;

/**
 * The mood for something Jarvis says. A finished task's outcome counts first (failure is never cheerful), then the
 * words: an apology looks sorry, a question curious, a sarcastic aside winks, good news smiles.
 */
export function moodFor(text = "", outcome = null) {
  const words = String(text);
  if (outcome === "failed") return "sorry";
  if (SORRY.test(words)) return "sorry";
  if (/\?\s*["')\]]*\s*$/.test(words.trim())) return "curious";
  if (WRY.test(words)) return "wink";
  if (outcome === "completed" || HAPPY.test(words)) return "happy";
  return "neutral";
}

export const FACE_SPOTS = ["bottom-center", "bottom-right", "top-center", "top-right"];

/** Where a preset puts the window in a display's work area (which already leaves out the menu bar and Dock). */
export function spotPosition(spot, size, area, margin = 10) {
  const centreX = area.x + Math.round((area.width - size.width) / 2);
  const rightX = area.x + area.width - size.width - margin;
  const topY = area.y + margin;
  const bottomY = area.y + area.height - size.height - margin;
  if (spot === "bottom-right") return { x: rightX, y: bottomY };
  if (spot === "top-center") return { x: centreX, y: topY };
  if (spot === "top-right") return { x: rightX, y: topY };
  return { x: centreX, y: bottomY };
}

/**
 * Where the face goes: a spot it was dragged to, if that still lies on a screen (displays get unplugged), else its
 * preset (bottom-centre above the Dock, like a dictation pill) on the main screen. `areas` are display work areas,
 * the first being the primary.
 */
export function placeFace(saved, size, areas) {
  const fits = (area) =>
    saved.x >= area.x && saved.y >= area.y && saved.x + size.width <= area.x + area.width && saved.y + size.height <= area.y + area.height;
  if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y) && areas.some(fits)) return { x: Math.round(saved.x), y: Math.round(saved.y) };
  return spotPosition(FACE_SPOTS.includes(saved?.spot) ? saved.spot : "bottom-center", size, areas[0]);
}

/**
 * After a drag: within `reach` of a preset on the screen it was dropped on, it snaps there (and keeps following that
 * preset when the screen changes); anywhere else it stays exactly where it was put.
 */
export function snapFace(position, size, area, reach = 48) {
  for (const spot of FACE_SPOTS) {
    const target = spotPosition(spot, size, area);
    if (Math.abs(target.x - position.x) <= reach && Math.abs(target.y - position.y) <= reach) return { spot, ...target };
  }
  return { x: Math.round(position.x), y: Math.round(position.y) };
}

export const FACE_MODES = ["always", "talking", "off"];

/** The setting, from older versions' on/off switch too: on becomes "always" (the pill that's always there). */
export function faceMode(value) {
  if (value === true) return "always";
  if (value === false) return "off";
  return FACE_MODES.includes(value) ? value : "always";
}

export const FACE_SIZES = { small: 0.8, medium: 1, large: 1.25 };

export function faceScale(size) {
  return FACE_SIZES[size] ?? FACE_SIZES.medium;
}
