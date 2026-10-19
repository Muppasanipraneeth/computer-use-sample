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

/**
 * Where the face goes: its saved spot if that still lies on a screen (displays get unplugged), else the bottom-right
 * corner of the main screen's work area. `areas` are display work areas, the first being the primary.
 */
export function placeFace(saved, size, areas, margin = 24) {
  const fits = (area) =>
    saved && saved.x >= area.x && saved.y >= area.y && saved.x + size.width <= area.x + area.width && saved.y + size.height <= area.y + area.height;
  if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y) && areas.some(fits)) return { x: Math.round(saved.x), y: Math.round(saved.y) };
  const main = areas[0];
  return { x: main.x + main.width - size.width - margin, y: main.y + main.height - size.height - margin };
}
