import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLogger, logDirectory, redact, tailFile } from "../logger.mjs";

test("keys and tokens never reach the log", () => {
  const line = redact("saved COMPOSIO_API_KEY=ak_live1234567890 and sk-proj-abcdefghijkl, header Bearer abc.def.ghijklmnop, OPENAI_API_KEY: 'x1'");
  for (const secret of ["ak_live1234567890", "sk-proj-abcdefghijkl", "abc.def.ghijklmnop", "'x1'"]) assert.equal(line.includes(secret), false, secret);
  assert.match(line, /COMPOSIO_API_KEY=\[redacted\]/);
  assert.equal(redact("Run 1b2c finished in 48 s"), "Run 1b2c finished in 48 s");
});

test("the log rolls over at its size limit and keeps a fixed number of old files", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "jarvis-log-"));
  try {
    const log = createLogger({ directory, maxBytes: 200, kept: 2 });
    for (let index = 0; index < 40; index += 1) log.info(`line ${index} ${"x".repeat(20)}`);
    assert.deepEqual(readdirSync(directory).sort(), ["desktop.log", "desktop.log.1", "desktop.log.2"]);
    assert.match(readFileSync(path.join(directory, "desktop.log"), "utf8"), /line 39/);
    log.error("runner failed", new Error("boom\nsecond line"));
    // Continuation lines are indented so every entry still starts with its timestamp.
    assert.match(tailFile(log.path, 50), /ERROR runner failed \| Error: boom\n {4}second line\n {8}at /);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("logs go where the runner's go", () => {
  assert.equal(logDirectory({}, "darwin", "/Users/a"), "/Users/a/Library/Logs/Jarvis");
  assert.equal(logDirectory({ LOCALAPPDATA: "C:\\L" }, "win32", "C:\\U"), path.join("C:\\L", "Jarvis", "logs"));
  assert.equal(logDirectory({ JARVIS_LOG_DIR: "/tmp/x" }, "darwin", "/Users/a"), "/tmp/x");
});
