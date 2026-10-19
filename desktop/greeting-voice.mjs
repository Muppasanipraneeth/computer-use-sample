// The spoken line of the launch intro ("Good morning, Praneeth. Jarvis is here."), in Jarvis's own voice. Kokoro
// needs about a second per sentence, too slow for the first second of the app, so each variant (one per part of the
// day, for the current name and voice) is rendered once in the background and kept in <userData>/greetings. The file
// is "JVG1", the sample rate as a little-endian uint32, then the samples as float32: no codec, loads in a millisecond.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const PARTS_OF_DAY = ["Good morning", "Good afternoon", "Good evening", "Working late"];
const MAGIC = "JVG1";

export function greetingText(part, name = "") {
  const who = String(name).replace(/\s+/g, " ").trim().slice(0, 60);
  return `${part}${who ? `, ${who}` : ""}. Jarvis is here.`;
}

/** Same voice and words → same file; a new name or voice simply misses and gets rendered. */
export function greetingKey(voiceId, text) {
  return createHash("sha256").update(`${voiceId}\n${text}`).digest("hex").slice(0, 20);
}

export function encodeGreeting(samples, sampleRate) {
  const buffer = Buffer.alloc(8 + samples.length * 4);
  buffer.write(MAGIC, 0, "ascii");
  buffer.writeUInt32LE(sampleRate, 4);
  Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).copy(buffer, 8);
  return buffer;
}

export function decodeGreeting(buffer) {
  if (buffer.length < 8 || buffer.toString("ascii", 0, 4) !== MAGIC || (buffer.length - 8) % 4 !== 0) return null;
  const sampleRate = buffer.readUInt32LE(4);
  if (sampleRate < 8000 || sampleRate > 96000) return null;
  // Copy out: the file buffer's offset may not be 4-byte aligned for a Float32Array view.
  const samples = new Float32Array(new Uint8Array(buffer.subarray(8)).buffer);
  return samples.length > 0 ? { samples, sampleRate } : null;
}

export async function readGreeting(directory, key) {
  try {
    return decodeGreeting(await readFile(path.join(directory, `${key}.jvg`)));
  } catch {
    return null;
  }
}

export async function writeGreeting(directory, key, samples, sampleRate) {
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, `${key}.jvg`);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, encodeGreeting(samples, sampleRate));
  await rename(temporary, target);
}

/** Drops cached greetings for an old name or voice, so the folder holds at most the four current ones. */
export async function pruneGreetings(directory, keepKeys) {
  const keep = new Set([...keepKeys].map((key) => `${key}.jvg`));
  let names = [];
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  await Promise.all(names.filter((name) => !keep.has(name)).map((name) => rm(path.join(directory, name), { force: true })));
}

/** Joins a reply's sentence chunks into one buffer. */
export function joinChunks(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const samples = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  return samples;
}
