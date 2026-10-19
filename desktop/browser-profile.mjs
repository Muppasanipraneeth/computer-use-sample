// Jarvis's own browser profile: the user signs in to websites once in a visible Chromium window, and the runner's
// shared headless browser (python-app/app/local_browser_host.py, one for all running tasks) reuses the cookies later.
import { execFile, spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const BUSY_ERROR = "Jarvis is using its browser for a task; try again when it finishes.";

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

/** The Chromium revision the runner's Python Playwright launches, read from its bundled browsers.json. */
export async function runnerChromiumRevision(repoRoot) {
  const venv = path.join(repoRoot, "python-app", ".venv");
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
 * Arguments for the visible window. --use-mock-keychain and --password-store=basic match Playwright's launch flags:
 * Chromium encrypts cookies with a key from that store, so the headless runner can only read cookies saved with the same one.
 */
export function chromiumSignInArgs(profileDirectory, url) {
  return [
    `--user-data-dir=${profileDirectory}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--use-mock-keychain",
    "--password-store=basic",
    url,
  ];
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
 * Opens a visible Chromium on Jarvis's profile at url. Spawning again while a sign-in window is open simply opens the
 * url in that window: Chromium hands it to the running instance that owns the --user-data-dir and exits.
 */
export async function openSignInBrowser({ url, userData, repoRoot, platform = process.platform, env = process.env, home = os.homedir() }) {
  const target = signInUrl(url);
  if (!target) return { ok: false, error: "Only http and https pages can be opened for sign-in." };
  const profileDirectory = browserProfileDirectory(userData);
  if (headlessHolder(await processCommandLines(platform), profileDirectory)) return { ok: false, error: BUSY_ERROR };
  const root = playwrightBrowsersRoot({ platform, env, home });
  const executable = await chromiumExecutable({ root, platform, revision: await runnerChromiumRevision(repoRoot) });
  if (!executable) {
    return { ok: false, error: `Jarvis's browser is not installed. Run "uv run --project python-app playwright install chromium", then try again.` };
  }
  await new Promise((resolve, reject) => {
    const child = spawn(executable, chromiumSignInArgs(profileDirectory, target), { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
  return { ok: true };
}
