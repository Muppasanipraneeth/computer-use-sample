import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, nativeImage, nativeTheme, net, protocol, session, shell, systemPreferences, utilityProcess } from "electron";

import {
  accountsFromOmpStdout,
  assertRunnerBase,
  authSnapshot,
  ompLoginCommand,
  preferredScenario,
  projectRun,
  readAuthEnv,
  routeScenario,
  runnerErrorText,
  safeScreenshotPath,
  scenarioSummary,
  startRunBody,
  upsertEnv,
  validateAuthUpdates,
  wireAttachments,
} from "./operator.mjs";
import { openSignInBrowser } from "./browser-profile.mjs";
import {
  chatSelectorsFromOmpStdout,
  parseSpokenLine,
  parseUnderstanding,
  pickUnderstandingModel,
  resultInstructions,
  resultRequest,
  spokenSummary,
  understandingInstructions,
  followUpInstructions,
  parseFollowUp,
} from "./voice/assistant.mjs";
import { parseVoiceCommand } from "./voice/commands.mjs";
import { createDucker } from "./voice/ducking.mjs";
import { createHoldKey, HOLD_MS } from "./voice/hold-key.mjs";
import { ensureVoiceModels } from "./voice/models.mjs";
import { DEFAULT_VOICE, findVoice, VOICES } from "./voice/voices.mjs";
import { readProfile, writeProfile } from "./profile.mjs";
import { createComposioClient, disconnectedApps } from "./connections.mjs";
import { loginShellPath, startRunner } from "./runner-process.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
// Installed with `pnpm desktop:install`, the code lives inside Jarvis.app and jarvis.json says where the repo is
// (runner, .env, Playwright's Chromium); run from the repo, it is simply the parent folder.
const installedConfig = path.join(directory, "jarvis.json");
const repoRoot = existsSync(installedConfig) ? JSON.parse(readFileSync(installedConfig, "utf8")).repoRoot : path.resolve(directory, "..");
const envPath = path.join(repoRoot, ".env");
// Opened from Finder or the Dock, the app gets a bare PATH; omp, uv and Homebrew tools live on the login shell's.
if (app.isPackaged || existsSync(installedConfig)) process.env.PATH = loginShellPath();
const runnerBase = assertRunnerBase(process.env.RUNNER_BASE_URL ?? "http://127.0.0.1:4041");
const RUN_ID = /^[A-Za-z0-9_-]+$/;
// Same set and size cap the runner accepts (python-app/app/runner.py attachment checks).
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const TITLE_BAR_HEIGHT = 48;

// Fix the app name so userData resolves to ~/Library/Application Support/Jarvis.
app.setName("Jarvis");

// The runner Jarvis started itself (null when the user runs one, or none is up yet).
let runner = null;
let runnerStarting = false;
let runnerRetryAt = 0;

async function ensureRunner() {
  if (runner || runnerStarting || Date.now() < runnerRetryAt) return;
  if (!/^http:\/\/(127\.0\.0\.1|localhost):4041$/.test(runnerBase)) return; // a custom runner address is the user's to manage
  runnerStarting = true;
  try {
    try {
      const { status } = await requestJson("GET", "/health", undefined, 1_500);
      if (status === 200) return;
    } catch {
      // Not running: start it below.
    }
    runner = await startRunner(repoRoot, {
      onExit: (code, stderr) => {
        runner = null;
        // Don't restart in a tight loop if it keeps failing (missing venv, port taken by something else…).
        if (code) runnerRetryAt = Date.now() + 30_000;
        if (code && stderr) console.error(`[runner] exited with ${code}: ${stderr.trim().split("\n").at(-1)}`);
      },
    });
  } catch (error) {
    runnerRetryAt = Date.now() + 30_000;
    console.error(`[runner] ${error instanceof Error ? error.message : error}`);
  } finally {
    runnerStarting = false;
  }
}

// Must run before `ready`: a standard, secure scheme lets <img src="shot://runner/..."> load under the page CSP.
protocol.registerSchemesAsPrivileged([{ scheme: "shot", privileges: { standard: true, secure: true } }]);

async function requestJson(method, requestPath, body, timeoutMs = 20_000) {
  const response = await fetch(`${runnerBase}${requestPath}`, {
    method,
    headers: { accept: "application/json", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: "The runner returned a response that was not JSON." };
    }
  }
  return { status: response.status, payload };
}

