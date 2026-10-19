import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, nativeImage, nativeTheme, net, protocol, session, shell, systemPreferences, utilityProcess } from "electron";

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
  quickFollowUp,
  typedNeedsUnderstanding,
} from "./voice/assistant.mjs";
import { parseVoiceCommand } from "./voice/commands.mjs";
import { createDucker } from "./voice/ducking.mjs";
import { createHoldKey, HOLD_MS } from "./voice/hold-key.mjs";
import { ensureVoiceModels, voiceModelPaths } from "./voice/models.mjs";
import { DEFAULT_VOICE, findVoice, VOICES } from "./voice/voices.mjs";
import { readProfile, writeProfile } from "./profile.mjs";
import { addMemory, readMemories, removeMemory } from "./memory.mjs";
import { describeSchedule, dueRoutines, nextRunAt, readRoutines, updateRoutine, validateRoutine, writeRoutines } from "./routines.mjs";
import { createComposioClient, disconnectedApps } from "./connections.mjs";
import { devRunner, loginShellPath, prepareRunner, standaloneRunner, startRunner } from "./runner-process.mjs";
import { createLogger, logDirectory, redact, tailFile } from "./logger.mjs";
import { greetingKey, greetingText, joinChunks, PARTS_OF_DAY, pruneGreetings, readGreeting, writeGreeting } from "./greeting-voice.mjs";
import { createAvatar } from "./avatar-window.mjs";
import { checkQuickAction, installedApps, matchQuickAction, runQuickAction } from "./quick-actions.mjs";

// desktop.log beside the runner's runner.log; "Copy diagnostics" in Settings bundles the tail of both.
const log = createLogger();
process.on("uncaughtException", (error) => log.error("uncaught exception", error));
process.on("unhandledRejection", (reason) => log.error("unhandled rejection", reason));

const directory = path.dirname(fileURLToPath(import.meta.url));
// Fix the app name so userData resolves to ~/Library/Application Support/Jarvis.
app.setName("Jarvis");
// Installed with `pnpm desktop:install`, the code lives inside Jarvis.app (jarvis.json: { mode: "standalone" }) with
// the runner bundled in Contents/Resources/runner, and .env, the runner's venv and its data in userData. Run from the
// repo, everything is the repo's.
const installedConfig = path.join(directory, "jarvis.json");
const standalone = existsSync(installedConfig) && JSON.parse(readFileSync(installedConfig, "utf8")).mode === "standalone";
const runnerSetup = standalone
  ? standaloneRunner({ runnerRoot: path.join(process.resourcesPath, "runner"), userData: app.getPath("userData") })
  : devRunner(path.resolve(directory, ".."));
const envPath = runnerSetup.envFile;
// Opened from Finder or the Dock, the app gets a bare PATH; omp, uv and Homebrew tools live on the login shell's.
if (app.isPackaged || existsSync(installedConfig)) process.env.PATH = loginShellPath();
const runnerBase = assertRunnerBase(process.env.RUNNER_BASE_URL ?? "http://127.0.0.1:4041");
const RUN_ID = /^[A-Za-z0-9_-]+$/;
// Same set and size cap the runner accepts (python-app/app/runner.py attachment checks).
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const TITLE_BAR_HEIGHT = 48;

