// "About you" (Settings → Profile): who the user is, so Jarvis can address them and answer local questions. Stored as
// profile.json in the app's data folder, where the Python runner also reads it (app/profile.py) for typed tasks.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const PROFILE_FILE = "profile.json";
export const PROFILE_LIMITS = Object.freeze({ name: 500, callMe: 500, location: 500, about: 2000 });
const LABELS = { name: "Name", callMe: "What to call you", location: "Location", about: "About you" };

export function emptyProfile() {
  return { name: "", callMe: "", location: "", about: "" };
}

/** The saved profile, trimmed; throws a user-facing error for anything that is not a string or is too long. */
export function validateProfile(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("The profile must be an object.");
  const profile = emptyProfile();
  for (const [key, limit] of Object.entries(PROFILE_LIMITS)) {
    const value = input[key] ?? "";
    if (typeof value !== "string") throw new Error(`${LABELS[key]} must be text.`);
    const trimmed = value.trim();
    if (trimmed.length > limit) throw new Error(`${LABELS[key]} can be at most ${limit} characters.`);
    profile[key] = trimmed;
  }
  return profile;
}

/** The stored profile. A missing or damaged file reads as empty, and odd values are dropped, never guessed. */
export async function readProfile(directory) {
  let stored;
  try {
    stored = JSON.parse(await readFile(path.join(directory, PROFILE_FILE), "utf8"));
  } catch {
    return emptyProfile();
  }
  const profile = emptyProfile();
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return profile;
  for (const [key, limit] of Object.entries(PROFILE_LIMITS)) {
    if (typeof stored[key] === "string") profile[key] = stored[key].trim().slice(0, limit);
  }
  return profile;
}

/** Validates and saves; the write goes to a temp file renamed into place, so a crash never leaves half a profile. */
export async function writeProfile(directory, input) {
  const profile = validateProfile(input);
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, PROFILE_FILE);
  const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return profile;
}
