// Schedules are local wall-clock times, so pin a zone with daylight saving before any date is made.
process.env.TZ = "America/New_York";

import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  describeSchedule,
  dueRoutines,
  nextRunAt,
  readRoutines,
  ROUTINES_FILE,
  updateRoutine,
  validateRoutine,
  writeRoutines,
} from "../routines.mjs";

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

function routine(fields) {
  return validateRoutine({ prompt: "Summarise my inbox", time: "08:00", days: EVERY_DAY, createdAt: "2026-01-01T00:00:00Z", ...fields });
}

function isDue(item, now) {
  return dueRoutines([item], new Date(now)).length === 1;
}

async function withDirectory(work) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jarvis-routines-"));
  try {
    await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("only the chosen days fire", () => {
  // 2026-10-19 is a Monday.
  const item = routine({ time: "07:15", days: [1, 3], lastRunAt: "2026-10-14T11:15:00Z" });
  assert.equal(isDue(item, "2026-10-19T07:20:00-04:00"), true);
  assert.equal(isDue(item, "2026-10-20T07:20:00-04:00"), false);
  assert.equal(nextRunAt(item, new Date("2026-10-19T07:20:00-04:00")).toISOString(), "2026-10-21T11:15:00.000Z");
  // From Wednesday evening the next run is the following Monday.
  assert.equal(nextRunAt(item, new Date("2026-10-21T20:00:00-04:00")).toISOString(), "2026-10-26T11:15:00.000Z");
});

test("a missed run catches up for exactly six hours, and only once", () => {
  const item = routine({ lastRunAt: "2026-10-18T12:00:00Z" });
  assert.equal(isDue(item, "2026-10-19T07:59:59-04:00"), false);
  assert.equal(isDue(item, "2026-10-19T08:00:00-04:00"), true);
  assert.equal(isDue(item, "2026-10-19T14:00:00-04:00"), true);
  assert.equal(isDue(item, "2026-10-19T14:00:00.001-04:00"), false);
  const ran = { ...item, lastRunAt: "2026-10-19T12:30:00Z" };
  assert.equal(isDue(ran, "2026-10-19T09:00:00-04:00"), false);
  assert.equal(isDue(ran, "2026-10-20T08:00:00-04:00"), true);
});

test("a routine that never ran counts from its creation", () => {
  const late = routine({ createdAt: "2026-10-19T08:05:00-04:00" });
  assert.equal(isDue(late, "2026-10-19T08:10:00-04:00"), false);
  assert.equal(isDue(late, "2026-10-20T08:00:00-04:00"), true);
  const early = routine({ createdAt: "2026-10-19T07:59:00-04:00" });
  assert.equal(isDue(early, "2026-10-19T08:00:00-04:00"), true);
});

test("a disabled routine never fires and has no next run", () => {
  const item = routine({ enabled: false, lastRunAt: "2026-10-18T12:00:00Z" });
  assert.equal(isDue(item, "2026-10-19T08:00:00-04:00"), false);
  assert.equal(nextRunAt(item, new Date("2026-10-19T07:00:00-04:00")), null);
});

test("a time skipped by the spring-forward jump runs once, just after it", () => {
  // 2026-03-08: clocks jump from 2:00 EST to 3:00 EDT, so 2:30 never happens; it runs at 3:30 EDT instead.
  const item = routine({ time: "02:30", lastRunAt: "2026-03-07T07:30:00Z" });
  assert.equal(nextRunAt(item, new Date("2026-03-08T01:00:00-05:00")).toISOString(), "2026-03-08T07:30:00.000Z");
  assert.equal(isDue(item, "2026-03-08T03:29:00-04:00"), false);
  assert.equal(isDue(item, "2026-03-08T03:30:00-04:00"), true);
  const ran = { ...item, lastRunAt: "2026-03-08T07:30:00Z" };
  assert.equal(isDue(ran, "2026-03-08T05:00:00-04:00"), false);
  assert.equal(nextRunAt(ran, new Date("2026-03-08T05:00:00-04:00")).toISOString(), "2026-03-09T06:30:00.000Z");
});

test("a time repeated by the fall-back change runs only at its first occurrence", () => {
  // 2026-11-01: 1:00–2:00 happens twice (EDT, then EST).
  const item = routine({ time: "01:30", lastRunAt: "2026-10-31T05:30:00Z" });
  assert.equal(isDue(item, "2026-11-01T01:30:00-04:00"), true);
  const ran = { ...item, lastRunAt: "2026-11-01T05:30:00Z" };
  assert.equal(isDue(ran, "2026-11-01T01:30:00-05:00"), false);
});

test("validation explains what is wrong and normalises the rest", () => {
  const normalised = validateRoutine({ prompt: "  Check the weather ", time: "7:05", days: [5, 1, 1] });
  assert.equal(normalised.prompt, "Check the weather");
  assert.equal(normalised.time, "07:05");
  assert.deepEqual(normalised.days, [1, 5]);
  assert.equal(normalised.enabled, true);
  assert.equal(normalised.lastRunAt, null);
  assert.ok(normalised.id && normalised.createdAt);

  const valid = { prompt: "Check the weather", time: "07:05", days: [1] };
  assert.throws(() => validateRoutine({ ...valid, prompt: "   " }), /what the routine should do/);
  assert.throws(() => validateRoutine({ ...valid, prompt: "x".repeat(2001) }), /at most 2000/);
  assert.doesNotThrow(() => validateRoutine({ ...valid, prompt: "x".repeat(2000) }));
  for (const time of ["24:00", "07:60", "7", "07:5", "", 700]) {
    assert.throws(() => validateRoutine({ ...valid, time }), /Pick a time/, String(time));
  }
  assert.throws(() => validateRoutine({ ...valid, days: [] }), /at least one day/);
  assert.throws(() => validateRoutine({ ...valid, days: [7] }), /0 \(Sunday\) to 6/);
  assert.throws(() => validateRoutine({ ...valid, days: [1.5] }), /0 \(Sunday\) to 6/);
  assert.throws(() => validateRoutine({ ...valid, enabled: "yes" }), /true or false/);
});

test("rescheduling or re-enabling never fires a time that already passed", () => {
  const existing = routine({ time: "09:00", lastRunAt: "2026-10-18T13:00:00Z" });
  const now = new Date("2026-10-19T08:30:00-04:00");
  const moved = updateRoutine(existing, { time: "08:00" }, now);
  assert.equal(isDue(moved, "2026-10-19T08:31:00-04:00"), false);
  assert.equal(isDue(moved, "2026-10-20T08:00:00-04:00"), true);

  const reenabled = updateRoutine({ ...existing, enabled: false }, { enabled: true }, new Date("2026-10-19T10:00:00-04:00"));
  assert.equal(isDue(reenabled, "2026-10-19T10:01:00-04:00"), false);

  const reworded = updateRoutine(existing, { prompt: "Read my calendar", id: "other" }, now);
  assert.equal(reworded.id, existing.id);
  assert.equal(reworded.lastRunAt, existing.lastRunAt);
});

test("routines round-trip, and a missing or damaged file reads as none", async () => {
  await withDirectory(async (directory) => {
    assert.deepEqual(await readRoutines(directory), []);
    const saved = await writeRoutines(path.join(directory, "Jarvis"), [routine({ id: "a" }), routine({ id: "b", days: [2] })]);
    assert.deepEqual(await readRoutines(path.join(directory, "Jarvis")), saved);
    assert.deepEqual(await readdir(path.join(directory, "Jarvis")), [ROUTINES_FILE]);
    await assert.rejects(writeRoutines(directory, [{ prompt: "" }]), /what the routine should do/);

    await writeFile(path.join(directory, ROUTINES_FILE), "{ not json");
    assert.deepEqual(await readRoutines(directory), []);
    const good = routine({ id: "good" });
    await writeFile(path.join(directory, ROUTINES_FILE), JSON.stringify({ routines: [good, { ...good, id: "bad", days: [] }, { prompt: "no id" }] }));
    assert.deepEqual(await readRoutines(directory), [good]);
  });
});

test("schedules read naturally", () => {
  assert.equal(describeSchedule(routine({ time: "08:00" })), "Every day at 8:00");
  assert.equal(describeSchedule(routine({ time: "18:30", days: [1, 2, 3, 4, 5] })), "Weekdays at 18:30");
  assert.equal(describeSchedule(routine({ time: "10:00", days: [0, 6] })), "Weekends at 10:00");
  assert.equal(describeSchedule(routine({ time: "07:15", days: [1] })), "Every Monday at 7:15");
  assert.equal(describeSchedule(routine({ time: "07:15", days: [3, 1] })), "Mon, Wed at 7:15");
  assert.equal(describeSchedule(routine({ time: "00:05", days: [0, 1, 5] })), "Mon, Fri, Sun at 0:05");
});