// The runner Jarvis started itself (null when the user runs one, or none is up yet).
let runner = null;
let runnerStarting = false;
let runnerRetryAt = 0;
// The installed app's first-launch runner setup: the latest prepareRunner progress event while it runs
// ({ stage, status, message, output? }), { error } after a failed setup, null otherwise.
let runnerPreparing = null;

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
    const prepared = await prepareRunner(runnerSetup, {
      onProgress: (progress) => {
        runnerPreparing = progress;
        if (progress.output) return;
        if (progress.status === "done") log.info(`runner setup: ${progress.stage} finished in ${(progress.ms / 1000).toFixed(1)} s`);
        else log.info(`runner setup: ${progress.stage} started`);
      },
    });
    if (!prepared.ok) {
      runnerPreparing = { error: prepared.error };
      runnerRetryAt = Date.now() + 30_000;
      log.error(`runner setup failed${prepared.stage ? ` (${prepared.stage})` : ""}`, prepared.error);
      return;
    }
    runnerPreparing = null;
    runner = await startRunner(runnerSetup, {
      onExit: (code, stderr) => {
        runner = null;
        // Don't restart in a tight loop if it keeps failing (missing venv, port taken by something else…).
        if (code) runnerRetryAt = Date.now() + 30_000;
        if (code) log.error(`runner exited with ${code}`, stderr.trim().split("\n").at(-1));
      },
    });
    log.info(`runner started (${runnerSetup.mode})`);
  } catch (error) {
    runnerRetryAt = Date.now() + 30_000;
    log.error("runner failed to start", error);
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
      log.warn(`${channel} failed`, error);
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

// The app's one real window. The floating face is a second BrowserWindow, so nothing may treat "all windows" as this.
let mainWindow = null;

/** Brings Jarvis to the front (opening the window if it was closed): the floating face's click. */
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  mainWindow.restore();
  mainWindow.show();
  if (process.platform === "darwin") app.focus({ steal: true });
  mainWindow.focus();
}

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
  mainWindow = window;
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
    // The hidden floating face would otherwise keep the app alive where closing the window means quitting.
    if (process.platform !== "darwin") app.quit();
  });
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
// Hold Control to talk: a native watcher reports the key; voice/hold-key.mjs decides what counts as a hold. macOS runs
// the compiled Swift helper; Windows runs a PowerShell script whose C# hook compiles at start (1–2 s before "ready").
const CONTROL_KEY = process.platform === "win32" ? path.join(directory, "native", "control-key.ps1") : path.join(directory, "native", "control-key");
const controlKeyAvailable = (process.platform === "darwin" || process.platform === "win32") && existsSync(CONTROL_KEY);
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
const voicePrefs = { wakeWord: true, followUp: true, pauseMusic: true, holdControl: true, floatingFace: "always", floatingSize: "medium", personality: "witty", voice: DEFAULT_VOICE };
// The floating Jarvis face (avatar-window.mjs), created once the app is ready.
let avatar = null;

