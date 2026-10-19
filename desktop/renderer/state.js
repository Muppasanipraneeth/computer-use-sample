/* global icon */
/* exported bridge, $, mod, LISTEN_KEYS, saved, MAX_CHATS, MAX_ATTACHMENTS, state, views, stickToBottom, newChatRecord, persist, currentChat, workspaceById, currentWorkspace, chatOf, workingRunIn, chatTitle, el, clock, humanDuration, elapsed, modelLabel, scenario, isRunning, toast, copyText */
// App state and its persistence, chat/workspace records, and small helpers every other script uses. Loads first.
// Not `desktop`: contextBridge defines that global as non-configurable, so a top-level `const desktop` is a SyntaxError.
const bridge = window.desktop;
const $ = (selector) => document.querySelector(selector);

const STORAGE_KEY = "cua.desktop.v1";
const TERMINAL = ["completed", "failed", "cancelled"];

const mod = bridge.platform === "darwin" ? "⌘" : "Ctrl+";
const LISTEN_KEYS = bridge.platform === "darwin" ? "⌘⇧Space" : "Ctrl+Shift+Space";
const saved = loadSaved();
// Settings → Voice / Appearance. Kept here (localStorage); the voice parts are mirrored to the main process.
const DEFAULT_PREFS = {
  wakeWord: true,
  speakReplies: true,
  speakResults: true,
  confirmTasks: true,
  followUp: true,
  pauseMusic: true,
  holdControl: true,
  floatingFace: true, // the floating Jarvis face while talking or working on the screen
  welcome: true, // launch animation and tone
  greet: true, // spoken hello on launch when Voice is on
  personality: "witty",
  voice: "af_heart",
  theme: "system",
};
const MAX_CHATS = 30;
const MAX_ATTACHMENTS = 10;
const state = {
  online: null,
  base: "",
  setup: null, // first-launch install progress while the runner is offline: { stage, status, message, output?, ms? } or { error }
  auth: null,
  scenarios: [],
  scenarioId: saved.scenarioId ?? "",
  model: saved.model ?? "",
  screenOpen: saved.screenOpen ?? true,
  voiceOn: saved.voiceOn ?? false,
  prefs: { ...DEFAULT_PREFS, ...(saved.prefs ?? {}) },
  // Newest first. Each chat keeps its own runs and "up next" queue; a run keeps working when you open another chat.
  chats: savedChats(),
  chatId: saved.chatId ?? "",
  // Workspaces the user made: { id, name, instructions, folder: { path, name } | null }. Chats point at one by id;
  // workspaceId is the one open in the sidebar (null: the built-in workspaces, Any task and the labs).
  workspaces: savedWorkspaces(),
  workspaceId: null,
  runs: new Map(),
  live: new Set(), // runs still working, in any chat; all of them are polled
  stopping: new Set(),
  focusRunId: null,
  sending: false,
  judging: false, // a follow-up is being judged: add to the task, change it, queue it, stop it, or answer
  answering: new Set(), // question ids whose answer is on its way to the runner
  seenQuestions: new Set(), // question ids already announced (notification, voice)
  pausing: false,
  attachments: [], // { kind: "image" | "folder", path, name } waiting in the composer
  steppedAsideFor: null, // the run that took the screen; the window comes back when it ends
  activityOpen: new Map(),
  voice: "off", // off | preparing | listening | hearing | transcribing | following (the voice engine's state)
  voicePhase: null, // thinking | speaking, shown over the engine's state while Jarvis works out or says its reply
  voicePending: null, // { prompt } while Jarvis says what it is about to do; the run starts when it finishes
  voiceStoppedRunId: null, // a run stopped by voice: "Stopping." already said it, so no "Stopped." afterwards
  voiceShortcut: false, // push-to-talk shortcut registered (another app may already own it)
  voiceHoldKey: false, // the Control-key watcher exists (macOS, built at start)
};
if (!state.chats.some((chat) => chat.id === state.chatId)) state.chatId = state.chats[0].id;
// The open chat decides which workspace is open, so the two can never disagree after a restart.
state.workspaceId = state.chats.find((chat) => chat.id === state.chatId)?.workspaceId ?? null;
// The open chat's runs and its working run; everything that only concerns what's on screen reads these.
Object.defineProperties(state, {
  thread: {
    get: () => currentChat().thread,
    set: (ids) => {
      currentChat().thread = ids;
    },
  },
  activeRunId: { get: () => workingRunIn(currentChat()) },
});
const views = new Map();
let stickToBottom = true;

/* ---------- persistence ---------- */

