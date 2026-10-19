import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { emptyProfile, PROFILE_FILE, readProfile, writeProfile } from "../profile.mjs";

async function withDirectory(work) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jarvis-profile-"));
  try {
    await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("a saved profile reads back trimmed, with missing fields empty", async () => {
  await withDirectory(async (directory) => {
    const nested = path.join(directory, "Jarvis");
    const saved = await writeProfile(nested, { name: "  Praneeth ", location: "Austin, TX", extra: "dropped" });
    assert.deepEqual(saved, { name: "Praneeth", callMe: "", location: "Austin, TX", about: "" });
    assert.deepEqual(await readProfile(nested), saved);
    // Renamed into place: no temp file is left beside it.
    assert.deepEqual(await readdir(nested), [PROFILE_FILE]);
    assert.deepEqual(JSON.parse(await readFile(path.join(nested, PROFILE_FILE), "utf8")), saved);
  });
});

test("a missing or damaged profile reads as empty", async () => {
  await withDirectory(async (directory) => {
    assert.deepEqual(await readProfile(directory), emptyProfile());
    await writeFile(path.join(directory, PROFILE_FILE), "{ not json");
    assert.deepEqual(await readProfile(directory), emptyProfile());
    await writeFile(path.join(directory, PROFILE_FILE), JSON.stringify({ name: 42, location: " Pune ", about: "x".repeat(3000) }));
    assert.deepEqual(await readProfile(directory), { name: "", callMe: "", location: "Pune", about: "x".repeat(2000) });
  });
});

test("saving refuses non-text and over-long fields and keeps the previous profile", async () => {
  await withDirectory(async (directory) => {
    await writeProfile(directory, { name: "Ana" });
    await assert.rejects(writeProfile(directory, null), /must be an object/);
    await assert.rejects(writeProfile(directory, { name: 7 }), /Name must be text/);
    await assert.rejects(writeProfile(directory, { location: "x".repeat(501) }), /at most 500/);
    await assert.rejects(writeProfile(directory, { about: "x".repeat(2001) }), /at most 2000/);
    assert.equal((await readProfile(directory)).name, "Ana");
    await writeProfile(directory, { about: "x".repeat(2000) });
    assert.equal((await readProfile(directory)).about.length, 2000);
  });
});
