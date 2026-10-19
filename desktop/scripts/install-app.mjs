// `pnpm desktop:install`: builds a standalone Jarvis.app and installs it in /Applications (or ~/Applications when
// /Applications isn't writable), so Jarvis opens from Spotlight, Launchpad and the Dock like any Mac app.
//
// It follows Electron's manual distribution layout: a renamed copy of Electron.app with the app's code in
// Contents/Resources/app (https://www.electronjs.org/docs/latest/tutorial/application-distribution). The installed
// app still uses this repo for the Python runner, models in your omp accounts and the .env file; jarvis.json records
// where the repo is, and the app starts the runner itself when it isn't running. Run this again after pulling changes.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { brandElectronApp, buildControlKey, desktopDir, run, signApp } from "./bundle.mjs";

if (process.platform !== "darwin") {
  console.error("pnpm desktop:install builds a macOS app. On Windows and Linux, start Jarvis with pnpm desktop.");
  process.exit(1);
}

const repoRoot = path.resolve(desktopDir, "..");
const build = path.join(desktopDir, ".dev", "install", "Jarvis.app");
console.log("Building Jarvis.app…");
brandElectronApp(build);

const resources = path.join(build, "Contents", "Resources");
const app = path.join(resources, "app");
rmSync(path.join(resources, "default_app.asar"), { force: true });
mkdirSync(app, { recursive: true });
for (const entry of ["main.mjs", "preload.cjs", "operator.mjs", "renderer", "voice", "assets"]) {
  cpSync(path.join(desktopDir, entry), path.join(app, entry), { recursive: true });
}
// The other top-level modules main.mjs imports (connections, profile, browser sign-in, runner start-up…).
for (const file of readdirSync(desktopDir).filter((name) => name.endsWith(".mjs") && name !== "main.mjs" && name !== "operator.mjs")) {
  cpSync(path.join(desktopDir, file), path.join(app, file));
}
const manifest = JSON.parse(readFileSync(path.join(desktopDir, "package.json"), "utf8"));
writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "jarvis", productName: "Jarvis", version: manifest.version, type: "module", main: "main.mjs" }, null, 2));
writeFileSync(path.join(app, "jarvis.json"), JSON.stringify({ repoRoot }, null, 2));

// Runtime dependencies, copied out of pnpm's symlinked store: the speech engine and its native macOS build.
const require = createRequire(path.join(desktopDir, "package.json"));
const sherpa = path.dirname(require.resolve("sherpa-onnx-node/package.json"));
const native = path.dirname(createRequire(path.join(sherpa, "package.json")).resolve(`sherpa-onnx-darwin-${process.arch}/package.json`));
for (const [name, from] of [["sherpa-onnx-node", sherpa], [`sherpa-onnx-darwin-${process.arch}`, native]]) {
  cpSync(realpathSync(from), path.join(app, "node_modules", name), { recursive: true, dereference: true });
}
// Hold Control to talk. The helper keeps its compiler's ad-hoc signature and is sealed into Jarvis's own; macOS checks
// its key access against Jarvis, the app that starts it.
const controlKey = buildControlKey();
if (controlKey) cpSync(controlKey, path.join(app, "native", "control-key"));
signApp(build);

function writable(directory) {
  try {
    const probe = path.join(directory, `.jarvis-${process.pid}`);
    writeFileSync(probe, "");
    rmSync(probe);
    return true;
  } catch {
    return false;
  }
}
const applications = writable("/Applications") ? "/Applications" : path.join(os.homedir(), "Applications");
mkdirSync(applications, { recursive: true });
const installed = path.join(applications, "Jarvis.app");

/** The code requirement macOS stores with each permission ("designated => …"), or null when unsigned/missing. */
function designatedRequirement(app) {
  try {
    const output = execFileSync("codesign", ["-dr", "-", app], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return /designated => (.*)/.exec(output)?.[1]?.trim() ?? null;
  } catch (error) {
    return /designated => (.*)/.exec(String(error.stdout ?? ""))?.[1]?.trim() ?? null;
  }
}
const previous = existsSync(installed) ? designatedRequirement(installed) : null;
const next = designatedRequirement(build);

run("osascript", ["-e", 'tell application "System Events" to if exists process "Jarvis" then tell application "Jarvis" to quit']);
rmSync(installed, { recursive: true, force: true });
run("ditto", [build, installed]);
rmSync(path.dirname(build), { recursive: true, force: true });

// macOS keeps a permission tied to the code requirement it was granted for. When that changes (the first install
// with the stable signing identity, or a recreated certificate), the old entries can't match the new app, yet
// System Settings still shows Jarvis switched on, and turning it on again changes nothing. Clearing them makes
// macOS ask afresh. With an unchanged requirement (every normal update) permissions are kept.
if (previous && next && previous !== next) {
  for (const service of ["Accessibility", "ScreenCapture", "Microphone"]) {
    try {
      run("tccutil", ["reset", service, "dev.jarvis.desktop"]);
    } catch {
      // Best effort: the in-app banner still explains what to turn on.
    }
  }
  console.log("Jarvis's signature changed, so macOS will ask again for microphone, Accessibility and Screen Recording.");
}
console.log(`Installed ${installed}. Open it from Spotlight or Launchpad; drag it to the Dock to keep it there.`);