function runOmp(args, timeoutMs = 25_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.OMP_BIN || "omp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("omp timed out."));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function readEnvFile() {
  try {
    return await readFile(envPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return "";
  }
}

async function loadAuth() {
  const env = readAuthEnv(await readEnvFile(), process.env);
  let accounts = [];
  let ompDetail = null;
  try {
    const completed = await runOmp(["models", "--json", "--no-extensions"]);
    if (completed.code === 0) accounts = accountsFromOmpStdout(completed.stdout);
    else ompDetail = (completed.stderr || completed.stdout || "omp could not list accounts.").trim().split("\n").at(-1);
  } catch (error) {
    ompDetail = error instanceof Error ? error.message : "omp could not list accounts.";
  }
  return authSnapshot(env, accounts, ompDetail);
}

async function serveScreenshot(request) {
  const url = new URL(request.url);
  let pathname;
  try {
    if (url.host !== "runner") throw new Error("unknown host");
    pathname = safeScreenshotPath(url.pathname);
  } catch {
    return new Response(null, { status: 403 });
  }
  try {
    const upstream = await net.fetch(`${runnerBase}${pathname}`);
    if (!upstream.ok) return new Response(null, { status: upstream.status });
    // Screenshot artifacts never change once written, so the renderer may keep them.
    return new Response(upstream.body, {
      headers: { "content-type": upstream.headers.get("content-type") || "image/png", "cache-control": "max-age=31536000, immutable" },
    });
  } catch {
    return new Response(null, { status: 502 });
  }
}

function failure(error) {
  return { ok: false, error: error instanceof Error ? error.message : "The desktop app could not complete that action." };
}

function handle(channel, work) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await work(...args);
    } catch (error) {
      return failure(error);
    }
  });
}

/** Only web pages leave the app: file:, javascript: and custom schemes from model text must never reach the OS. */
function externalUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

const FAVICON_HOST = /^[a-z0-9.-]+\.[a-z]{2,}$/i;
const FAVICON_MAX_BYTES = 100 * 1024;
const ICO_TYPES = new Set(["application/ico", "application/x-ico", "application/vnd.microsoft.icon"]);
// Per process, misses included, so a chip list re-rendered on every poll does not refetch.
const favicons = new Map();

function iconType(contentType, bytes) {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (type.startsWith("image/")) return type;
  if (ICO_TYPES.has(type)) return "image/x-icon";
  // Plenty of servers send favicon.ico as octet-stream; trust it only when the bytes carry the ICO header.
  const ico = bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0;
  return type === "application/octet-stream" && ico ? "image/x-icon" : null;
}

async function fetchFavicon(host) {
  try {
    const response = await net.fetch(`https://${host}/favicon.ico`, { redirect: "follow", signal: AbortSignal.timeout(3000) });
    if (!response.ok) return null;
    if (Number(response.headers.get("content-length")) > FAVICON_MAX_BYTES) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > FAVICON_MAX_BYTES) return null;
    const type = iconType(response.headers.get("content-type") ?? "", bytes);
    return type ? `data:${type};base64,${Buffer.from(bytes).toString("base64")}` : null;
  } catch {
    return null;
  }
}

/** A data: URL for the site's icon (the renderer CSP allows data: images but no network), or null. Never throws. */
function favicon(host) {
  if (typeof host !== "string" || !FAVICON_HOST.test(host)) return Promise.resolve(null);
  const key = host.toLowerCase();
  // The promise is cached so concurrent chips for one host share a single request.
  if (!favicons.has(key)) favicons.set(key, fetchFavicon(key));
  return favicons.get(key);
}

// Hex copies of tokens.css (--bg-canvas, --bg-sidebar, --fg) for surfaces Chromium does not paint.
function themeColors() {
  return nativeTheme.shouldUseDarkColors
    ? { window: "#141816", overlay: "#101311", symbol: "#f4f1e6" }
    : { window: "#fffdf4", overlay: "#f6f2e3", symbol: "#1a1a1a" };
}

const APP_ICON = path.join(directory, "assets", "icon.png");

