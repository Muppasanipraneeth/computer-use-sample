import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { devRunner, loginShellPath, parseEnvFile, prepareRunner, standaloneEnv, standaloneRunner } from "../runner-process.mjs";

/** A bundled runner whose bin/uv is a script: it logs its arguments and fails while `fail` exists. */
async function fakeInstall() {
  const root = await mkdtemp(path.join(os.tmpdir(), "jarvis-runner-"));
  const runnerRoot = path.join(root, "runner");
  const runner = standaloneRunner({ runnerRoot, userData: path.join(root, "userData"), platform: "darwin" });
  await mkdir(path.dirname(runner.uv), { recursive: true });
  await mkdir(runner.project, { recursive: true });
  await mkdir(runner.venv, { recursive: true });
  await writeFile(path.join(runner.project, "uv.lock"), "version = 1\n");
  const calls = path.join(root, "calls.txt");
  const fail = path.join(root, "fail");
  await writeFile(runner.uv, [
    "#!/bin/sh",
    `echo "$UV_PROJECT_ENVIRONMENT $*" >> '${calls}'`,
    'echo "Resolved 3 packages" >&2',
    `if [ -e '${fail}' ]; then echo "error: network unreachable" >&2; exit 2; fi`,
    "echo done",
  ].join("\n"));
  await chmod(runner.uv, 0o755);
  const invocations = async () => (await readFile(calls, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  return { root, runner, fail, invocations };
}

test("first launch installs the packages, then the browser, and later launches skip both", { skip: process.platform === "win32" }, async () => {
  const { root, runner, invocations } = await fakeInstall();
  try {
    const events = [];
    assert.deepEqual(await prepareRunner(runner, { onProgress: (event) => events.push(event) }), { ok: true });
    const [sync, browser] = await invocations();
    assert.equal(sync, `${runner.venv} sync --project ${runner.project} --frozen --no-dev`);
    assert.equal(browser, `${runner.venv} run --project ${runner.project} --frozen --no-dev python -m playwright install chromium`);
    assert.deepEqual(events.map((event) => [event.stage, event.status, event.output ?? null]), [
      ["python", "running", null], ["python", "running", "Resolved 3 packages"], ["python", "running", "done"], ["python", "done", null],
      ["browser", "running", null], ["browser", "running", "Resolved 3 packages"], ["browser", "running", "done"], ["browser", "done", null],
    ]);
    assert.ok(events.every((event) => typeof event.message === "string" && event.message));

    assert.deepEqual(await prepareRunner(runner), { ok: true });
    assert.equal((await invocations()).length, 2);

    // An update with a new lockfile syncs again.
    await writeFile(path.join(runner.project, "uv.lock"), "version = 2\n");
    assert.deepEqual(await prepareRunner(runner), { ok: true });
    assert.equal((await invocations()).length, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed setup reports why and runs again next time", { skip: process.platform === "win32" }, async () => {
  const { root, runner, fail, invocations } = await fakeInstall();
  try {
    await writeFile(fail, "");
    const result = await prepareRunner(runner);
    assert.equal(result.ok, false);
    assert.equal(result.stage, "python");
    assert.match(result.error, /network unreachable/);
    assert.equal((await invocations()).length, 1); // the browser step never ran

    await rm(fail);
    assert.deepEqual(await prepareRunner(runner), { ok: true });
    assert.equal((await invocations()).length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("setups asked for at once share one run", { skip: process.platform === "win32" }, async () => {
  const { root, runner, invocations } = await fakeInstall();
  try {
    const results = await Promise.all([prepareRunner(runner), prepareRunner(runner)]);
    assert.deepEqual(results, [{ ok: true }, { ok: true }]);
    assert.equal((await invocations()).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an app without its bundled uv says so instead of failing to spawn", async () => {
  const runner = standaloneRunner({ runnerRoot: path.join(os.tmpdir(), "jarvis-missing-runner"), userData: path.join(os.tmpdir(), "jarvis-missing-userdata") });
  const result = await prepareRunner(runner);
  assert.equal(result.ok, false);
  assert.match(result.error, /missing its runner/);
});

test("the repo's runner needs no setup", async () => {
  assert.deepEqual(await prepareRunner(devRunner("/nowhere")), { ok: true });
});

test("the bundled runner keeps its venv, data and keys in userData", () => {
  const runner = standaloneRunner({ runnerRoot: "/App/Resources/runner", userData: "/u/Jarvis", platform: "darwin" });
  const env = standaloneEnv(runner, { PATH: "/bin", VIRTUAL_ENV: "/elsewhere/.venv", JARVIS_DATA_ROOT: "/repo/data" });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.VIRTUAL_ENV, undefined);
  assert.equal(env.UV_PROJECT_ENVIRONMENT, path.join("/u/Jarvis", "runner-venv"));
  assert.equal(env.JARVIS_DATA_ROOT, path.join("/u/Jarvis", "runner-data"));
  assert.equal(env.JARVIS_LABS_ROOT, path.join("/App/Resources/runner", "labs"));
  assert.equal(env.JARVIS_ENV_FILE, path.join("/u/Jarvis", ".env"));
  // Bytecode written next to the bundled source would break Jarvis.app's signature.
  assert.ok(env.PYTHONPYCACHEPREFIX.startsWith(runner.venv));
});

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
