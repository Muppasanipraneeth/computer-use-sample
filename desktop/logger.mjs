// Jarvis's own log file, next to the runner's (runner.log), so a problem on the user's machine can be read afterwards.
// Lines are "<ISO time> <LEVEL> <message>". The file rolls over at 2 MB, keeping 4 older copies (desktop.log.1 …).
// Nothing secret goes in: callers log events and error messages, never keys, prompts' contents or screenshots, and
// redact() strips anything that looks like a key from free text as a second line of defence.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const MAX_LOG_BYTES = 2 * 1024 * 1024;
export const KEPT_LOGS = 4;

/** Same place the runner uses (python-app/app/config.py): JARVIS_LOG_DIR, else the platform's usual log folder. */
export function logDirectory(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.JARVIS_LOG_DIR) return env.JARVIS_LOG_DIR;
  if (platform === "darwin") return path.join(home, "Library", "Logs", "Jarvis");
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Jarvis", "logs");
  return path.join(home, ".local", "state", "jarvis", "logs");
}

// sk-…, ak_…, Bearer tokens, and KEY=value pairs whose name says it's a secret.
const SECRETS = [
  /\b(sk|ak|rk|pk|uak)[-_][A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*[=:]\s*["']?[^\s"']+/g,
];

export function redact(text) {
  let clean = String(text);
  clean = clean.replace(SECRETS[0], (match, kind) => `${kind}_[redacted]`);
  clean = clean.replace(SECRETS[1], "Bearer [redacted]");
  clean = clean.replace(SECRETS[2], (match, name) => `${name}=[redacted]`);
  return clean;
}

export function createLogger({ directory = logDirectory(), file = "desktop.log", maxBytes = MAX_LOG_BYTES, kept = KEPT_LOGS } = {}) {
  const target = path.join(directory, file);
  let broken = false;

  function rotate() {
    if (!existsSync(target) || statSync(target).size < maxBytes) return;
    rmSync(`${target}.${kept}`, { force: true });
    for (let index = kept - 1; index >= 1; index -= 1) {
      if (existsSync(`${target}.${index}`)) renameSync(`${target}.${index}`, `${target}.${index + 1}`);
    }
    renameSync(target, `${target}.1`);
  }

  function write(level, message, error) {
    if (broken) return;
    try {
      mkdirSync(directory, { recursive: true });
      rotate();
      const detail = error instanceof Error ? ` | ${error.stack ?? error.message}` : error ? ` | ${String(error)}` : "";
      appendFileSync(target, `${new Date().toISOString()} ${level} ${redact(`${message}${detail}`).replace(/\n/g, "\n    ")}\n`);
    } catch {
      broken = true; // a read-only disk must never take the app down with it
    }
  }

  return {
    path: target,
    info: (message) => write("INFO", message),
    warn: (message, error) => write("WARN", message, error),
    error: (message, error) => write("ERROR", message, error),
  };
}

/** The last `lines` lines of a log file, or "" when it doesn't exist yet. */
export function tailFile(file, lines = 200) {
  try {
    return readFileSync(file, "utf8").split("\n").slice(-lines - 1).join("\n").trim();
  } catch {
    return "";
  }
}