function createWindow() {
  const colors = themeColors();
  const mac = process.platform === "darwin";
  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "Jarvis",
    show: false,
    backgroundColor: colors.window,
    icon: APP_ICON, // Windows/Linux taskbar; macOS uses the Dock icon set at startup.
    // Native controls stay native: traffic lights on macOS, caption buttons drawn over our title bar on Windows/Linux.
    titleBarStyle: mac ? "hiddenInset" : "hidden",
    ...(mac
      ? { trafficLightPosition: { x: 18, y: 17 } }
      : { titleBarOverlay: { color: colors.overlay, symbolColor: colors.symbol, height: TITLE_BAR_HEIGHT } }),
    webPreferences: {
      preload: path.join(directory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Voice keeps listening while the window is minimized during a run ("Hey Jarvis, stop").
      backgroundThrottling: false,
    },
  });
  window.once("ready-to-show", () => window.show());
  // Links in replies open in the user's browser; the app itself never opens another window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    const external = externalUrl(url);
    if (external) shell.openExternal(external).catch(() => {});
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.loadFile(path.join(directory, "renderer", "index.html"));
  return window;
}

// ---------- connections: Gmail, Slack, X… through Composio (connections.mjs); the key never leaves this process ----------

async function composioClient() {
  const { COMPOSIO_API_KEY } = readAuthEnv(await readEnvFile(), process.env);
  if (!COMPOSIO_API_KEY) return null;
  return createComposioClient({ apiKey: COMPOSIO_API_KEY, fetch: (url, init) => net.fetch(url, init) });
}

function registerConnectionHandlers() {
  // Not wrapped by handle(): the list answers { configured, error?, apps } even when Composio fails, so the UI keeps its rows.
  ipcMain.handle("connections:list", async () => {
    let client;
    try {
      client = await composioClient();
      if (!client) return { configured: false, apps: disconnectedApps() };
      return { configured: true, apps: await client.listApps() };
    } catch (error) {
      return { configured: Boolean(client), error: failure(error).error, apps: disconnectedApps() };
    }
  });
  handle("connections:connect", async (slug) => {
    const client = await composioClient();
    if (!client) return { ok: false, error: "Add your Composio API key first." };
    const { url } = await client.connect(String(slug ?? ""));
    await shell.openExternal(url);
    return { ok: true };
  });
  handle("connections:disconnect", async (slug) => {
    const client = await composioClient();
    if (!client) return { ok: false, error: "Add your Composio API key first." };
    await client.disconnect(String(slug ?? ""));
    return { ok: true };
  });
}

// ---------- voice: wake word → command → understand → speak, in a utility process so models and CPU stay out of the UI ----------

let voice = null; // { worker, speaker }: the listener and Jarvis's own voice, each in its own utility process
const ducker = createDucker();
// Push-to-talk: listen without the wake phrase, for when music is louder than your voice.
const LISTEN_SHORTCUT = "CommandOrControl+Shift+Space";
// Hold Control to talk (macOS): a native watcher reports the key; voice/hold-key.mjs decides what counts as a hold.
const CONTROL_KEY = path.join(directory, "native", "control-key");
const controlKeyAvailable = process.platform === "darwin" && existsSync(CONTROL_KEY);
let controlKey = null; // { child, hold } while voice is on and the setting allows it
// Music stays ducked for the whole exchange: listening, thinking, Jarvis speaking, and the follow-up window after it.
let workerState = "off";
let conversationBusy = false;
const voiceHistory = []; // recent turns, so "yes, do it" and "what about tomorrow" make sense
let nextSpeechId = 1;
let understandingModel; // undefined = not looked up yet, null = none available

function rememberTurn(turn) {
  voiceHistory.push(turn);
  voiceHistory.splice(0, Math.max(0, voiceHistory.length - 8));
}

// Spotify / Apple Music pause for the whole exchange; the volume drops only while Jarvis listens, so its own voice
// plays at the user's volume.
function syncDucking() {
  const listening = ["hearing", "transcribing", "following"].includes(workerState);
  if (voicePrefs.pauseMusic && (conversationBusy || listening)) void ducker.hold();
  else void ducker.release();
  if (voicePrefs.pauseMusic && listening) void ducker.duck();
  else void ducker.restore();
}

// Settings → Voice. The window owns them (localStorage) and sends them on start and on every change.
const voicePrefs = { wakeWord: true, followUp: true, pauseMusic: true, holdControl: true, personality: "witty", voice: DEFAULT_VOICE };