function loadSaved() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function newChatRecord(workspaceId = null) {
  // routineId: the chat a routine reuses each time it runs, so its results stack up in one place.
  return { id: crypto.randomUUID(), title: "", thread: [], queue: [], unread: false, routineId: null, workspaceId };
}

function savedAttachments(list) {
  return Array.isArray(list)
    ? list.filter((item) => (item?.kind === "image" || item?.kind === "folder") && typeof item.path === "string").map(({ kind, path, name }) => ({ kind, path, name: String(name ?? "") }))
    : [];
}

function savedWorkspaces() {
  return (Array.isArray(saved.workspaces) ? saved.workspaces : [])
    .filter((item) => item && typeof item.id === "string" && typeof item.name === "string" && item.name.trim())
    .map((item) => ({
      id: item.id,
      name: item.name.trim().slice(0, 80),
      instructions: String(item.instructions ?? "").slice(0, 4000),
      folder: item.folder && typeof item.folder.path === "string" ? { path: item.folder.path, name: String(item.folder.name ?? "") } : null,
    }));
}

/** Chats from storage; the single thread older versions kept becomes the first chat. */
function savedChats() {
  const ids = (list) => (Array.isArray(list) ? list.filter((id) => typeof id === "string" && id !== "pending") : []);
  const workspaceIds = new Set(savedWorkspaces().map((item) => item.id));
  const chats = (Array.isArray(saved.chats) ? saved.chats : [])
    .filter((chat) => chat && typeof chat.id === "string")
    .map((chat) => ({
      id: chat.id,
      title: String(chat.title ?? ""),
      thread: ids(chat.thread),
      queue: (Array.isArray(chat.queue) ? chat.queue : []).filter((item) => typeof item?.prompt === "string").map((item) => ({ prompt: item.prompt, attachments: savedAttachments(item.attachments) })),
      unread: chat.unread === true,
      routineId: typeof chat.routineId === "string" ? chat.routineId : null,
      workspaceId: workspaceIds.has(chat.workspaceId) ? chat.workspaceId : null,
    }));
  if (chats.length === 0) chats.push({ ...newChatRecord(), thread: ids(saved.thread) });
  return chats;
}

function persist() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      scenarioId: state.scenarioId,
      model: state.model,
      screenOpen: state.screenOpen,
      voiceOn: state.voiceOn,
      prefs: state.prefs,
      chatId: state.chatId,
      chats: state.chats.map((chat) => ({ ...chat, thread: chat.thread.filter((id) => id !== "pending").slice(-50) })),
      workspaces: state.workspaces,
      setupSeen: state.setupSeen === true || saved.setupSeen === true,
      autoOffered: state.autoOffered === true || saved.autoOffered === true,
    }),
  );
}

function currentChat() {
  return state.chats.find((chat) => chat.id === state.chatId) ?? state.chats[0];
}

function workspaceById(id) {
  return state.workspaces.find((item) => item.id === id) ?? null;
}

function currentWorkspace() {
  return workspaceById(state.workspaceId);
}

function chatOf(runId) {
  return state.chats.find((chat) => chat.thread.includes(runId)) ?? null;
}

function workingRunIn(chat) {
  return chat.thread.findLast((id) => state.live.has(id)) ?? null;
}

function chatTitle(chat) {
  return chat.title || state.runs.get(chat.thread[0])?.prompt || "New chat";
}

/* ---------- small helpers ---------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

function humanDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  return total % 60 ? `${minutes}m ${total % 60}s` : `${minutes}m`;
}

function elapsed(run) {
  if (run.durationMs !== null && run.durationMs !== undefined) return run.durationMs;
  if (!run.startedAt) return 0;
  const end = run.completedAt ? Date.parse(run.completedAt) : Date.now();
  return end - Date.parse(run.startedAt);
}

function modelLabel(model) {
  if (model === "auto") return "Auto";
  const choice = state.auth?.choices.find((item) => item.model === model);
  if (choice) return choice.label.split(" · ")[0];
  return model.replace(/^omp:/, "").replace(/^[^/]*\//, "") || "Model";
}

function scenario() {
  return state.scenarios.find((item) => item.id === state.scenarioId) ?? null;
}

function isRunning(run) {
  return run && !TERMINAL.includes(run.status);
}

function toast(text, tone = "info") {
  const node = el("div", `toast ${tone}`);
  node.append(icon(tone === "error" ? "x" : tone === "ok" ? "check" : "dot"), el("span", "", text));
  $("#toasts").append(node);
  setTimeout(() => node.classList.add("leaving"), 4200);
  setTimeout(() => node.remove(), 4600);
}

async function copyText(text, label = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast(label, "ok");
  } catch {
    toast("The clipboard is not available.", "error");
  }
}
