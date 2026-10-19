// Turns a copy of Electron.app into Jarvis.app: name, executable, bundle id and icon. Shared by `pnpm desktop`
// (a development copy in desktop/.dev) and `pnpm desktop:install` (the app installed in /Applications).
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopDir, "..");
export const electronBinary = createRequire(import.meta.url)("electron");
export const electronApp = path.resolve(electronBinary, "..", "..", ".."); // …/Electron.app
export const iconPng = path.join(desktopDir, "assets", "icon.png");

export function run(command, args) {
  execFileSync(command, args, { stdio: ["ignore", "ignore", "inherit"] });
}

/** The real `uv` binary on PATH (symlinks resolved), or null. */
export function findUv(env = process.env) {
  for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, process.platform === "win32" ? "uv.exe" : "uv");
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  return null;
}

function directorySize(target) {
  const stats = statSync(target);
  if (!stats.isDirectory()) return stats.size;
  return readdirSync(target).reduce((total, name) => total + directorySize(path.join(target, name)), 0);
}

/**
 * Copies what the installed app needs to run the Python runner without the repo into `target`
 * (Contents/Resources/runner): python-app's source and lockfile, contracts/defaults.json (read by its config), the
 * labs catalog with its templates, and the `uv` binary from PATH as bin/uv. The layout mirrors the repo's, so the
 * runner's paths work unchanged. Returns the bundle's size in bytes.
 */
export function bundleRunner(target) {
  const uv = findUv();
  if (!uv) throw new Error("uv isn't on PATH. Install it (https://docs.astral.sh/uv/), then run pnpm desktop:install again.");
  rmSync(target, { recursive: true, force: true });
  const source = path.join(repoRoot, "python-app");
  const project = path.join(target, "python-app");
  mkdirSync(project, { recursive: true });
  cpSync(path.join(source, "app"), path.join(project, "app"), {
    recursive: true,
    filter: (file) => path.basename(file) !== "__pycache__" && !file.endsWith(".pyc"),
  });
  for (const file of ["pyproject.toml", "uv.lock", "README.md", ".python-version"]) {
    if (existsSync(path.join(source, file))) copyFileSync(path.join(source, file), path.join(project, file));
  }
  mkdirSync(path.join(target, "contracts"), { recursive: true });
  copyFileSync(path.join(repoRoot, "contracts", "defaults.json"), path.join(target, "contracts", "defaults.json"));

  const labs = path.join(repoRoot, "labs");
  mkdirSync(path.join(target, "labs"), { recursive: true });
  copyFileSync(path.join(labs, "catalog.json"), path.join(target, "labs", "catalog.json"));
  const catalog = JSON.parse(readFileSync(path.join(labs, "catalog.json"), "utf8"));
  for (const directory of new Set(catalog.scenarios.map((scenario) => scenario.templateDirectory))) {
    cpSync(path.join(labs, directory), path.join(target, "labs", directory), {
      recursive: true,
      filter: (file) => !["node_modules", "tests", "docs", ".DS_Store"].includes(path.basename(file)),
    });
  }

  mkdirSync(path.join(target, "bin"), { recursive: true });
  const bundledUv = path.join(target, "bin", path.basename(uv));
  copyFileSync(uv, bundledUv);
  chmodSync(bundledUv, 0o755);
  return directorySize(target);
}

/**
 * Compiles the Control-key watcher for hold-to-talk (desktop/native/control-key.swift) next to its source, when the
 * source is newer. Returns its path, or null without Xcode's command line tools: Jarvis then just lacks that key.
 */
export function buildControlKey() {
  const source = path.join(desktopDir, "native", "control-key.swift");
  const binary = path.join(desktopDir, "native", "control-key");
  if (existsSync(binary) && statSync(binary).mtimeMs >= statSync(source).mtimeMs) return binary;
  try {
    run("xcrun", ["swiftc", "-O", "-o", binary, source]);
    return binary;
  } catch (error) {
    console.warn(`Couldn't build the Control-key helper (${error.message.split("\n")[0]}), so holding Control won't start listening. Run \`xcode-select --install\`, then start Jarvis again.`);
    return null;
  }
}

/**
 * Copies Electron.app to `target` and brands it. The bundle id is Jarvis's own, so macOS keeps one microphone
 * permission for the app however it was built. Returns the path of the renamed executable.
 */