function applyVoicePrefs(prefs) {
  if (typeof prefs?.wakeWord === "boolean") voicePrefs.wakeWord = prefs.wakeWord;
  if (typeof prefs?.followUp === "boolean") voicePrefs.followUp = prefs.followUp;
  if (typeof prefs?.pauseMusic === "boolean") voicePrefs.pauseMusic = prefs.pauseMusic;
  if (typeof prefs?.holdControl === "boolean") voicePrefs.holdControl = prefs.holdControl;
  if (["witty", "friendly", "concise"].includes(prefs?.personality)) voicePrefs.personality = prefs.personality;
  if (findVoice(prefs?.voice)) voicePrefs.voice = prefs.voice;
  voice?.worker.postMessage({ type: "prefs", wakeWord: voicePrefs.wakeWord, followUp: voicePrefs.followUp });
  voice?.speaker.postMessage({ type: "voice", id: voicePrefs.voice });
  syncDucking();
  if (voicePrefs.holdControl) startControlKey();
  else stopControlKey();
}

function startControlKey() {
  if (controlKey || !voice || !voicePrefs.holdControl || !controlKeyAvailable) return;
  const hold = createHoldKey({
    // The audio since Control went down is kept, so words said during the hold delay still count.
    start: () => voice?.worker.postMessage({ type: "listen-now", hold: true, lookbackSeconds: HOLD_MS / 1000 }),
    end: () => voice?.worker.postMessage({ type: "release" }),
    cancel: () => voice?.worker.postMessage({ type: "release", cancel: true }),
  });
  const child = spawn(CONTROL_KEY, [], { stdio: ["pipe", "pipe", "ignore"] });
  controlKey = { child, hold };
  let partial = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    const lines = (partial + chunk).split("\n");
    partial = lines.pop();
    for (const line of lines) {
      if (line === "untrusted") voiceDebug("control key: no Accessibility permission, so holding Control does nothing");
      else hold.handle(line);
    }
  });
  child.on("error", (error) => voiceDebug(`control key: ${error.message}`));
  child.once("exit", () => {
    hold.reset();
    if (controlKey?.child === child) controlKey = null;
  });
}

function stopControlKey() {
  const current = controlKey;
  controlKey = null;
  current?.hold.reset();
  current?.child.kill();
}

function voiceDebug(line) {
  if (process.env.JARVIS_VOICE_DEBUG === "1") console.error(`[voice] ${line}`);
}

function stopVoice() {
  const current = voice;
  voice = null;
  workerState = "off";
  conversationBusy = false;
  voiceHistory.length = 0;
  if (globalShortcut.isRegistered(LISTEN_SHORTCUT)) globalShortcut.unregister(LISTEN_SHORTCUT);
  stopControlKey();
  void ducker.restore();
  void ducker.release();
  current?.worker.kill();
  current?.speaker.kill();
}

async function lookUpUnderstandingModel() {
  if (understandingModel !== undefined) return understandingModel;
  try {
    const completed = await runOmp(["models", "--json", "--no-extensions"]);
    understandingModel = completed.code === 0 ? pickUnderstandingModel(chatSelectorsFromOmpStdout(completed.stdout)) : null;
  } catch {
    understandingModel = null;
  }
  return understandingModel;
}

async function understand({ text, source, running, lastReply }) {
  const started = performance.now();
  const model = await lookUpUnderstandingModel();
  const lookedUp = performance.now();
  let reply = parseUnderstanding("", text);
  if (model) {
    const profile = await readProfile(app.getPath("userData"));
    const instructions = understandingInstructions({ now: new Date().toLocaleString(), source, running, lastReply, history: voiceHistory, personality: voicePrefs.personality, profile });
    try {
      const completed = await runOmp(["-p", "--no-tools", "--no-session", "--no-extensions", "--no-skills", "--no-rules", "--thinking", "off", "--model", model, "--system-prompt", instructions, text], 10_000);
      if (completed.code === 0) reply = parseUnderstanding(completed.stdout, text);
    } catch {
      // Slow or offline: fall back to running the words as spoken.
    }
  }
  if (reply.kind !== "ignore") {
    rememberTurn({ role: "user", text });
    rememberTurn({ role: "jarvis", text: reply.say, task: reply.prompt || undefined });
  }
  voiceDebug(`understood in ${((performance.now() - started) / 1000).toFixed(1)} s (model lookup ${((lookedUp - started) / 1000).toFixed(1)} s, ${model ?? "no model"}): ${reply.kind} "${reply.say}"`);
  return reply;
}

