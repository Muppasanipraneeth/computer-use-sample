import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  browserProfileDirectory,
  chromiumExecutable,
  chromiumSignInArgs,
  headlessHolder,
  openSignInBrowser,
  playwrightBrowsersRoot,
  runnerChromiumRevision,
  signInUrl,
} from "../browser-profile.mjs";

test("sign-in opens only http and https pages", () => {
  assert.equal(signInUrl("https://mail.google.com"), "https://mail.google.com/");
  assert.equal(signInUrl(" http://x.com/login "), "http://x.com/login");
  for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "chrome://settings", "--headless", "mail.google.com", "", null, undefined]) {
    assert.equal(signInUrl(bad), null, String(bad));
  }
});

test("a rejected url never reaches Chromium", async () => {
  const result = await openSignInBrowser({ url: "file:///etc/passwd", userData: "/tmp/none", repoRoot: "/tmp/none" });
  assert.deepEqual(result, { ok: false, error: "Only http and https pages can be opened for sign-in." });
});

test("the profile sits in userData next to the app's other state", () => {
  assert.equal(browserProfileDirectory(path.join("/u", "Jarvis")), path.join("/u", "Jarvis", "browser-profile"));
});

test("the visible window shares Playwright's cookie encryption and ends with the url", () => {
  const args = chromiumSignInArgs("/p", "https://slack.com/");
  assert.equal(args[0], "--user-data-dir=/p");
  for (const flag of ["--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--password-store=basic"]) assert.ok(args.includes(flag));
  assert.equal(args.at(-1), "https://slack.com/");
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
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "repo-"));
  const driver = path.join(repoRoot, "python-app", ".venv", "lib", "python3.12", "site-packages", "playwright", "driver", "package");
  await mkdir(driver, { recursive: true });
  await writeFile(path.join(driver, "browsers.json"), JSON.stringify({ browsers: [{ name: "chromium-headless-shell", revision: "1" }, { name: "chromium", revision: "1208" }] }));
  assert.equal(await runnerChromiumRevision(repoRoot), "1208");
  assert.equal(await runnerChromiumRevision(path.join(repoRoot, "nowhere")), null);
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