function applyVoicePrefs(prefs) {
  if (typeof prefs?.wakeWord === "boolean") voicePrefs.wakeWord = prefs.wakeWord;
  if (typeof prefs?.followUp === "boolean") voicePrefs.followUp = prefs.followUp;
  if (typeof prefs?.pauseMusic === "boolean") voicePrefs.pauseMusic = prefs.pauseMusic;
  if (typeof prefs?.holdControl === "boolean") voicePrefs.holdControl = prefs.holdControl;
  if (["always", "talking", "off", true, false].includes(prefs?.floatingFace)) voicePrefs.floatingFace = prefs.floatingFace;
  if (["small", "medium", "large"].includes(prefs?.floatingSize)) voicePrefs.floatingSize = prefs.floatingSize;
  avatar?.setPrefs({ mode: voicePrefs.floatingFace, size: voicePrefs.floatingSize });
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
  const child =
    process.platform === "win32"
      ? spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", CONTROL_KEY], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true })
      : spawn(CONTROL_KEY, [], { stdio: ["pipe", "pipe", "ignore"] });
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

// Installed apps, for quick actions ("open Slack", music in Spotify); re-read every few minutes in case one was added.
let appsCache = { at: 0, apps: new Map() };
function apps() {
  if (Date.now() - appsCache.at > 5 * 60_000) appsCache = { at: Date.now(), apps: installedApps() };
  return appsCache.apps;
}

/** Runs a quick action and speaks what actually happened; a failed app action must not start a web-search task. */
async function quickReply(action, started) {
  const result = await runQuickAction(action).catch(() => ({ ok: false, say: "I couldn't complete that in the app." }));
  voiceDebug(`quick action ${action.do} ${result.ok ? "done" : "failed"} in ${((performance.now() - started) / 1000).toFixed(1)} s`);
  log.info(`quick action: ${action.do} ${result.ok ? "done" : "failed"} in ${Math.round(performance.now() - started)} ms`);
  return { kind: "answer", say: result.say, prompt: "", understood: true, quick: action };
}

async function understand({ text, source, running, lastReply }) {
  const started = performance.now();
  // Plain commands ("play Blinding Lights", "pause", "open Slack") run at once, with no model call at all.
  const instant = matchQuickAction(text, apps());
  let reply = instant ? await quickReply(instant, started) : null;
  if (reply) {
    if (source !== "typed") {
      rememberTurn({ role: "user", text });
      rememberTurn({ role: "jarvis", text: reply.say });
    }
    return reply;
  }
  const model = await lookUpUnderstandingModel();
  const lookedUp = performance.now();
  reply = parseUnderstanding("", text);
  if (model) {
    const profile = await userContext();
    const instructions = understandingInstructions({ now: new Date().toLocaleString(), source, running, lastReply, history: voiceHistory, personality: voicePrefs.personality, profile });
    try {
      const completed = await runOmp(["-p", "--no-tools", "--no-session", "--no-extensions", "--no-skills", "--no-rules", "--thinking", "off", "--model", model, "--system-prompt", instructions, text], 10_000);
      if (completed.code === 0) reply = parseUnderstanding(completed.stdout, text);
    } catch {
      // Slow or offline: fall back to running the words as spoken.
    }
  }
  // The model recognised a one-step command in messier words ("put on blinding lights by the weekend"): run it now.
  const action = reply.kind === "task" ? checkQuickAction(reply.quick, apps(), process.platform, text) : null;
  if (action) reply = await quickReply(action, started);
  // Remembering and scheduling happen here, so they work from voice and typing alike; the reply's say confirms it.
  if (reply.kind === "remember") await addMemory(app.getPath("userData"), reply.prompt);
  if (reply.kind === "schedule") {
    const dir = app.getPath("userData");
    const routine = validateRoutine({ prompt: reply.prompt, time: reply.time, days: reply.days, enabled: true });
    await writeRoutines(dir, [...(await readRoutines(dir)), routine]);
    reply = { ...reply, routineId: routine.id, schedule: describeSchedule(routine) };
  }
  if (reply.kind !== "ignore" && source !== "typed") {
    rememberTurn({ role: "user", text });
    rememberTurn({ role: "jarvis", text: reply.say, task: reply.prompt || undefined });
  }
  voiceDebug(`understood in ${((performance.now() - started) / 1000).toFixed(1)} s (model lookup ${((lookedUp - started) / 1000).toFixed(1)} s, ${model ?? "no model"}): ${reply.kind} "${reply.say}"`);
  if (!reply.understood) log.warn(`voice understanding fell back to the raw words (${model ? "model reply unusable or slow" : "no understanding model"})`);
  return reply;
}

/** The saved profile plus memories, for every prompt that talks to or about the user. */
async function userContext() {
  const dir = app.getPath("userData");
  const [profile, memories] = await Promise.all([readProfile(dir), readMemories(dir)]);
  return { ...profile, memories: memories.map((memory) => memory.text) };
}

// Routines are checked every 30 s. A due one waits in dueQueue until the window takes it and starts it like any task
// in its own chat; with the window closed (macOS keeps the app running) one is opened for it.
const dueQueue = [];
async function checkRoutines() {
  const dir = app.getPath("userData");
  const routines = await readRoutines(dir);
  const due = dueRoutines(routines, new Date());
  if (due.length === 0) return;
  const firedAt = new Date().toISOString();
  await writeRoutines(dir, routines.map((routine) => (due.some((item) => item.id === routine.id) ? { ...routine, lastRunAt: firedAt } : routine)));
  dueQueue.push(...due.map((routine) => ({ id: routine.id, prompt: routine.prompt, schedule: describeSchedule(routine) })));
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (window) window.webContents.send("routine:due");
  else createWindow(); // the new window drains dueQueue once it has loaded
}

function routineViews(routines) {
  const now = new Date();
  return routines.map((routine) => ({ ...routine, schedule: describeSchedule(routine), nextRunAt: nextRunAt(routine, now)?.toISOString() ?? null }));
}

/** Judges something said or typed while a task runs: add to it, change it, queue a new one, stop it, or answer. */
async function judgeFollowUp({ text, running, progress, paused }) {
  const quick = quickFollowUp(text);
  if (quick) return quick;
  const model = await lookUpUnderstandingModel();
  if (!model) return parseFollowUp("", text);
  const profile = await userContext();
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
      const instructions = resultInstructions(voicePrefs.personality, await userContext(), run.workspace ?? null);
      const completed = await runOmp(["-p", "--no-tools", "--no-session", "--no-extensions", "--no-skills", "--no-rules", "--thinking", "off", "--model", model, "--system-prompt", instructions, resultRequest(run)], 10_000);
      const line = completed.code === 0 ? parseSpokenLine(completed.stdout) : "";
      if (line) return line;
    } catch {
      // Fall through to the plain summary.
    }
  }
  return spokenSummary(run);
}

