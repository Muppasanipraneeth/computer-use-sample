/**
 * What a transcript after "Hey Jarvis" asks for. Stop words act at once; anything else becomes a prompt.
 * The worker keeps a little audio from before the wake detection so a quick first word survives, which means the
 * transcript can start with the tail of the wake phrase ("Hey Jarvis," or just "-vis,"); that is removed first.
 * Short words said right after the wake phrase can still lose their first sound, so "top" counts as "stop".
 */
const WAKE_PREFIX = /^\s*(?:(?:hey|hi|okay|ok|a)[\s,.!-]+)?(?:jarvis|javis|jarvi|arvis|vis)\b[\s,.!:;-]*/i;
// The last syllable of "Jar-vis" heard on its own, e.g. "This, opened Spotify…" (real end-to-end output). Only stripped
// when it stands alone before a comma or period, so a task like "This file is old, delete it" keeps its first word.
const WAKE_TAIL = /^\s*(?:this|his|is|bis|fis|vis)[,.!]\s*/i;
const STOP = /^(?:please )?(?:stop|top|halt|abort)(?: (?:it|that|now|the run|running))?(?: please)?$/;
const CANCEL = /^(?:cancel|never ?mind|forget it|no|not that)$/;

export function parseVoiceCommand(transcript) {
  const text = String(transcript ?? "").replace(/\s+/g, " ").trim().replace(WAKE_PREFIX, "").replace(WAKE_TAIL, "");
  const words = text.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!words) return { action: "none" };
  if (STOP.test(words)) return { action: "stop" };
  if (CANCEL.test(words)) return { action: "cancel" };
  return { action: "run", prompt: text.charAt(0).toUpperCase() + text.slice(1) };
}

// "Hey Jarvis" found by the speech recognizer, as the second wake path for when the keyword spotter misses a natural
// voice. Anywhere after a greeting ("Hey, hey, hey, Jarvis…", real output), or "Jarvis" opening the sentence. Bare
// "vis" doesn't count here: on its own it is far more often another word.
const SPOKEN_WAKE = /\b(?:hey|hi|hello|okay|ok)[\s,.!-]+(?:jarvis|javis|jarvi|jervis|jarves)\b[\s,.!:;?-]*|^\W*(?:jarvis|javis|jervis)\b[\s,.!:;?-]*/i;

/** The words after the wake phrase when a transcript contains one ("" if it was just the wake phrase), else null. */
export function findWakePhrase(transcript) {
  const text = String(transcript ?? "").replace(/\s+/g, " ").trim();
  const match = SPOKEN_WAKE.exec(text);
  return match ? text.slice(match.index + match[0].length).trim() : null;
}