export function brandElectronApp(target, { bundleId = "dev.jarvis.desktop" } = {}) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(path.dirname(target), { recursive: true });
  run("ditto", [electronApp, target]); // a real copy: never touch the shared pnpm store

  const plist = path.join(target, "Contents", "Info.plist");
  for (const key of ["CFBundleName", "CFBundleDisplayName"]) run("plutil", ["-replace", key, "-string", "Jarvis", plist]);
  run("plutil", ["-replace", "CFBundleIdentifier", "-string", bundleId, plist]);
  run("plutil", ["-replace", "NSMicrophoneUsageDescription", "-string", "Jarvis listens for “Hey Jarvis” and your requests. Audio stays on this Mac.", plist]);
  // The process name (Activity Monitor, the app switcher) comes from the executable's file name.
  const executable = path.join(target, "Contents", "MacOS", "Jarvis");
  run("mv", [path.join(target, "Contents", "MacOS", "Electron"), executable]);
  run("plutil", ["-replace", "CFBundleExecutable", "-string", "Jarvis", plist]);

  // Dock / app-switcher / Finder icon: an .icns built from the app icon.
  const iconset = path.join(tmpdir(), `jarvis-${process.pid}-${Date.now()}.iconset`);
  mkdirSync(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    run("sips", ["-z", String(size), String(size), iconPng, "--out", path.join(iconset, `icon_${size}x${size}.png`)]);
    run("sips", ["-z", String(size * 2), String(size * 2), iconPng, "--out", path.join(iconset, `icon_${size}x${size}@2x.png`)]);
  }
  run("iconutil", ["-c", "icns", iconset, "-o", path.join(target, "Contents", "Resources", "electron.icns")]);
  rmSync(iconset, { recursive: true, force: true });
  return executable;
}

const IDENTITY = "Jarvis Local Signing";
// A keychain of its own, so the user's login keychain is never touched and codesign never shows a password prompt.
const signingDir = path.join(homedir(), "Library", "Application Support", "Jarvis", "signing");
const keychain = path.join(signingDir, "jarvis-signing.keychain-db");
const passwordFile = path.join(signingDir, "keychain-password");

/**
 * Creates (once) a self-signed code-signing certificate for Jarvis. macOS remembers Accessibility, Screen Recording
 * and Microphone permissions by an app's "designated requirement": with an ad-hoc signature that is the exact build's
 * hash, so every reinstall looked like a new app and lost its permissions. Signed with this certificate it becomes
 * `identifier "dev.jarvis.desktop" and certificate leaf = …`, which survives rebuilds.
 */
function ensureSigningKeychain() {
  mkdirSync(signingDir, { recursive: true, mode: 0o700 });
  if (!existsSync(passwordFile)) writeFileSync(passwordFile, randomBytes(18).toString("base64url"), { mode: 0o600 });
  const password = readFileSync(passwordFile, "utf8").trim();
  if (!existsSync(keychain)) {
    const work = mkdtempSync(path.join(tmpdir(), "jarvis-signing-"));
    try {
      const key = path.join(work, "key.pem");
      const cert = path.join(work, "cert.pem");
      const bundle = path.join(work, "identity.p12");
      run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", cert, "-days", "3650", "-nodes", "-subj", `/CN=${IDENTITY}`,
        "-addext", "keyUsage=critical,digitalSignature", "-addext", "extendedKeyUsage=critical,codeSigning"]);
      run("openssl", ["pkcs12", "-export", "-inkey", key, "-in", cert, "-out", bundle, "-passout", `pass:${password}`, "-name", IDENTITY]);
      run("security", ["create-keychain", "-p", password, keychain]);
      run("security", ["set-keychain-settings", keychain]); // no auto-lock timeout
      run("security", ["unlock-keychain", "-p", password, keychain]);
      run("security", ["import", bundle, "-k", keychain, "-P", password, "-T", "/usr/bin/codesign"]);
      run("security", ["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychain]);
      chmodSync(keychain, 0o600);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  run("security", ["unlock-keychain", "-p", password, keychain]);
  return keychain;
}

/** Signs the edited bundle (editing it breaks Electron's signature) with Jarvis's stable local identity. */
export function signApp(target) {
  try {
    run("codesign", ["--force", "--deep", "--keychain", ensureSigningKeychain(), "--sign", IDENTITY, target]);
  } catch (error) {
    // Still launchable, but macOS will ask for permissions again after each rebuild.
    console.warn(`Couldn't sign with the stable Jarvis identity (${error.message.split("\n")[0]}); using an ad-hoc signature.`);
    run("codesign", ["--force", "--deep", "--sign", "-", target]);
  }
}
