// Jarvis's own browser profile: the user signs in to websites once in a visible Chromium window, and the runner's
// shared browser (python-app/app/local_browser_host.py, one for all running tasks) reuses the cookies later. Only one
// Chromium can open a profile, so the two take turns: the sign-in window listens on a DevTools port and the runner
// attaches to it while it is open; while the runner's headless browser runs, a sign-in asks it to hand the profile over.
import { execFile, spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const BUSY_ERROR = "Jarvis's browser is still busy with a task step; try again in a minute.";
// File names inside the profile; must match python-app/app/local_browser_host.py.
export const HANDOVER_REQUEST = "JarvisSignInRequest";
export const KEYCHAIN_MARKER = "JarvisKeychain";
// The runner lets a running model step finish (60 s deadline plus its interrupt grace) before handing over.
const HANDOVER_TIMEOUT_MS = 90_000;

/** Must match browser_profile_directory() in python-app/app/scenario_runtime.py. */
export function browserProfileDirectory(userData) {
  return path.join(userData, "browser-profile");
}

/** Only web pages may be opened: file:, javascript: and custom schemes must never reach Chromium's command line. */
export function signInUrl(value) {
  try {
    const url = new URL(String(value).trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Where Playwright installs browsers (its own default unless PLAYWRIGHT_BROWSERS_PATH points elsewhere). */
export function playwrightBrowsersRoot({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const custom = env.PLAYWRIGHT_BROWSERS_PATH;
  if (custom && custom !== "0") return custom;
  if (platform === "darwin") return path.join(home, "Library", "Caches", "ms-playwright");
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "ms-playwright");
  return path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), "ms-playwright");
}

// Executable locations inside a chromium-<revision> folder: Chrome for Testing builds first, older Chromium builds after.
const EXECUTABLES = {
  darwin: [
    ["chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
    ["chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
    ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
  ],
  win32: [
    ["chrome-win64", "chrome.exe"],
    ["chrome-win", "chrome.exe"],
  ],
  linux: [
    ["chrome-linux64", "chrome"],
    ["chrome-linux", "chrome"],
  ],
};

/**
 * Picks an installed Playwright Chromium: the runner's own revision when known, so the visible window and the headless
 * runner write the profile with the same Chrome version (a newer Chrome can migrate files an older one cannot read),
 * otherwise the newest installed revision. Returns null when none is installed.
 */
export async function chromiumExecutable({ root, platform = process.platform, revision = null }) {
  let names;
  try {
    names = await readdir(root);
  } catch {
    return null;
  }
  const revisions = names
    .map((name) => /^chromium-(\d+)$/.exec(name)?.[1])
    .filter(Boolean)
    .sort((a, b) => Number(b) - Number(a));
  if (revision && revisions.includes(revision)) revisions.unshift(revision);
  for (const candidate of revisions) {
    for (const parts of EXECUTABLES[platform] ?? EXECUTABLES.linux) {
      const file = path.join(root, `chromium-${candidate}`, ...parts);
      if (await isFile(file)) return file;
    }
  }
  return null;
}

async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** The Chromium revision the runner's Python Playwright launches, read from the bundled browsers.json in its venv. */
export async function runnerChromiumRevision(venv) {
  const packages = [path.join(venv, "Lib", "site-packages")];
  try {
    for (const name of await readdir(path.join(venv, "lib"))) packages.push(path.join(venv, "lib", name, "site-packages"));
  } catch {
    // Windows virtualenvs have no lib/python3.x folder.
  }
  for (const directory of packages) {
    try {
      const manifest = JSON.parse(await readFile(path.join(directory, "playwright", "driver", "package", "browsers.json"), "utf8"));
      const chromium = manifest?.browsers?.find((browser) => browser?.name === "chromium");
      if (typeof chromium?.revision === "string") return chromium.revision;
    } catch {
      // Not this interpreter's site-packages; try the next.
    }
  }
  return null;
}

/**
 * Arguments for the visible window. No --use-mock-keychain: on macOS cookies are encrypted with the "Chromium Safe
 * Storage" Keychain item, which the runner's headless Chromium uses too. Linux keeps the basic store, as the runner
 * does, since both browsers must use the same one. The DevTools port (127.0.0.1, written to DevToolsActivePort in the
 * profile) lets running tasks browse in this window instead of waiting for it to close.
 */
export function chromiumSignInArgs(profileDirectory, url, platform = process.platform) {
  return [
    `--user-data-dir=${profileDirectory}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    ...(platform === "linux" ? ["--password-store=basic"] : []),
    url,
  ];
}

/**
 * Marks the profile as encrypted with the macOS Keychain's key. True only the first time, for a profile that already
 * has cookies: Jarvis used to run its browsers with Chromium's mock keychain, and those cookies can't be read now.
 * Same rule as adopt_keychain() in python-app/app/local_browser_host.py, which may see the profile first.
 */
export async function adoptKeychain(profileDirectory, platform = process.platform) {
  if (platform !== "darwin") return false;
  const marker = path.join(profileDirectory, KEYCHAIN_MARKER);
  if (await isFile(marker)) return false;
  const hadCookies = await isFile(path.join(profileDirectory, "Default", "Cookies"));
  await mkdir(profileDirectory, { recursive: true });
  await writeFile(marker, "keychain\n");
  return hadCookies;
}

/** True when one of these process command lines is a headless Chromium (the runner's) on this profile. */
export function headlessHolder(commandLines, profileDirectory) {
  const marker = `--user-data-dir=${profileDirectory}`;
  return commandLines.some((line) => line.includes(marker) && /(^|\s)--headless(=\S*)?(\s|$)/.test(line));
}

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

/** Full command lines of running processes; `ww` stops ps from cutting long Chromium argument lists short. */
export async function processCommandLines(platform = process.platform) {
  const stdout =
    platform === "win32"
      ? await run("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | ForEach-Object { $_.CommandLine }",
        ])
      : await run("ps", ["-axww", "-o", "command="]);
  return stdout.split(/\r?\n/).filter(Boolean);
}

/**
 * Asks the runner's headless browser for the profile: it lets the running model step finish, closes, and attaches to
 * the sign-in window once that opens. Resolves true once no headless Chromium holds the profile (the run may also just
 * have ended), false after timeoutMs.
 */
export async function handOverProfile({ profileDirectory, commandLines, timeoutMs = HANDOVER_TIMEOUT_MS, intervalMs = 500 }) {
  const request = path.join(profileDirectory, HANDOVER_REQUEST);
  await writeFile(request, `${new Date().toISOString()}\n`);
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      if (!headlessHolder(await commandLines(), profileDirectory)) return true;
    }
    return false;
  } finally {
    // The runner removes it when it hands over; this covers a run that ended first, or a timeout.
    await rm(request, { force: true });
  }
}

/**
 * Opens a visible Chromium on Jarvis's profile at url. Spawning again while a sign-in window is open simply opens the
 * url in that window: Chromium hands it to the running instance that owns the --user-data-dir and exits. While a task
 * browses in the runner's headless browser, onWaiting() is called and the window opens once the runner hands the
 * profile over (usually at once; at most after the task's current step).
 *
 * Resolves { ok: true, waited, signInAgain } or { ok: false, error }. waited: the window had to wait for a task step.
 * signInAgain: logins saved before the switch to the macOS Keychain are gone, so the user must sign in to sites again.
 */
export async function openSignInBrowser({
  url,
  userData,
  runnerVenv,
  onWaiting = () => {},
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  commandLines = () => processCommandLines(platform),
  handoverTimeoutMs = HANDOVER_TIMEOUT_MS,
}) {
  const target = signInUrl(url);
  if (!target) return { ok: false, error: "Only http and https pages can be opened for sign-in." };
  const profileDirectory = browserProfileDirectory(userData);
  const root = playwrightBrowsersRoot({ platform, env, home });
  const executable = await chromiumExecutable({ root, platform, revision: await runnerChromiumRevision(runnerVenv) });
  if (!executable) {
    return { ok: false, error: `Jarvis's browser is not installed. Run "uv run --project python-app playwright install chromium", then try again.` };
  }
  let waited = false;
  if (headlessHolder(await commandLines(), profileDirectory)) {
    waited = true;
    onWaiting();
    if (!(await handOverProfile({ profileDirectory, commandLines, timeoutMs: handoverTimeoutMs }))) return { ok: false, error: BUSY_ERROR };
  }
  const signInAgain = await adoptKeychain(profileDirectory, platform);
  await new Promise((resolve, reject) => {
    const child = spawn(executable, chromiumSignInArgs(profileDirectory, target, platform), { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
  return { ok: true, waited, signInAgain };
}
