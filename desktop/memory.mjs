// Things the user asked Jarvis to remember ("my flight is on Friday"). Stored as memory.json in the app's data folder,
// which the Python runner also reads and writes, so both sides keep the same shape and limits.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const MEMORY_FILE = "memory.json";
export const MEMORY_TEXT_LIMIT = 300;
export const MEMORY_LIMIT = 100;

// One read-modify-write at a time per folder, so two quick "remember …" requests can't drop each other's memory.
const queues = new Map();

function serialized(directory, work) {
  const key = path.resolve(directory);
  const run = (queues.get(key) ?? Promise.resolve()).then(work);
  const settled = run.catch(() => {});
  queues.set(key, settled);
  settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return run;
}

function sameText(text) {
  return text.replace(/\s+/g, " ").toLowerCase();
}

/** The stored memories, oldest first. A missing or damaged file reads as none; malformed entries are dropped. */
export async function readMemories(userDataDir) {
  let stored;
  try {
    stored = JSON.parse(await readFile(path.join(userDataDir, MEMORY_FILE), "utf8"));
  } catch {
    return [];
  }
  if (!stored || typeof stored !== "object" || !Array.isArray(stored.memories)) return [];
  const memories = [];
  for (const entry of stored.memories) {
    if (typeof entry?.id !== "string" || typeof entry.text !== "string" || typeof entry.createdAt !== "string") continue;
    const text = entry.text.trim().slice(0, MEMORY_TEXT_LIMIT);
    if (text) memories.push({ id: entry.id, text, createdAt: entry.createdAt });
  }
  return memories.slice(-MEMORY_LIMIT);
}

async function writeMemories(userDataDir, memories) {
  await mkdir(userDataDir, { recursive: true });
  const target = path.join(userDataDir, MEMORY_FILE);
  const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ memories }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Remembers `text` (trimmed) and returns the whole list. Text already remembered, ignoring case and spacing, is not
 * stored twice; past MEMORY_LIMIT the oldest memories are dropped. Throws a user-facing error for empty or long text.
 */
export function addMemory(userDataDir, text) {
  if (typeof text !== "string" || !text.trim()) return Promise.reject(new Error("There is nothing to remember."));
  const trimmed = text.trim();
  if (trimmed.length > MEMORY_TEXT_LIMIT) {
    return Promise.reject(new Error(`A memory can be at most ${MEMORY_TEXT_LIMIT} characters.`));
  }
  return serialized(userDataDir, async () => {
    const memories = await readMemories(userDataDir);
    if (memories.some((memory) => sameText(memory.text) === sameText(trimmed))) return memories;
    memories.push({ id: randomUUID(), text: trimmed, createdAt: new Date().toISOString() });
    const kept = memories.slice(-MEMORY_LIMIT);
    await writeMemories(userDataDir, kept);
    return kept;
  });
}

/** Forgets the memory with this id and returns the remaining list; an unknown id changes nothing. */
export function removeMemory(userDataDir, id) {
  return serialized(userDataDir, async () => {
    const memories = await readMemories(userDataDir);
    const remaining = memories.filter((memory) => memory.id !== id);
    if (remaining.length !== memories.length) await writeMemories(userDataDir, remaining);
    return remaining;
  });
}
