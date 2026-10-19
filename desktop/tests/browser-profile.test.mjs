import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BUSY_ERROR,
  HANDOVER_REQUEST,
  KEYCHAIN_MARKER,
  adoptKeychain,
  browserProfileDirectory,
  chromiumExecutable,
  chromiumSignInArgs,
  handOverProfile,
  headlessHolder,
  openSignInBrowser,
  playwrightBrowsersRoot,
  runnerChromiumRevision,
  signInUrl,
} from "../browser-profile.mjs";

const exists = (file) => access(file).then(() => true, () => false);

test("sign-in opens only http and https pages", () => {
  assert.equal(signInUrl("https://mail.google.com"), "https://mail.google.com/");
  assert.equal(signInUrl(" http://x.com/login "), "http://x.com/login");
  for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "chrome://settings", "--headless", "mail.google.com", "", null, undefined]) {
    assert.equal(signInUrl(bad), null, String(bad));
  }
});

test("a rejected url never reaches Chromium", async () => {
  const result = await openSignInBrowser({ url: "file:///etc/passwd", userData: "/tmp/none", runnerVenv: "/tmp/none" });
  assert.deepEqual(result, { ok: false, error: "Only http and https pages can be opened for sign-in." });
});

test("the profile sits in userData next to the app's other state", () => {
  assert.equal(browserProfileDirectory(path.join("/u", "Jarvis")), path.join("/u", "Jarvis", "browser-profile"));
});

test("the visible window uses the real keychain, listens for tasks and ends with the url", () => {
  const args = chromiumSignInArgs("/p", "https://slack.com/", "darwin");
  assert.equal(args[0], "--user-data-dir=/p");
  for (const flag of ["--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0"]) assert.ok(args.includes(flag));
  assert.ok(!args.some((flag) => flag.startsWith("--use-mock-keychain") || flag.startsWith("--password-store")));
  assert.equal(args.at(-1), "https://slack.com/");
  // Linux keeps the store the runner's headless browser uses.
  assert.ok(chromiumSignInArgs("/p", "https://slack.com/", "linux").includes("--password-store=basic"));
  assert.ok(!chromiumSignInArgs("/p", "https://slack.com/", "win32").some((flag) => flag.startsWith("--password-store")));
});

test("a profile with mock-keychain cookies asks for a fresh sign-in once, on macOS only", async () => {
  const used = await mkdtemp(path.join(os.tmpdir(), "profile-"));
  await mkdir(path.join(used, "Default"));
  await writeFile(path.join(used, "Default", "Cookies"), "");
  assert.equal(await adoptKeychain(used, "darwin"), true);
  assert.equal(await adoptKeychain(used, "darwin"), false);
  const fresh = path.join(await mkdtemp(path.join(os.tmpdir(), "profile-")), "browser-profile");
  assert.equal(await adoptKeychain(fresh, "darwin"), false);
  assert.ok(await exists(path.join(fresh, KEYCHAIN_MARKER)));
  const linux = await mkdtemp(path.join(os.tmpdir(), "profile-"));
  await mkdir(path.join(linux, "Default"));
  await writeFile(path.join(linux, "Default", "Cookies"), "");
  assert.equal(await adoptKeychain(linux, "linux"), false);
  assert.equal(await exists(path.join(linux, KEYCHAIN_MARKER)), false);
});

test("a hand-over asks the runner through the profile and ends when its headless browser is gone", async () => {
  const profileDirectory = await mkdtemp(path.join(os.tmpdir(), "profile-"));
  const headless = `/pw/chrome --headless --user-data-dir=${profileDirectory} about:blank`;
  const seen = [];
  let polls = 0;
  const commandLines = async () => {
    seen.push(await exists(path.join(profileDirectory, HANDOVER_REQUEST)));
    return ++polls < 3 ? [headless] : [];
  };
  assert.equal(await handOverProfile({ profileDirectory, commandLines, intervalMs: 1 }), true);
  assert.deepEqual(seen, [true, true, true]);
  assert.equal(await exists(path.join(profileDirectory, HANDOVER_REQUEST)), false);
  assert.equal(await handOverProfile({ profileDirectory, commandLines: async () => [headless], timeoutMs: 20, intervalMs: 1 }), false);
  assert.equal(await exists(path.join(profileDirectory, HANDOVER_REQUEST)), false);
});

