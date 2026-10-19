// `pnpm desktop`: starts the app from the repo. On macOS the menu bar, Dock and app switcher read their name and icon
// from the running .app bundle, which in development is Electron's own (so they say "Electron"); app.setName cannot
// change that. This keeps a Jarvis-branded copy of Electron.app in desktop/.dev/ and runs the repo's code with it.
// The copy is rebuilt when Electron, the icon or the branding changes. Other platforms run Electron directly.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { brandElectronApp, buildControlKey, desktopDir, electronApp, electronBinary, iconPng, signApp } from "./bundle.mjs";

function devApp() {
  const target = path.join(desktopDir, ".dev", "Jarvis.app");
  const stamp = path.join(desktopDir, ".dev", "stamp");
  const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);
  const version = readFileSync(path.join(electronApp, "Contents", "Info.plist"), "utf8").match(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)/)?.[1];
  const signature = `${version}:${hash(iconPng)}:${hash(fileURLToPath(new URL("./bundle.mjs", import.meta.url)))}`;
  const executable = path.join(target, "Contents", "MacOS", "Jarvis");
  if (existsSync(executable) && existsSync(stamp) && readFileSync(stamp, "utf8") === signature) return executable;
  brandElectronApp(target);
  signApp(target);
  writeFileSync(stamp, signature);
  return executable;
}

const binary = process.platform === "darwin" ? devApp() : electronBinary;
if (process.platform === "darwin") buildControlKey();
const child = spawn(binary, [desktopDir, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
