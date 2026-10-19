// Starts the Python runner from the Jarvis repo when it isn't already running, so the installed app works on its
// own (no `pnpm dev:python` in a terminal). If the user started one themselves, it is left alone.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

/**
 * Starts `python -m app` the way scripts/launch.mjs does (same command, environment and managed-shutdown protocol:
 * closing stdin asks it to finish its own cleanup). Returns { stop } or throws a readable error.
 */
export async function startRunner(repoRoot, { onExit = () => {} } = {}) {
  const launcher = path.join(repoRoot, "scripts", "launch.mjs");
  if (!existsSync(launcher)) throw new Error(`The Jarvis repo isn't at ${repoRoot} any more. Run pnpm desktop:install again from the repo.`);
  const { launchConfiguration } = await import(pathToFileURL(launcher).href);
  const envFile = path.join(repoRoot, ".env");
  const base = { ...process.env, ...(existsSync(envFile) ? parseEnvFile(readFileSync(envFile, "utf8")) : {}) };
  const config = launchConfiguration("python", false, base);
  if (!existsSync(config.command)) throw new Error("The Python runner isn't set up. In the repo, run: pnpm python:install");
  const child = spawn(config.command, config.args, {
    cwd: repoRoot,
    env: { ...config.env, JARVIS_MANAGED_LAUNCH: "1" },
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-2000);
  });
  child.stdin.on("error", () => {});
  child.once("exit", (code) => onExit(code, stderr));
  return {
    stop() {
      if (child.exitCode === null) child.stdin.end();
    },
  };
}