/** Judges something said or typed while a task runs: add to it, change it, queue a new one, stop it, or answer. */
async function judgeFollowUp({ text, running, progress, paused }) {
  const model = await lookUpUnderstandingModel();
  if (!model) return parseFollowUp("", text);
  const profile = await readProfile(app.getPath("userData"));
  const instructions = followUpInstructions({ running, progress, paused, personality: voicePrefs.personality, profile });
  try {
    const completed = await runOmp(["-p", "--no-tools", "--no-session", "--no-extensions", "--no-skills", "--no-rules", "--thinking", "off", "--model", model, "--system-prompt", instructions, text], 10_000);
    return completed.code === 0 ? parseFollowUp(completed.stdout, text) : parseFollowUp("", text);
  } catch {
    // Slow or offline: hand the words to the running task as an addition, the least surprising choice.
    return parseFollowUp("", text);
  }
}

/** Says a finished run's outcome in Jarvis's voice; the plain first sentences of the agent's reply if the model is out. */
async function summarize(run) {
  const model = await lookUpUnderstandingModel();
  if (model) {
    try {
      const instructions = resultInstructions(voicePrefs.personality, await readProfile(app.getPath("userData")));
      const completed = await runOmp(["-p", "--no-tools", "--no-session", "--no-extensions", "--no-skills", "--no-rules", "--thinking", "off", "--model", model, "--system-prompt", instructions, resultRequest(run)], 10_000);
      const line = completed.code === 0 ? parseSpokenLine(completed.stdout) : "";
      if (line) return line;
    } catch {
      // Fall through to the plain summary.
    }
  }
  return spokenSummary(run);
}

async function startVoice(owner) {
  if (voice) return { ok: true };
  if (process.platform === "darwin" && !(await systemPreferences.askForMediaAccess("microphone"))) {
    return { ok: false, error: "Microphone access is off for Jarvis. Turn it on in System Settings → Privacy & Security → Microphone, then restart the app." };
  }
  const send = (channel, payload) => {
    if (!owner.isDestroyed()) owner.send(channel, payload);
  };
  const paths = await ensureVoiceModels(path.join(app.getPath("userData"), "voice-models"), (progress) => send("voice:progress", progress));
  const worker = utilityProcess.fork(path.join(directory, "voice", "worker.mjs"), [], { serviceName: "Jarvis listening" });
  const speaker = utilityProcess.fork(path.join(directory, "voice", "speaker.mjs"), [], { serviceName: "Jarvis voice" });
  voice = { worker, speaker };
  const failed = (code, wasCurrent) => {
    if (wasCurrent) {
      stopVoice();
      send("voice:state", { state: "off", error: code ? "The voice engine stopped unexpectedly." : undefined });
    }
  };
  const listenerReady = new Promise((resolve) => {
    worker.on("message", (message) => {
      if (message.type === "ready") resolve({ ok: true });
      else if (message.type === "error") {
        resolve({ ok: false, error: message.message });
        send("voice:state", { state: "error", error: message.message });
      } else if (message.type === "state") {
        workerState = message.state;
        syncDucking();
        send("voice:state", message);
      } else if (message.type === "command") send("voice:command", { ...parseVoiceCommand(message.text), text: message.text, source: message.source });
    });
    worker.once("exit", (code) => {
      failed(code, voice?.worker === worker);
      resolve({ ok: false, error: "The voice engine stopped while starting." });
    });
  });
  const speakerReady = new Promise((resolve) => {
    speaker.on("message", (message) => {
      if (message.type === "ready") resolve({ ok: true });
      else if (message.type === "error") resolve({ ok: false, error: message.message });
      else if (message.type === "chunk") send("voice:speech", message);
    });
    speaker.once("exit", (code) => {
      failed(code, voice?.speaker === speaker);
      resolve({ ok: false, error: "Jarvis's voice stopped while starting." });
    });
  });
  worker.postMessage({ type: "init", paths });
  worker.postMessage({ type: "prefs", wakeWord: voicePrefs.wakeWord, followUp: voicePrefs.followUp });
  // The voice goes first, so init loads the engine for its accent rather than one it may never use.
  speaker.postMessage({ type: "voice", id: voicePrefs.voice });
  speaker.postMessage({ type: "init", paths });
  const result = [await listenerReady, await speakerReady].find((item) => !item.ok) ?? { ok: true };
  if (!result.ok) {
    stopVoice();
    return result;
  }
  const shortcut = globalShortcut.register(LISTEN_SHORTCUT, () => voice?.worker.postMessage({ type: "listen-now" }));
  startControlKey();
  void lookUpUnderstandingModel(); // warm the cache so the first request answers quickly
  return { ok: true, shortcut, holdKey: controlKeyAvailable };
}