test("sign-in waits for the runner's headless browser, then opens the window with a DevTools port", { skip: process.platform === "win32" }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "home-"));
  const userData = await mkdtemp(path.join(os.tmpdir(), "userdata-"));
  const record = path.join(home, "args.txt");
  const directory = path.join(home, "pw", "chromium-1208", "chrome-linux64");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "chrome"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${record}'\n`);
  await chmod(path.join(directory, "chrome"), 0o755);
  const profile = browserProfileDirectory(userData);
  await mkdir(profile);
  let busy = true;
  let waiting = 0;
  const options = {
    url: "https://mail.google.com",
    userData,
    runnerVenv: path.join(home, "venv"),
    platform: "linux",
    env: { PLAYWRIGHT_BROWSERS_PATH: path.join(home, "pw") },
    home,
    onWaiting: () => waiting++,
    commandLines: async () => (busy ? [`/pw/chrome --headless --user-data-dir=${profile} about:blank`] : []),
  };
  setTimeout(() => (busy = false), 50);
  assert.deepEqual(await openSignInBrowser(options), { ok: true, waited: true, signInAgain: false });
  assert.equal(waiting, 1);
  for (let attempt = 0; attempt < 100 && !(await exists(record)); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
  const args = (await readFile(record, "utf8")).trim().split("\n");
  assert.ok(args.includes("--remote-debugging-port=0") && args.at(-1) === "https://mail.google.com/");

  busy = true;
  assert.deepEqual(await openSignInBrowser({ ...options, handoverTimeoutMs: 20 }), { ok: false, error: BUSY_ERROR });
});

test("playwright browsers are found in each platform's cache", () => {
  assert.equal(playwrightBrowsersRoot({ platform: "darwin", env: {}, home: "/Users/a" }), path.join("/Users/a", "Library", "Caches", "ms-playwright"));
  assert.equal(playwrightBrowsersRoot({ platform: "linux", env: {}, home: "/home/a" }), path.join("/home/a", ".cache", "ms-playwright"));
  assert.equal(playwrightBrowsersRoot({ platform: "win32", env: { LOCALAPPDATA: "C:\\L" }, home: "C:\\a" }), path.join("C:\\L", "ms-playwright"));
  assert.equal(playwrightBrowsersRoot({ platform: "darwin", env: { PLAYWRIGHT_BROWSERS_PATH: "/pw" }, home: "/Users/a" }), "/pw");
});

test("chromium prefers the runner's revision, else the newest installed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pw-"));
  for (const revision of ["1208", "1228"]) {
    const directory = path.join(root, `chromium-${revision}`, "chrome-linux64");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "chrome"), "");
  }
  await mkdir(path.join(root, "chromium_headless_shell-1300"));
  assert.equal(await chromiumExecutable({ root, platform: "linux" }), path.join(root, "chromium-1228", "chrome-linux64", "chrome"));
  assert.equal(await chromiumExecutable({ root, platform: "linux", revision: "1208" }), path.join(root, "chromium-1208", "chrome-linux64", "chrome"));
  assert.equal(await chromiumExecutable({ root, platform: "linux", revision: "999" }), path.join(root, "chromium-1228", "chrome-linux64", "chrome"));
  assert.equal(await chromiumExecutable({ root: path.join(root, "missing"), platform: "linux" }), null);
});

test("the runner's chromium revision comes from its Playwright package", async () => {
  const venv = await mkdtemp(path.join(os.tmpdir(), "venv-"));
  const driver = path.join(venv, "lib", "python3.12", "site-packages", "playwright", "driver", "package");
  await mkdir(driver, { recursive: true });
  await writeFile(path.join(driver, "browsers.json"), JSON.stringify({ browsers: [{ name: "chromium-headless-shell", revision: "1" }, { name: "chromium", revision: "1208" }] }));
  assert.equal(await runnerChromiumRevision(venv), "1208");
  assert.equal(await runnerChromiumRevision(path.join(venv, "nowhere")), null);
});

test("only the runner's headless chromium on this profile counts as busy", () => {
  const profile = "/Users/a/Library/Application Support/Jarvis/browser-profile";
  const visible = `/pw/Chromium --user-data-dir=${profile} --no-first-run https://mail.google.com/`;
  const headless = `/pw/chrome --disable-extensions --headless --user-data-dir=${profile} --remote-debugging-pipe about:blank`;
  const otherProfile = "/pw/chrome --headless --user-data-dir=/tmp/playwright_chromiumdev_profile-x about:blank";
  assert.equal(headlessHolder([visible, otherProfile], profile), false);
  assert.equal(headlessHolder([visible, headless], profile), true);
  assert.equal(headlessHolder([headless.replace("--headless", "--headless=new")], profile), true);
});
