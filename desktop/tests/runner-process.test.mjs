import assert from "node:assert/strict";
import test from "node:test";

import { loginShellPath, parseEnvFile } from "../runner-process.mjs";

test("the runner gets the same .env values the launcher would load", () => {
  const values = parseEnvFile([
    "# Jarvis",
    'OPENAI_API_KEY="sk-test"',
    "export COMPOSIO_API_KEY='ck_123'",
    "CLOUDFLARE_ACCOUNT_ID=abc # account",
    "EMPTY=",
    "not a line",
  ].join("\n"));
  assert.deepEqual(values, { OPENAI_API_KEY: "sk-test", COMPOSIO_API_KEY: "ck_123", CLOUDFLARE_ACCOUNT_ID: "abc", EMPTY: "" });
});

test("an app opened from the Dock picks up the login shell's PATH", { skip: process.platform === "win32" }, () => {
  const path = loginShellPath("darwin", { ...process.env, SHELL: "/bin/sh", PATH: "/usr/bin:/bin" });
  assert.ok(path.split(":").includes("/usr/bin"), path);
  assert.equal(loginShellPath("darwin", { SHELL: "/nonexistent/shell", PATH: "/fallback" }), "/fallback");
});