app.whenReady().then(() => {
  protocol.handle("shot", serveScreenshot);
  if (process.platform === "darwin") app.dock?.setIcon(APP_ICON);
  // Voice needs the microphone; nothing in Jarvis uses the camera. Other permissions keep Electron's defaults.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(!(permission === "media" && details.mediaTypes?.includes("video")));
  });

  ipcMain.handle("voice:enable", async (event) => {
    try {
      return await startVoice(event.sender);
    } catch (error) {
      stopVoice();
      return failure(error);
    }
  });
  ipcMain.handle("voice:disable", () => {
    stopVoice();
    return { ok: true };
  });
  ipcMain.on("voice:audio", (_event, samples) => {
    if (voice && samples instanceof Float32Array) voice.worker.postMessage({ type: "audio", samples });
  });
  ipcMain.handle("voice:understand", async (_event, request) => {
    try {
      return { ok: true, reply: await understand(request) };
    } catch (error) {
      return failure(error);
    }
  });
  // Starts saying text, or a short summary of a finished run ({ run }). Sentences stream to the window as
  // "voice:speech" chunks with this id, so the first one plays while the rest are generated.
  ipcMain.handle("voice:speak", async (_event, request) => {
    if (!voice) return { ok: false, error: "Voice is off." };
    const text = typeof request?.text === "string" ? request.text : request?.run ? await summarize(request.run) : "";
    if (!text || !voice) return { ok: false, error: "Nothing to say." };
    if (request?.run) rememberTurn({ role: "jarvis", text });
    const id = nextSpeechId++;
    voiceDebug(`saying: "${text}"`);
    voice.speaker.postMessage({ type: "speak", id, text });
    return { ok: true, id, text };
  });
  ipcMain.on("voice:silence", (_event, id) => {
    voice?.speaker.postMessage({ type: "cancel", id });
  });
  ipcMain.on("voice:speaking", (_event, on, followUp) => {
    voice?.worker.postMessage({ type: "speaking", on: Boolean(on), followUp: Boolean(followUp) });
  });
  ipcMain.on("voice:busy", (_event, busy) => {
    conversationBusy = Boolean(busy);
    syncDucking();
  });
  ipcMain.on("voice:prefs", (_event, prefs) => applyVoicePrefs(prefs));
  // Settings → Appearance: "system" follows macOS/Windows; the renderer's colours follow through prefers-color-scheme.
  ipcMain.on("theme:set", (_event, mode) => {
    if (["system", "light", "dark"].includes(mode)) nativeTheme.themeSource = mode;
  });
  app.on("will-quit", () => {
    ducker.restoreNow();
    stopVoice();
    runner?.stop();
  });

  // Start the runner if nobody else has (the installed app has no terminal running `pnpm dev:python`).
  void ensureRunner();

  handle("auth:get", async () => ({ ok: true, auth: await loadAuth() }));

  // Settings → Voice: the English Kokoro speakers Jarvis can talk with. The choice comes back through voice:prefs.
  ipcMain.handle("voice:list", () => VOICES.map(({ id, name, accent, gender }) => ({ id, name, accent, gender })));

  // Settings → Profile: who the user is, for the voice prompts above and (read from the same file) the runner's tasks.
  ipcMain.handle("profile:get", () => readProfile(app.getPath("userData")));
  handle("profile:save", async (profile) => {
    await writeProfile(app.getPath("userData"), profile);
    return { ok: true };
  });

  handle("auth:save", async (updates) => {
    const clean = validateAuthUpdates(updates);
    await writeFile(envPath, upsertEnv(await readEnvFile(), clean), "utf8");
    return { ok: true };
  });

  handle("auth:login", () => {
    const command = ompLoginCommand();
    const child = spawn(command[0], command.slice(1), { detached: true, stdio: "ignore" });
    child.unref();
    return { ok: true };
  });

  // macOS grants Accessibility (mouse/keyboard) and Screen Recording to the app that starts the runner. When Jarvis
  // starts it, that app is Jarvis, so the window checks these up front instead of letting a task fail on them.
  const PRIVACY_PANES = {
    accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  };
  handle("permissions:get", () => {
    if (process.platform !== "darwin") return { ok: true, accessibility: true, screen: true };
    return {
      ok: true,
      accessibility: systemPreferences.isTrustedAccessibilityClient(false),
      screen: systemPreferences.getMediaAccessStatus("screen") === "granted",
    };
  });
  handle("permissions:open", async (kind) => {
    if (process.platform !== "darwin" || !Object.hasOwn(PRIVACY_PANES, kind)) return { ok: false, error: "Nothing to open." };
    // Asking once adds Jarvis to the list, so the user only has to flip its switch. Accessibility has an explicit
    // request; Screen Recording only lists an app after it tries to capture, so ask for a tiny screen thumbnail.
    if (kind === "accessibility") systemPreferences.isTrustedAccessibilityClient(true);
    if (kind === "screen") await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }).catch(() => []);
    await shell.openExternal(PRIVACY_PANES[kind]);
    return { ok: true };
  });
  handle("app:relaunch", () => {
    app.relaunch();
    app.quit();
    return { ok: true };
  });

  handle("runner:health", async () => {
    try {
      const { status } = await requestJson("GET", "/health", undefined, 3_000);
      return { ok: true, online: status === 200, base: runnerBase, starting: runnerStarting };
    } catch {
      if (!runner && !runnerStarting) void ensureRunner();
      return { ok: true, online: false, base: runnerBase, starting: runnerStarting };
    }
  });

  async function listScenarios() {
    const { status, payload } = await requestJson("GET", "/api/scenarios");
    if (status !== 200 || !Array.isArray(payload)) throw new Error(runnerErrorText(payload));
    return payload.filter((item) => item && typeof item.id === "string").map(scenarioSummary);
  }

  handle("scenarios:list", async () => {
    const scenarios = await listScenarios();
    return { ok: true, scenarios, preferredScenarioId: preferredScenario(scenarios) };
  });

  handle("run:start", async (input) => {
    const prompt = input?.prompt ?? "";
    const scenarioIds = (await listScenarios()).map((item) => item.id);
    const route = routeScenario(prompt, input?.scenarioId ?? "", scenarioIds);
    const body = startRunBody(route.scenarioId, prompt, input?.model ?? "", input?.attachments ?? []);
    const { status, payload } = await requestJson("POST", "/api/runs", body, 60_000);
    if (status !== 202 || !payload || typeof payload !== "object") return { ok: false, error: runnerErrorText(payload) };
    return { ok: true, run: projectRun(payload.detail), rerouted: route.rerouted, scenarioId: route.scenarioId };
  });

  handle("run:get", async (runId) => {
    if (typeof runId !== "string" || !RUN_ID.test(runId)) return { ok: false, error: "That run id is not valid." };
    const { status, payload } = await requestJson("GET", `/api/runs/${runId}`, undefined, 8_000);
    if (status === 404) return { ok: false, missing: true, error: runnerErrorText(payload) };
    if (status !== 200) return { ok: false, error: runnerErrorText(payload) };
    return { ok: true, run: projectRun(payload) };
  });

  // Every run the runner is working on, in start order: several chats can each have one going.
  handle("run:live", async () => {
    const { status, payload } = await requestJson("GET", "/api/runs/running", undefined, 8_000);
    if (status !== 200 || !Array.isArray(payload)) return { ok: false, error: runnerErrorText(payload) };
    return { ok: true, runs: payload.map(projectRun) };
  });

  handle("run:stop", async (runId) => {
    if (typeof runId !== "string" || !RUN_ID.test(runId)) return { ok: false, error: "There is no active run to stop." };
    const { status, payload } = await requestJson("POST", `/api/runs/${runId}/stop`);
    if (status >= 400) return { ok: false, error: runnerErrorText(payload) };
    return { ok: true };
  });

  handle("run:follow-up", async (request) => {
    const text = typeof request?.text === "string" ? request.text.trim() : "";
    if (!text) return { ok: false, error: "Say or type something first." };
    const progress = Array.isArray(request?.progress) ? request.progress.filter((step) => typeof step === "string").slice(-8) : [];
    return { ok: true, decision: await judgeFollowUp({ text, running: String(request?.running ?? ""), progress, paused: request?.paused === true }) };
  });

  // Steering and pausing act at the agent's next turn; a code step already running finishes first.
  handle("run:steer", async (runId, message, mode, attachments) => {
    if (typeof runId !== "string" || !RUN_ID.test(runId)) return { ok: false, error: "There is no running task to update." };
    const files = wireAttachments(attachments);
    const body = { message, mode: mode === "redirect" ? "redirect" : "add", ...(files.length > 0 ? { attachments: files } : {}) };
    const { status, payload } = await requestJson("POST", `/api/runs/${runId}/steer`, body);
    return status >= 400 ? { ok: false, error: runnerErrorText(payload) } : { ok: true };
  });
  for (const action of ["pause", "resume"]) {
    handle(`run:${action}`, async (runId) => {
      if (typeof runId !== "string" || !RUN_ID.test(runId)) return { ok: false, error: "There is no running task." };
      const { status, payload } = await requestJson("POST", `/api/runs/${runId}/${action}`);
      return status >= 400 ? { ok: false, error: runnerErrorText(payload) } : { ok: true, paused: payload?.paused === true };
    });
  }

  // Attachments: the renderer only ever holds paths; the runner reads (and copies) the files itself.
  handle("attach:pick", async (kind) => {
    const folder = kind === "folder";
    const options = folder
      ? { title: "Attach a folder", properties: ["openDirectory"] }
      : { title: "Attach images", properties: ["openFile", "multiSelections"], filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }] };
    const parent = BrowserWindow.getFocusedWindow();
    const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (picked.canceled) return { ok: true, attachments: [] };
    return { ok: true, attachments: picked.filePaths.map((filePath) => ({ kind: folder ? "folder" : "image", path: filePath, name: path.basename(filePath) })) };
  });
  // Dropped files arrive as paths; tell images from folders (and refuse anything else) before showing a chip.
  handle("attach:classify", async (paths) => {
    const attachments = [];
    for (const filePath of Array.isArray(paths) ? paths : []) {
      if (typeof filePath !== "string" || !path.isAbsolute(filePath)) continue;
      const info = await stat(filePath).catch(() => null);
      if (info?.isDirectory()) attachments.push({ kind: "folder", path: filePath, name: path.basename(filePath) });
      else if (info?.isFile() && IMAGE_EXTENSIONS.includes(path.extname(filePath).slice(1).toLowerCase())) attachments.push({ kind: "image", path: filePath, name: path.basename(filePath) });
    }
    return { ok: true, attachments };
  });
  // A pasted screenshot has no file yet: keep it in userData so the runner can copy it like any other image.
  handle("attach:save-image", async (bytes, type) => {
    const ext = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[type];
    if (!ext || !(bytes instanceof Uint8Array) || bytes.byteLength === 0) return { ok: false, error: "Only PNG, JPEG, GIF or WebP images can be pasted." };
    if (bytes.byteLength > MAX_IMAGE_BYTES) return { ok: false, error: "That image is over 20 MB." };
    const directory = path.join(app.getPath("userData"), "attachments");
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, `pasted-${randomUUID().slice(0, 8)}.${ext}`);
    await writeFile(filePath, bytes);
    return { ok: true, attachment: { kind: "image", path: filePath, name: `Pasted image.${ext}` } };
  });
  // Small previews for chips and run bubbles; nativeImage yields an empty image for anything that isn't one.
  handle("attach:thumbnail", async (filePath) => {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return { ok: false };
    const image = nativeImage.createFromPath(filePath);
    if (image.isEmpty()) return { ok: false };
    return { ok: true, url: image.resize({ height: 96 }).toDataURL() };
  });

  handle("shell:open", async (url) => {
    const external = externalUrl(url);
    if (!external) return { ok: false, error: "Only web links can be opened." };
    await shell.openExternal(external);
    return { ok: true };
  });

  ipcMain.handle("favicon:get", (_event, host) => favicon(host));
  registerConnectionHandlers();

  // Settings → Connections → Sign in to websites: a visible Chromium on the profile the runner's background browser reuses.
  handle("browser:signin", (url) => openSignInBrowser({ url, userData: app.getPath("userData"), repoRoot }));

  // Desktop runs screenshot the whole screen, so the window minimizes while the agent works and returns afterwards.
  ipcMain.handle("window:step-aside", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle("window:come-back", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    window.restore();
    window.show();
    if (process.platform === "darwin") app.focus({ steal: true });
    window.focus();
  });

  createWindow();
  nativeTheme.on("updated", () => {
    const colors = themeColors();
    for (const window of BrowserWindow.getAllWindows()) {
      window.setBackgroundColor(colors.window);
      if (process.platform !== "darwin") window.setTitleBarOverlay({ color: colors.overlay, symbolColor: colors.symbol, height: TITLE_BAR_HEIGHT });
    }
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