// ---------- the intro's spoken greeting ----------

// Chunks of a greeting being rendered go to its collector, never to the window's speakers.
const greetingJobs = new Map();
let nextGreetingId = 1;

/** `forward` passes ordinary reply chunks on to the window; a short-lived greeting engine has none. */
function routeChunk(message, forward = () => {}) {
  const job = greetingJobs.get(message.id);
  if (job) job(message);
  else forward(message);
}

function renderOn(speaker, text) {
  return new Promise((resolve, reject) => {
    const id = `greeting-${nextGreetingId++}`;
    const chunks = [];
    const timer = setTimeout(() => {
      greetingJobs.delete(id);
      reject(new Error("rendering the greeting took too long"));
    }, 30_000);
    greetingJobs.set(id, (message) => {
      if (message.error) {
        clearTimeout(timer);
        greetingJobs.delete(id);
        reject(new Error(message.error));
        return;
      }
      chunks.push(message.samples);
      if (!message.last) return;
      clearTimeout(timer);
      greetingJobs.delete(id);
      resolve({ samples: joinChunks(chunks), sampleRate: message.sampleRate });
    });
    speaker.postMessage({ type: "speak", id, text });
  });
}

/** The running voice engine, or a short-lived one just for rendering when Voice is off. */
function greetingSpeaker(paths) {
  if (voice?.speaker) return Promise.resolve({ speaker: voice.speaker, temporary: false });
  return new Promise((resolve, reject) => {
    const speaker = utilityProcess.fork(path.join(directory, "voice", "speaker.mjs"), [], { serviceName: "Jarvis voice (greeting)" });
    const timer = setTimeout(() => {
      speaker.kill();
      reject(new Error("the voice engine didn't start"));
    }, 20_000);
    speaker.on("message", (message) => {
      if (message.type === "ready") {
        clearTimeout(timer);
        resolve({ speaker, temporary: true });
      } else if (message.type === "error") {
        clearTimeout(timer);
        speaker.kill();
        reject(new Error(message.message));
      } else if (message.type === "chunk") routeChunk(message);
    });
    speaker.postMessage({ type: "voice", id: voicePrefs.voice });
    speaker.postMessage({ type: "init", paths });
  });
}

function greetingDirectory() {
  return path.join(app.getPath("userData"), "greetings");
}

