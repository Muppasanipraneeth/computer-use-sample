// Starts the Python runner when it isn't already running, so Jarvis works on its own (no `pnpm dev:python` in a
// terminal). If the user started one themselves, it is left alone.
//
// Two layouts:
// - dev (`pnpm desktop`): the repo's python-app and its .venv, started the way scripts/launch.mjs does.
// - standalone (the app `pnpm desktop:install` builds): the runner's source, the labs and a `uv` binary are bundled in
//   Jarvis.app/Contents/Resources/runner; the Python environment and run data live in the user's userData folder, so
//   the app needs no repo. prepareRunner creates that environment on first launch and after updates.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Apps opened from Finder or the Dock get a minimal PATH (/usr/bin:/bin…), without Homebrew, uv or omp. Use the
 * PATH of the user's login shell, the same one their terminal has, so omp and the runner's tools are found.
 */
export function loginShellPath(platform = process.platform, env = process.env) {
  if (platform === "win32") return env.PATH ?? "";
  const shell = env.SHELL || "/bin/zsh";
  try {
    const output = execFileSync(shell, ["-ilc", 'printf "__JARVIS_PATH__%s__" "$PATH"'], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
    return /__JARVIS_PATH__(.*)__/.exec(output)?.[1] || env.PATH || "";
  } catch {
    return env.PATH ?? "";
  }
}

/** Parses KEY=value lines of a .env file (quotes optional), like Node's process.loadEnvFile. */
export function parseEnvFile(text) {
  const values = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    values[match[1]] = value;
  }
  return values;
}

/** The runner run from the repo: its python-app/.venv and the repo's .env. */
export function devRunner(repoRoot) {
  return { mode: "dev", repoRoot, venv: path.join(repoRoot, "python-app", ".venv"), envFile: path.join(repoRoot, ".env") };
}

/** The runner bundled in the installed app (`runnerRoot` = Contents/Resources/runner), set up in `userData`. */
export function standaloneRunner({ runnerRoot, userData, platform = process.platform }) {
  return {
    mode: "standalone",
    uv: path.join(runnerRoot, "bin", platform === "win32" ? "uv.exe" : "uv"),
    project: path.join(runnerRoot, "python-app"),
    labs: path.join(runnerRoot, "labs"),
    venv: path.join(userData, "runner-venv"),
    data: path.join(userData, "runner-data"),
    envFile: path.join(userData, ".env"),
    // Inside the venv, so a deleted or recreated environment is set up again.
    stamp: path.join(userData, "runner-venv", ".jarvis-setup"),
  };
}

/**
 * The environment every bundled `uv` command runs with. Bytecode caches go to the venv: written next to the source
 * they would modify Jarvis.app and break its signature (and with it the macOS permissions tied to it).
 */
export function standaloneEnv(runner, base = process.env) {
  const env = { ...base };
  delete env.VIRTUAL_ENV; // a shell's activated venv would make uv warn and ignore UV_PROJECT_ENVIRONMENT's intent
  return {
    ...env,
    UV_PROJECT_ENVIRONMENT: runner.venv,
    JARVIS_DATA_ROOT: runner.data,
    JARVIS_LABS_ROOT: runner.labs,
    JARVIS_ENV_FILE: runner.envFile,
    PYTHONPYCACHEPREFIX: path.join(runner.venv, "pycache"),
  };
}

/** `uv <command> --project <bundled python-app> --frozen --no-dev …`: the locked runtime packages, never the dev tools. */
export function uvArgs(runner, command, rest = []) {
  return [command, "--project", runner.project, "--frozen", "--no-dev", ...rest];
}

/** What a finished setup is valid for: the lockfile and Python version it installed. A changed one sets up again. */
export function setupStamp(runner) {
  const hash = createHash("sha256");
  for (const file of ["uv.lock", ".python-version"]) {
    const target = path.join(runner.project, file);
    if (existsSync(target)) hash.update(`${file}\0`).update(readFileSync(target));
  }
  return hash.digest("hex");
}

const SETUP_TIMEOUT_MS = 15 * 60_000;

/** Runs one setup command, passing each output line to onLine. Resolves the last lines of output; rejects on failure. */
function runSetupCommand(command, args, { env, cwd, onLine, timeoutMs = SETUP_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let tail = [];
    let pending = { stdout: "", stderr: "" };
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    for (const stream of ["stdout", "stderr"]) {
      child[stream].setEncoding("utf8");
      child[stream].on("data", (chunk) => {
        // Progress bars redraw with \r; each redraw is a line worth showing.
        const parts = (pending[stream] + chunk).split(/\r?\n|\r/);
        pending[stream] = parts.pop();
        for (const part of parts) {
          const line = part.trim();
          if (!line) continue;
          tail = [...tail, line].slice(-5);
          onLine(line);
        }
      });
    }
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      for (const rest of Object.values(pending)) if (rest.trim()) tail = [...tail, rest.trim()].slice(-5);
      if (code === 0) resolve(tail);
      else reject(new Error(tail.at(-1) || (signal ? `stopped by ${signal}` : `exited with ${code}`)));
    });
  });
}

