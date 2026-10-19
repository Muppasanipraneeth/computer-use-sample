// Routines (Settings → Routines): prompts Jarvis runs by itself at a set local time on chosen days ("summarise my
// inbox" on weekdays at 8:00). Stored as routines.json in the app's data folder. Times are wall-clock times in the
// Mac's time zone, so 8:00 stays 8:00 across daylight-saving changes. Pure module: main.mjs owns the timer and runs.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const ROUTINES_FILE = "routines.json";
export const PROMPT_LIMIT = 2000;
// A routine missed while the Mac slept or Jarvis was closed still runs once on wake, unless it is this stale.
export const CATCH_UP_MS = 6 * 60 * 60 * 1000;

const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LONG_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function isoOrNull(value) {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The routine normalised (trimmed prompt, "HH:MM", sorted days); throws a user-facing error when it can't be saved. */
export function validateRoutine(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("The routine must be an object.");

  if (typeof input.prompt !== "string" || !input.prompt.trim()) throw new Error("Tell Jarvis what the routine should do.");
  const prompt = input.prompt.trim();
  if (prompt.length > PROMPT_LIMIT) throw new Error(`The routine can be at most ${PROMPT_LIMIT} characters.`);

  const clock = typeof input.time === "string" ? /^(\d{1,2}):(\d{2})$/.exec(input.time.trim()) : null;
  if (!clock || Number(clock[1]) > 23 || Number(clock[2]) > 59) throw new Error("Pick a time like 08:00 or 18:30.");
  const time = `${clock[1].padStart(2, "0")}:${clock[2]}`;

  if (!Array.isArray(input.days) || input.days.length === 0) throw new Error("Pick at least one day.");
  if (!input.days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)) {
    throw new Error("Days must be numbers from 0 (Sunday) to 6 (Saturday).");
  }
  const days = [...new Set(input.days)].sort((a, b) => a - b);

  const enabled = input.enabled ?? true;
  if (typeof enabled !== "boolean") throw new Error("Enabled must be true or false.");

  return {
    id: typeof input.id === "string" && input.id.trim() ? input.id.trim() : randomUUID(),
    prompt,
    time,
    days,
    enabled,
    lastRunAt: isoOrNull(input.lastRunAt),
    createdAt: isoOrNull(input.createdAt) ?? new Date().toISOString(),
  };
}

/**
 * `existing` with `changes` applied; id, createdAt and lastRunAt are kept. When the time or days change, or the routine
 * is switched back on, lastRunAt moves to `now`: it is the catch-up baseline, so an edit never fires a time that has
 * already passed today (a routine moved from 9:00 to 8:00 at 8:30 waits for tomorrow).
 */
export function updateRoutine(existing, changes, now = new Date()) {
  const routine = validateRoutine({ ...existing, ...changes, id: existing.id, createdAt: existing.createdAt, lastRunAt: existing.lastRunAt });
  const rescheduled = routine.time !== existing.time || routine.days.join() !== [...existing.days].sort((a, b) => a - b).join();
  if (rescheduled || (routine.enabled && !existing.enabled)) routine.lastRunAt = now.toISOString();
  return routine;
}

/** The stored routines. A missing or damaged file reads as none; entries that are not valid routines are dropped. */
export async function readRoutines(userDataDir) {
  let stored;
  try {
    stored = JSON.parse(await readFile(path.join(userDataDir, ROUTINES_FILE), "utf8"));
  } catch {
    return [];
  }
  if (!stored || typeof stored !== "object" || !Array.isArray(stored.routines)) return [];
  const routines = [];
  for (const entry of stored.routines) {
    if (typeof entry?.id !== "string" || typeof entry.createdAt !== "string") continue;
    try {
      routines.push(validateRoutine(entry));
    } catch {
      // A hand-edited entry that no longer validates is skipped rather than guessed at.
    }
  }
  return routines;
}

/** Validates every routine and saves the list; temp file + rename, so a crash never leaves half a file. */
export async function writeRoutines(userDataDir, list) {
  if (!Array.isArray(list)) throw new Error("Routines must be a list.");
  const routines = list.map((routine) => validateRoutine(routine));
  await mkdir(userDataDir, { recursive: true });
  const target = path.join(userDataDir, ROUTINES_FILE);
  const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ routines }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return routines;
}

// The scheduled moment on the local calendar day `offset` days from `now`'s, or null when the routine skips that day.
// Built from wall-clock parts, so DST is the Date constructor's job: a time inside the hour skipped when clocks spring
// forward (2:30) lands at the same distance past the jump (3:30, still once that day); a time repeated when clocks fall
// back (1:30) means its first occurrence.
function scheduledOn(routine, now, offset) {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  if (!routine.days.includes(day.getDay())) return null;
  const [hours, minutes] = routine.time.split(":").map(Number);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hours, minutes);
}

function latestScheduled(routine, now) {
  for (let offset = 0; offset <= 7; offset += 1) {
    const at = scheduledOn(routine, now, -offset);
    if (at && at <= now) return at;
  }
  return null;
}

/** When the routine fires next (strictly after `now`), or null when it is switched off. */
export function nextRunAt(routine, now) {
  if (!routine.enabled) return null;
  for (let offset = 0; offset <= 7; offset += 1) {
    const at = scheduledOn(routine, now, offset);
    if (at && at > now) return at;
  }
  return null;
}

/**
 * The routines to run now: their latest scheduled time has arrived, comes after their last run (or their creation, when
 * they never ran, so one created at 8:05 for 8:00 waits for the next day) and is at most CATCH_UP_MS old. After running
 * one, set its lastRunAt to now so it is not due again.
 */
export function dueRoutines(routines, now) {
  return routines.filter((routine) => {
    if (!routine.enabled) return false;
    const scheduled = latestScheduled(routine, now);
    if (!scheduled) return false;
    const since = Date.parse(routine.lastRunAt ?? routine.createdAt);
    return scheduled.getTime() > since && now.getTime() - scheduled.getTime() <= CATCH_UP_MS;
  });
}

/** Short text for the list: "Every day at 8:00", "Weekdays at 18:30", "Every Monday at 7:15", "Mon, Wed at 7:15". */
export function describeSchedule(routine) {
  const [hours, minutes] = routine.time.split(":");
  const at = `${Number(hours)}:${minutes}`;
  const days = [...new Set(routine.days)].sort((a, b) => a - b);
  const key = days.join();
  if (days.length === 7) return `Every day at ${at}`;
  if (key === "1,2,3,4,5") return `Weekdays at ${at}`;
  if (key === "0,6") return `Weekends at ${at}`;
  if (days.length === 1) return `Every ${LONG_DAYS[days[0]]} at ${at}`;
  // Monday first, the way people read a week.
  const ordered = days.sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  return `${ordered.map((day) => SHORT_DAYS[day]).join(", ")} at ${at}`;
}