// Renders whichever of the four parts of the day are missing for this name and voice. Only with the voice models
// already on disk: the intro must never start a 400 MB download.
let greetingRender = null;
function renderGreetings(name) {
  greetingRender ??= (async () => {
    const paths = voiceModelPaths(path.join(app.getPath("userData"), "voice-models"));
    if (!existsSync(paths.tts.model) || !existsSync(paths.tts.voices)) return;
    const dir = greetingDirectory();
    const jobs = PARTS_OF_DAY.map((part) => {
      const text = greetingText(part, name);
      return { text, key: greetingKey(voicePrefs.voice, text) };
    });
    await pruneGreetings(dir, jobs.map((job) => job.key));
    const missing = [];
    for (const job of jobs) if (!(await readGreeting(dir, job.key))) missing.push(job);
    if (missing.length === 0) return;
    const started = performance.now();
    const { speaker, temporary } = await greetingSpeaker(paths);
    try {
      for (const job of missing) {
        const { samples, sampleRate } = await renderOn(speaker, job.text);
        if (samples.length > 0) await writeGreeting(dir, job.key, samples, sampleRate);
      }
    } finally {
      if (temporary) speaker.kill();
    }
    log.info(`welcome voice: rendered ${missing.length} greeting(s) in ${((performance.now() - started) / 1000).toFixed(1)} s`);
  })()
    .catch((error) => log.warn("welcome voice: couldn't render the greeting", error))
    .finally(() => {
      greetingRender = null;
    });
  return greetingRender;
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
      if (code) log.error(`voice engine exited with code ${code}`);
      send("voice:state", { state: "off", error: code ? "The voice engine stopped unexpectedly." : undefined });
    }
  };
  const listenerReady = new Promise((resolve) => {
    worker.on("message", (message) => {
      if (message.type === "ready") resolve({ ok: true });
      else if (message.type === "error") {
        resolve({ ok: false, error: message.message });
        log.error("voice engine error", message.message);
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
      else if (message.type === "chunk") routeChunk(message, (chunk) => send("voice:speech", chunk));
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
  log.info(`Jarvis ${app.getVersion()} started (Electron ${process.versions.electron}, ${process.platform} ${os.release()})`);
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
  // The floating face follows the conversation (voice state, what Jarvis says, his voice level) and background tasks.
  avatar = createAvatar({
    directory,
    userData: app.getPath("userData"),
    onOpen: showMainWindow,
    // Click the line: one request, as if "Hey Jarvis" was said. Hold it: listen until it's let go, like holding
    // Control. With voice off it opens Jarvis instead (voice is turned on there).
    onTalk: (kind) => {
      if (!voice) {
        if (kind !== "hold-start") showMainWindow();
        return;
      }
      if (kind === "tap") voice.worker.postMessage({ type: "listen-now" });
      else if (kind === "hold-start") voice.worker.postMessage({ type: "listen-now", hold: true });
      else voice.worker.postMessage({ type: "release" });
    },
    onSettings: () => {
      showMainWindow();
      mainWindow?.webContents.send("settings:open", "voice");
    },
    // The right-click menu changed a setting: the window owns settings, so it saves it and sends it back.
    onPrefs: (prefs) => mainWindow?.webContents.send("avatar:prefs", prefs),
    log,
  });
  avatar.setPrefs({ mode: voicePrefs.floatingFace, size: voicePrefs.floatingSize });
  ipcMain.on("avatar:voice", (_event, payload) => avatar.voice(payload));
  ipcMain.on("avatar:task", (_event, task, text, outcome) => avatar.task(typeof task === "string" ? task : null, typeof text === "string" ? text : "", typeof outcome === "string" ? outcome : null));
  ipcMain.on("avatar:level", (_event, level, source) => {
    if (Number.isFinite(level)) avatar.level(Math.max(0, Math.min(1, level)), source === "mic" ? "mic" : "speech");
  });
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

  // The cached spoken greeting for the intro, if rendered yet; either way the set is (re)rendered a little later,
  // out of the way of the intro and the voice engine starting.
  handle("welcome:voice", async (request) => {
    const part = PARTS_OF_DAY.includes(request?.part) ? request.part : PARTS_OF_DAY[0];
    const name = typeof request?.name === "string" ? request.name : "";
    const text = greetingText(part, name);
    setTimeout(() => void renderGreetings(name), 8_000);
    const cached = await readGreeting(greetingDirectory(), greetingKey(voicePrefs.voice, text));
    return cached ? { ok: true, text, samples: cached.samples, sampleRate: cached.sampleRate } : { ok: false, text };
  });
  // The welcome plays once per app launch: on macOS closing the window keeps Jarvis running, and reopening it
  // shouldn't greet again.
  let welcomed = false;
  ipcMain.handle("app:first-show", () => {
    const first = !welcomed;
    welcomed = true;
    return first;
  });

  // Settings → Profile: who the user is, for the voice prompts above and (read from the same file) the runner's tasks.
  ipcMain.handle("profile:get", () => readProfile(app.getPath("userData")));
  handle("profile:save", async (profile) => {
    await writeProfile(app.getPath("userData"), profile);
    return { ok: true };
  });

  // Settings → You → memories; the runner reads the same memory.json for every task.
  handle("memory:list", async () => ({ ok: true, memories: await readMemories(app.getPath("userData")) }));
  handle("memory:add", async (text) => ({ ok: true, memories: await addMemory(app.getPath("userData"), String(text ?? "")) }));
  handle("memory:remove", async (id) => ({ ok: true, memories: await removeMemory(app.getPath("userData"), String(id ?? "")) }));

  // Settings → Routines.
  handle("routines:list", async () => ({ ok: true, routines: routineViews(await readRoutines(app.getPath("userData"))) }));
  handle("routines:save", async (input) => {
    const dir = app.getPath("userData");
    const routines = await readRoutines(dir);
    const existing = routines.find((item) => item.id === input?.id);
    // Edits keep the routine's identity; re-enabling or moving its time doesn't fire it straight away.
    const routine = existing ? updateRoutine(existing, { prompt: input.prompt, time: input.time, days: input.days, enabled: input.enabled }) : validateRoutine({ prompt: input?.prompt, time: input?.time, days: input?.days, enabled: input?.enabled ?? true });
    await writeRoutines(dir, routines.some((item) => item.id === routine.id) ? routines.map((item) => (item.id === routine.id ? routine : item)) : [...routines, routine]);
    return { ok: true, routines: routineViews(await readRoutines(dir)) };
  });
  handle("routines:remove", async (id) => {
    const dir = app.getPath("userData");
    await writeRoutines(dir, (await readRoutines(dir)).filter((item) => item.id !== id));
    return { ok: true, routines: routineViews(await readRoutines(dir)) };
  });
  handle("routines:take-due", () => ({ ok: true, routines: dueQueue.splice(0) }));
  // Typed text: a quick action ("play Blinding Lights", "open Slack") runs at once; text that looks like a routine or
  // a memory goes through the model; anything else is a plain task (null), with no added wait.
  handle("typed:understand", async (text) => {
    const words = String(text ?? "").trim();
    const instant = words ? matchQuickAction(words, apps()) : null;
    if (instant) {
      const reply = await quickReply(instant, performance.now());
      if (reply) return { ok: true, reply };
    }
    if (!words || !typedNeedsUnderstanding(words)) return { ok: true, reply: null };
    return { ok: true, reply: await understand({ text: words, source: "typed", running: null, lastReply: null }) };
  });
  setInterval(() => void checkRoutines(), 30_000);
  setTimeout(() => void checkRoutines(), 5_000); // after createWindow below, so a routine due at launch reuses that window

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

  // Settings → Troubleshooting: everything needed to understand a problem, with keys redacted by the logger.
  handle("diagnostics:copy", async () => {
    const dir = logDirectory();
    let health = "offline";
    try {
      health = (await requestJson("GET", "/health", undefined, 2_000)).status === 200 ? "online" : "error";
    } catch {
      // stays "offline"
    }
    const env = readAuthEnv(await readEnvFile(), process.env);
    const configured = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "COMPOSIO_API_KEY", "CLOUDFLARE_API_TOKEN"].filter((key) => env[key]).join(", ") || "none";
    const permissions =
      process.platform === "darwin"
        ? `accessibility ${systemPreferences.isTrustedAccessibilityClient(false) ? "on" : "off"}, screen ${systemPreferences.getMediaAccessStatus("screen")}, microphone ${systemPreferences.getMediaAccessStatus("microphone")}`
        : "n/a";
    const report = [
      `Jarvis ${app.getVersion()} · Electron ${process.versions.electron} · ${process.platform} ${os.release()} ${process.arch}`,
      `Runner ${runnerBase}: ${health} (started by Jarvis: ${Boolean(runner)})`,
      `Permissions: ${permissions}`,
      `Keys set (names only): ${configured}`,
      `Voice: ${voice ? workerState : "off"} · understanding model: ${understandingModel ?? "none"}`,
      "",
      "--- desktop.log (last 150 lines) ---",
      tailFile(path.join(dir, "desktop.log"), 150) || "(empty)",
      "",
      "--- runner.log (last 150 lines) ---",
      tailFile(path.join(dir, "runner.log"), 150) || "(empty)",
    ].join("\n");
    // The runner's log is redacted when written too; this catches anything that slipped into either file.
    clipboard.writeText(redact(report));
    log.info("diagnostics copied");
    return { ok: true, bytes: report.length };
  });
  handle("logs:open", async () => {
    await mkdir(logDirectory(), { recursive: true });
    const error = await shell.openPath(logDirectory());
    return error ? { ok: false, error } : { ok: true };
  });

  handle("runner:health", async () => {
    try {
      const { status } = await requestJson("GET", "/health", undefined, 3_000);
      return { ok: true, online: status === 200, base: runnerBase, starting: runnerStarting };
    } catch {
      if (!runner && !runnerStarting) void ensureRunner();
      return { ok: true, online: false, base: runnerBase, starting: runnerStarting, setup: runnerPreparing };
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
    // A run in one of the user's workspaces is already an Any task run, so the lab router stays out of it.
    const route = input?.workspace ? { scenarioId: input?.scenarioId ?? "", rerouted: false } : routeScenario(prompt, input?.scenarioId ?? "", scenarioIds);
    const body = startRunBody(route.scenarioId, prompt, input?.model ?? "", input?.attachments ?? [], input?.workspace ?? null);
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

  // Sidebar search: the runner looks through every saved run's request and answer.
  handle("runs:search", async (query) => {
    const text = String(query ?? "").trim();
    if (text.length < 2) return { ok: true, results: [] };
    const { status, payload } = await requestJson("GET", `/api/runs/search?q=${encodeURIComponent(text.slice(0, 200))}&limit=30`, undefined, 8_000);
    if (status !== 200 || !Array.isArray(payload)) return { ok: false, error: runnerErrorText(payload) };
    return { ok: true, results: payload.filter((item) => typeof item?.runId === "string").map(({ runId, prompt, status: runStatus, startedAt, snippet }) => ({ runId, prompt: String(prompt ?? ""), status: String(runStatus ?? ""), startedAt, snippet: String(snippet ?? "") })) };
  });

  // Deleting a chat removes its runs' saved files (screenshots, workspace copies) from the runner too.
  handle("run:delete", async (runId) => {
    if (typeof runId !== "string" || !RUN_ID.test(runId)) return { ok: false, missing: true, error: "That run id is not valid." };
    const { status, payload } = await requestJson("DELETE", `/api/runs/${runId}`, undefined, 15_000);
    if (status === 404) return { ok: false, missing: true, error: runnerErrorText(payload) };
    return status >= 400 ? { ok: false, error: runnerErrorText(payload) } : { ok: true };
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

  // The agent asked something (a question or an approval); the answer reaches it before its next step.
  handle("run:answer", async (runId, questionId, answer) => {
    if (typeof runId !== "string" || !RUN_ID.test(runId)) return { ok: false, error: "There is no running task." };
    const { status, payload } = await requestJson("POST", `/api/runs/${runId}/answer`, { questionId: String(questionId ?? ""), answer: String(answer ?? "") });
    return status >= 400 ? { ok: false, error: runnerErrorText(payload) } : { ok: true };
  });

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
  // A task step using the background browser finishes first; the window hears it is waiting so it can say so.
  ipcMain.handle("browser:signin", async (event, url) => {
    try {
      return await openSignInBrowser({ url, userData: app.getPath("userData"), runnerVenv: runnerSetup.venv, onWaiting: () => event.sender.send("browser:signin-waiting") });
    } catch (error) {
      return failure(error);
    }
  });

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
    // Only the main window: the floating face is transparent and must stay that way.
    for (const window of mainWindow && !mainWindow.isDestroyed() ? [mainWindow] : []) {
      window.setBackgroundColor(colors.window);
      if (process.platform !== "darwin") window.setTitleBarOverlay({ color: colors.overlay, symbolColor: colors.symbol, height: TITLE_BAR_HEIGHT });
    }
  });
  app.on("activate", () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