const STAGES = [
  { stage: "python", message: "Installing Jarvis's runner (first launch or after an update; needs internet, about a minute)…", args: (runner) => uvArgs(runner, "sync") },
  { stage: "browser", message: "Installing the browser Jarvis uses for web tasks…", args: (runner) => uvArgs(runner, "run", ["python", "-m", "playwright", "install", "chromium"]) },
];

let preparing = null;

/**
 * Makes sure the installed app's Python environment exists and matches the bundled lockfile: `uv sync` into
 * <userData>/runner-venv, then Playwright's Chromium. Skipped when the stamp matches (every normal launch) and in dev.
 * onProgress({ stage: "python" | "browser", status: "running" | "done", message, output?, ms? }): one event when a
 * stage starts, one per output line (`output`), one when it is done (`ms`). Resolves { ok: true } or
 * { ok: false, error } with a readable error; never rejects. Concurrent calls share one setup.
 */
export function prepareRunner(runner, { onProgress = () => {}, env = process.env } = {}) {
  if (runner.mode !== "standalone") return Promise.resolve({ ok: true });
  preparing ??= setUp(runner, onProgress, env).finally(() => {
    preparing = null;
  });
  return preparing;
}

async function setUp(runner, onProgress, base) {
  if (!existsSync(runner.uv)) return { ok: false, error: `Jarvis.app is missing its runner (${runner.uv}). Reinstall Jarvis.` };
  const stamp = setupStamp(runner);
  try {
    if ((await readFile(runner.stamp, "utf8")).trim() === stamp) return { ok: true };
  } catch {
    // No setup yet.
  }
  await mkdir(runner.data, { recursive: true });
  const env = standaloneEnv(runner, base);
  for (const { stage, message, args } of STAGES) {
    const started = Date.now();
    onProgress({ stage, status: "running", message });
    try {
      await runSetupCommand(runner.uv, args(runner), { env, cwd: runner.data, onLine: (output) => onProgress({ stage, status: "running", message, output }) });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const what = stage === "python" ? "install Jarvis's runner" : "install its browser";
      return { ok: false, stage, error: `Couldn't ${what}: ${reason}. Check the internet connection; Jarvis tries again shortly.` };
    }
    onProgress({ stage, status: "done", message, ms: Date.now() - started });
  }
  await writeFile(runner.stamp, stamp);
  return { ok: true };
}

/** The runner's address settings, as scripts/launch.mjs sets them (it isn't bundled with the installed app). */
function standaloneLaunchEnv(env) {
  const host = env.HOST ?? "127.0.0.1";
  const port = env.PORT ?? "4041";
  return { ...env, HOST: host, PORT: port, JARVIS_BACKEND: "python", RUNNER_BASE_URL: env.RUNNER_BASE_URL ?? `http://${host}:${port}` };
}

/** The command that starts the runner: [command, args, cwd, env]. */
async function runnerCommand(runner) {
  const dotenv = existsSync(runner.envFile) ? parseEnvFile(readFileSync(runner.envFile, "utf8")) : {};
  if (runner.mode === "standalone") {
    await mkdir(runner.data, { recursive: true });
    const env = standaloneLaunchEnv(standaloneEnv(runner, { ...process.env, ...dotenv }));
    return { command: runner.uv, args: uvArgs(runner, "run", ["python", "-m", "app"]), cwd: runner.data, env };
  }
  const launcher = path.join(runner.repoRoot, "scripts", "launch.mjs");
  if (!existsSync(launcher)) throw new Error(`The Jarvis repo isn't at ${runner.repoRoot} any more.`);
  const { launchConfiguration } = await import(pathToFileURL(launcher).href);
  const config = launchConfiguration("python", false, { ...process.env, ...dotenv });
  if (!existsSync(config.command)) throw new Error("The Python runner isn't set up. In the repo, run: pnpm python:install");
  return { command: config.command, args: config.args, cwd: runner.repoRoot, env: config.env };
}

/**
 * Starts `python -m app` with the managed-shutdown protocol of scripts/launch.mjs: closing stdin asks it to finish its
 * own cleanup (uv passes stdin through to it). Call prepareRunner first for a standalone runner. Returns { stop } or
 * throws a readable error.
 */
export async function startRunner(runner, { onExit = () => {} } = {}) {
  const { command, args, cwd, env } = await runnerCommand(runner);
  const child = spawn(command, args, { cwd, env: { ...env, JARVIS_MANAGED_LAUNCH: "1" }, stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-2000);
  });
  child.stdin.on("error", () => {});
  let exited = false;
  const exit = (code) => {
    if (exited) return;
    exited = true;
    onExit(code, stderr);
  };
  // A binary that can't start (a damaged app) reports here instead of as an exit.
  child.once("error", (error) => {
    stderr = `${stderr}\n${error.message}`.trim();
    exit(1);
  });
  child.once("exit", (code) => exit(code));
  return {
    stop() {
      if (child.exitCode === null) child.stdin.end();
    },
  };
}
