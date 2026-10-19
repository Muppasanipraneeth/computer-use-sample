import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { addMemory, MEMORY_FILE, MEMORY_LIMIT, readMemories, removeMemory } from "../memory.mjs";

async function withDirectory(work) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jarvis-memory-"));
  try {
    await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("memories are trimmed, saved in order and not stored twice", async () => {
  await withDirectory(async (directory) => {
    await addMemory(directory, "  My flight is on Friday ");
    const list = await addMemory(directory, "I prefer window seats");
    assert.deepEqual(list.map((memory) => memory.text), ["My flight is on Friday", "I prefer window seats"]);
    assert.deepEqual(await addMemory(directory, "my FLIGHT  is on friday"), list);
    assert.deepEqual(await readMemories(directory), list);
    assert.deepEqual(await readdir(directory), [MEMORY_FILE]);
    const stored = JSON.parse(await readFile(path.join(directory, MEMORY_FILE), "utf8"));
    assert.deepEqual(stored, { memories: list });
    assert.ok(list.every((memory) => memory.id && !Number.isNaN(Date.parse(memory.createdAt))));
  });
});

test("empty or over-long text is refused and nothing is saved", async () => {
  await withDirectory(async (directory) => {
    await assert.rejects(addMemory(directory, "   "), /nothing to remember/);
    await assert.rejects(addMemory(directory, "x".repeat(301)), /at most 300/);
    assert.deepEqual(await readMemories(directory), []);
    assert.equal((await addMemory(directory, `  ${"x".repeat(300)}  `))[0].text.length, 300);
  });
});

test("past the cap the oldest memories are dropped", async () => {
  await withDirectory(async (directory) => {
    let list = [];
    for (let index = 0; index <= MEMORY_LIMIT; index += 1) list = await addMemory(directory, `fact ${index}`);
    assert.equal(list.length, MEMORY_LIMIT);
    assert.equal(list[0].text, "fact 1");
    assert.equal(list.at(-1).text, `fact ${MEMORY_LIMIT}`);
  });
});

test("concurrent additions are all kept", async () => {
  await withDirectory(async (directory) => {
    await Promise.all(["one", "two", "three"].map((text) => addMemory(directory, text)));
    assert.deepEqual((await readMemories(directory)).map((memory) => memory.text).sort(), ["one", "three", "two"]);
  });
});

test("removing forgets only that memory", async () => {
  await withDirectory(async (directory) => {
    await addMemory(directory, "keep me");
    const [, gone] = await addMemory(directory, "forget me");
    assert.deepEqual((await removeMemory(directory, gone.id)).map((memory) => memory.text), ["keep me"]);
    assert.deepEqual((await removeMemory(directory, "unknown")).map((memory) => memory.text), ["keep me"]);
  });
});

test("a missing or damaged file reads as no memories, and bad entries are dropped", async () => {
  await withDirectory(async (directory) => {
    assert.deepEqual(await readMemories(directory), []);
    await writeFile(path.join(directory, MEMORY_FILE), "{ not json");
    assert.deepEqual(await readMemories(directory), []);
    await writeFile(path.join(directory, MEMORY_FILE), JSON.stringify({ memories: "nope" }));
    assert.deepEqual(await readMemories(directory), []);
    const good = { id: "a", text: " Likes tea ", createdAt: "2026-10-19T08:00:00.000Z" };
    await writeFile(path.join(directory, MEMORY_FILE), JSON.stringify({ memories: [good, { id: "b", text: 4 }, { id: "c", text: "  ", createdAt: "x" }] }));
    assert.deepEqual(await readMemories(directory), [{ ...good, text: "Likes tea" }]);
    // A damaged file is replaced on the next save rather than blocking it.
    await writeFile(path.join(directory, MEMORY_FILE), "{ not json");
    assert.deepEqual((await addMemory(directory, "fresh start")).map((memory) => memory.text), ["fresh start"]);
  });
});
