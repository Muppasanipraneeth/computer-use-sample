/* global icon, hydrateIcons, renderMarkdown, startMicrophone, stopMicrophone, chime, createSpeechPlayer */
// Not `desktop`: contextBridge defines that global as non-configurable, so a top-level `const desktop` is a SyntaxError.
const bridge = window.desktop;
const $ = (selector) => document.querySelector(selector);

const STORAGE_KEY = "cua.desktop.v1";
const TERMINAL = ["completed", "failed", "cancelled"];
const LAB_ICONS = { desktop: "cube", kanban: "board", paint: "brush", booking: "bag" };
const SCENARIO_ICONS = { "any-task": "chat" };
// Tile colour per workspace, Notion-style: each place gets its own soft colour.
const SCENARIO_TONES = { "any-task": "lilac", "desktop-cad-engine": "mint" };
const LAB_TONES = { kanban: "sky", paint: "peach", booking: "mint" };
const STEP_ICONS = { action: "click", screen: "eye", thought: "thought", warning: "alert", error: "x", note: "dot", turn: "dot", steer: "chat", question: "question" };
// Action steps get an icon for what they did, read from their label (operator.mjs describeCode).
const ACTION_ICONS = [
  [/^Read /, "book"],
  [/^Open /, "globe"],
  [/background browser/, "globe"],
  [/^(Type|Press|Hold|Release) /, "keyboard"],
  [/^Look at the screen/, "eye"],
  [/^Find app tools|^Check connected apps/, "link"],
  [/^[A-Z][\w ]+: /, "link"], // a connected app's action, e.g. "Gmail: send email"
];
// Keyed by scenario id: Unreal and "Any task" share labId "desktop" but want very different prompts.
const EXTRA_SUGGESTIONS = {
  "any-task": [
    "What are the top tech stories today? Give me three, with sources.",
    "What's the weather in Hyderabad right now?",
    "Play some focus music on Spotify.",
    "Create a folder named Runway on my Desktop.",
  ],
  "desktop-cad-engine": [
    "Add a Point Light above the front entrance of the property and leave it selected. Do not save.",
    "Frame the house in the viewport, then place a Camera Actor looking at the front facade. Do not save.",
    "Select the main building and tell me its location from the Details panel. Change nothing.",
  ],
};
const KEY_FORMS = [
  { id: "openai", title: "OpenAI API Key", flag: "openai", fields: [{ label: "API key", key: "OPENAI_API_KEY", type: "password" }] },
  { id: "claude", title: "Claude API Key", flag: "anthropic", fields: [{ label: "API key", key: "ANTHROPIC_API_KEY", type: "password" }] },
  {
    id: "other",
    title: "OpenAI-Compatible API",
    flag: "compatible",
    fields: [
      { label: "Base URL", key: "JARVIS_COMPATIBLE_BASE_URL", type: "url" },
      { label: "API key", key: "JARVIS_COMPATIBLE_API_KEY", type: "password" },
    ],
  },
  {
    id: "cloudflare",
    title: "Cloudflare Browser Run",
    flag: "cloudflare",
    hint: "Lets Jarvis browse the web in a Cloudflare cloud browser. Create an API token with the Browser Rendering – Edit permission. The token stays with the runner; model code never sees it.",
    fields: [
      { label: "Account ID", key: "CLOUDFLARE_ACCOUNT_ID", type: "text" },
      { label: "API token", key: "CLOUDFLARE_API_TOKEN", type: "password" },
    ],
  },
];

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
  personality: "witty",
  voice: "af_heart",
  theme: "system",
};
const MAX_CHATS = 30;
const MAX_ATTACHMENTS = 10;
const state = {
  online: null,
  base: "",
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
let gallery = { images: [], index: 0 };

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

/* ---------- sidebar ---------- */

function scenarioButton(item) {
  const button = el("button", "scenario");
  button.type = "button";
  button.title = item.description ?? "";
  button.setAttribute("role", "option");
  button.setAttribute("aria-selected", String(item.id === state.scenarioId && !state.workspaceId));
  const mark = icon(SCENARIO_ICONS[item.id] ?? LAB_ICONS[item.labId] ?? "monitor", "scenario-icon");
  mark.dataset.tone = SCENARIO_TONES[item.id] ?? LAB_TONES[item.labId] ?? "sky";
  button.append(mark, el("span", "scenario-title", item.title));
  button.addEventListener("click", () => {
    state.scenarioId = item.id;
    if (state.workspaceId) enterWorkspace(null);
    persist();
    renderScenarios();
    renderHeader();
    renderEmpty();
  });
  return button;
}

const WORKSPACE_TONES = ["peach", "mint", "sky", "lilac"];

// The user's own workspaces, each with an edit button that shows on hover.
function renderWorkspaces() {
  const list = $("#workspace-list");
  list.replaceChildren(
    ...state.workspaces.map((workspace, index) => {
      const button = el("button", "scenario");
      button.type = "button";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(workspace.id === state.workspaceId));
      button.title = workspace.instructions || workspace.name;
      const mark = icon("folder", "scenario-icon");
      mark.dataset.tone = WORKSPACE_TONES[index % WORKSPACE_TONES.length];
      button.append(mark, el("span", "scenario-title", workspace.name));
      button.addEventListener("click", () => enterWorkspace(workspace.id));
      const edit = el("button", "row-action");
      edit.type = "button";
      edit.setAttribute("aria-label", `Edit ${workspace.name}`);
      edit.title = "Edit workspace";
      edit.append(icon("edit"));
      edit.addEventListener("click", () => openWorkspaceDialog(workspace));
      const wrap = el("div", "row-wrap");
      wrap.append(button, edit);
      return wrap;
    }),
  );
}

/** Opens a workspace (null: back to the built-in ones): its most recent chat, or a fresh one. */
function enterWorkspace(workspaceId) {
  if (workspaceId === state.workspaceId) return;
  if (workspaceId) state.scenarioId = "any-task"; // your workspaces run on Any task, with their own instructions
  const chat = state.chats.find((item) => item.workspaceId === workspaceId && !item.routineId);
  if (chat) return switchChat(chat.id);
  const fresh = newChatRecord(workspaceId);
  state.chats.unshift(fresh);
  switchChat(fresh.id);
}

// Real workspaces (the desktop: Any task, Unreal) up front; the browser practice labs are for trying the agent out,
// so they fold away.
function renderScenarios() {
  const list = $("#scenario-list");
  const labs = $("#lab-list");
  list.replaceChildren();
  labs.replaceChildren();
  if (state.scenarios.length === 0) {
    list.append(el("p", "muted small side-note", state.online === false ? "Workspaces load when the runner is online." : "Loading…"));
    $("#labs").hidden = true;
    return;
  }
  // "Any task" leads: it's where almost everything starts.
  const ordered = [...state.scenarios].sort((a, b) => Number(b.id === "any-task") - Number(a.id === "any-task"));
  for (const item of ordered) (item.labId === "desktop" ? list : labs).append(scenarioButton(item));
  $("#labs").hidden = labs.childElementCount === 0;
  if (scenario() && scenario().labId !== "desktop") $("#labs").open = true;
}

function runIcon(run) {
  if (isRunning(run)) return el("span", "spinner");
  return icon(run.status === "completed" ? "check" : run.status === "failed" ? "x" : "alert");
}

// This chat's requests, newest first: a quick way back to an earlier answer.
function renderRecent() {
  const list = $("#recent-list");
  const runs = state.thread.map((id) => state.runs.get(id)).filter(Boolean).reverse();
  const signature = runs.map((run) => `${run.runId}:${run.status}`).join("|") + `|${state.focusRunId}`;
  if (list.dataset.sig === signature) return;
  list.dataset.sig = signature;
  list.replaceChildren();
  if (runs.length === 0) {
    list.append(el("li", "muted small side-note", "Your requests show up here."));
    return;
  }
  for (const run of runs) {
    const button = el("button", `recent ${run.status}`);
    button.type = "button";
    button.setAttribute("aria-current", String(run.runId === state.focusRunId));
    const status = el("span", `recent-status ${run.status}`);
    status.append(runIcon(run));
    button.append(status, el("span", "recent-text", run.prompt));
    button.title = run.prompt;
    button.addEventListener("click", () => {
      state.focusRunId = run.runId;
      stickToBottom = false;
      views.get(run.runId)?.root.scrollIntoView({ behavior: "smooth", block: "start" });
      renderRecent();
      renderScreen();
    });
    const item = el("li");
    item.append(button);
    list.append(item);
  }
}

// The open workspace's chats, newest first. A spinner means a run there is still working; a dot means one finished
// while you were away. Each row has a delete button: the first click arms it, the second deletes.
function renderChats() {
  const list = $("#chat-list");
  const workspace = currentWorkspace();
  $("#chats-heading").textContent = workspace ? `Chats in ${workspace.name}` : "Chats";
  const rows = state.chats
    .filter((chat) => chat.workspaceId === state.workspaceId)
    .map((chat) => ({ chat, working: Boolean(workingRunIn(chat)), title: chatTitle(chat) }));
  const signature = rows.map(({ chat, working, title }) => `${chat.id}:${working}:${chat.unread}:${title}`).join("|") + `|${state.chatId}|${state.workspaceId}`;
  if (list.dataset.sig === signature) return;
  list.dataset.sig = signature;
  list.replaceChildren();
  for (const { chat, working, title } of rows) {
    const button = el("button", "recent chat-row");
    button.type = "button";
    button.setAttribute("aria-current", String(chat.id === state.chatId));
    const status = el("span", "recent-status");
    status.append(working ? el("span", "spinner") : icon("chat"));
    button.append(status, el("span", "recent-text", title));
    if (chat.unread) button.append(el("span", "unread-dot"));
    button.title = working ? `${title} (still working)` : title;
    button.addEventListener("click", () => switchChat(chat.id));
    const remove = el("button", "row-action");
    remove.type = "button";
    remove.setAttribute("aria-label", `Delete ${title}`);
    remove.title = "Delete chat";
    remove.append(icon("trash"));
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!remove.classList.contains("confirm")) {
        remove.classList.add("confirm");
        remove.replaceChildren("Delete");
        // Disarm if they don't follow through, so a later stray click can't delete it.
        setTimeout(() => {
          if (!remove.isConnected) return;
          remove.classList.remove("confirm");
          remove.replaceChildren(icon("trash"));
        }, 3000);
        return;
      }
      void deleteChat(chat.id);
    });
    const item = el("li", "row-wrap");
    item.append(button, remove);
    list.append(item);
  }
}

/** Deletes a chat and its runs' files on the runner. A chat whose task is still working has to be stopped first. */
async function deleteChat(chatId) {
  const chat = state.chats.find((item) => item.id === chatId);
  if (!chat) return;
  if (workingRunIn(chat)) {
    toast("Stop its task first, then delete the chat.", "info");
    renderChats();
    return;
  }
  const results = await Promise.all(chat.thread.filter((id) => id !== "pending").map((id) => bridge.deleteRun(id)));
  // A run already gone (pruned by the runner, or never saved) is fine; anything else is reported but the chat still goes.
  const failed = results.filter((result) => !result.ok && !result.missing);
  for (const id of chat.thread) {
    removeRunView(id);
    state.runs.delete(id);
  }
  if (chat.id === state.chatId) {
    // Move to another chat in the same workspace (or a fresh one) while this one still exists, then drop it.
    const next = state.chats.find((item) => item !== chat && item.workspaceId === chat.workspaceId && !item.routineId) ?? newChatRecord(chat.workspaceId);
    if (!state.chats.includes(next)) state.chats.unshift(next);
    switchChat(next.id);
  }
  state.chats = state.chats.filter((item) => item !== chat);
  if (state.chats.length === 0) state.chats.push(newChatRecord(state.workspaceId));
  persist();
  renderChats();
  toast(failed.length ? `Chat deleted, but ${failed.length} run file${failed.length === 1 ? "" : "s"} couldn't be removed: ${failed[0].error}` : "Chat deleted.", failed.length ? "error" : "ok");
}

function renderAccounts() {
  const auth = state.auth;
  const pill = $("#account-pill");
  const models = auth?.accounts.length ?? 0;
  const keys = auth ? ["openai", "anthropic", "compatible"].filter((flag) => auth[flag]).length : 0;
  pill.dataset.state = !auth ? "pending" : models || keys ? "ok" : "missing";
  $("#account-text").textContent = !auth
    ? "Checking accounts…"
    : models
      ? `${models} model${models === 1 ? "" : "s"}${keys ? ` · ${keys} key${keys === 1 ? "" : "s"}` : ""}`
      : keys
        ? `${keys} API key${keys === 1 ? "" : "s"}`
        : "Sign in to a model";
}

// macOS permissions for desktop tasks. Screen Recording only takes effect after the app reopens, so the banner
// offers a reopen step once the user has been sent to turn it on.
async function checkPermissions() {
  if (!bridge.permissions) return;
  const result = await bridge.permissions().catch(() => null);
  if (!result?.ok) return;
  const missing = !result.accessibility || !result.screen;
  $("#permissions-banner").hidden = !missing;
  if (!missing) return;
  $("#grant-accessibility").classList.toggle("done", result.accessibility);
  $("#grant-screen").classList.toggle("done", result.screen);
  $("#permissions-text").textContent = result.accessibility
    ? "Almost there: allow screen recording so Jarvis can see what it's doing. Then reopen Jarvis."
    : "macOS needs your OK before Jarvis can click, type and see the screen for tasks. Flip Jarvis's switch in each list.";
}

function renderRunner() {
  const pill = $("#runner-pill");
  pill.dataset.state = state.online === null ? "pending" : state.online ? "online" : "offline";
  $("#runner-text").textContent = state.online === null ? "Connecting…" : state.online ? "Ready" : "Runner offline";
  pill.title = state.base ? `Runner at ${state.base}. Click to check again.` : "Check the runner again";
  $("#offline-banner").hidden = state.online !== false;
}

function renderHeader() {
  $("#crumb-title").textContent = currentWorkspace()?.name ?? scenario()?.title ?? "Jarvis";
  $("#crumb-model").textContent = state.model ? modelLabel(state.model) : "No model";
}

/* ---------- empty state ---------- */

const SUGGESTION_ICONS = [
  [/news|stories|hacker news|summar/i, "book", "sky"],
  [/weather|look up|search|web/i, "globe", "mint"],
  [/spotify|music|song|play/i, "wave", "lilac"],
  [/finder|folder|file/i, "folder", "peach"],
  [/unreal|camera|light|viewport/i, "cube", "mint"],
];

function renderEmpty() {
  const empty = state.thread.length === 0;
  $("#empty-state").hidden = !empty;
  if (!empty) return;
  const current = scenario();
  $("#empty-sub").textContent =
    current?.id === "any-task" || !current
      ? "Ask a question or give me a task. I work in the background, so you can keep using your Mac."
      : current.description;
  const box = $("#suggestions");
  box.replaceChildren();
  const prompts = [...(EXTRA_SUGGESTIONS[current?.id] ?? []), current?.defaultPrompt].filter(Boolean);
  for (const prompt of [...new Set(prompts)].slice(0, 4)) {
    const button = el("button", "suggestion");
    button.type = "button";
    const [, kind, tone] = SUGGESTION_ICONS.find(([pattern]) => pattern.test(prompt)) ?? [null, "chat", "lilac"];
    const mark = icon(kind, "icon suggestion-icon");
    mark.dataset.tone = tone;
    button.append(mark, el("span", "", prompt));
    button.addEventListener("click", () => {
      $("#prompt").value = prompt;
      autosize();
      $("#prompt").focus();
      renderComposer();
    });
    box.append(button);
  }
}

/* ---------- run rendering ---------- */

function stepRow(step, run) {
  const row = el("li", "step");
  row.dataset.id = step.id;
  const marker = el("span", "step-marker");
  const body = el("div", "step-body");
  const head = el("div", "step-head");
  const title = el("span", "step-title");
  const time = el("span", "step-time");
  head.append(title, time);
  body.append(head);
  row.append(marker, body);
  if (step.kind === "screen" && step.image) {
    const thumb = el("button", "step-thumb");
    thumb.type = "button";
    thumb.setAttribute("aria-label", "Open screenshot");
    const image = el("img");
    image.loading = "lazy";
    image.alt = "";
    image.src = step.image;
    thumb.append(image);
    thumb.addEventListener("click", () => openGallery(run.runId, step.image));
    body.append(thumb);
  }
  if (step.detail && step.kind !== "thought") {
    const toggle = el("button", "step-more", step.kind === "action" ? "Show Code" : "Details");
    toggle.type = "button";
    const pre = el("pre", "step-detail");
    pre.hidden = true;
    pre.append(el("code", "", step.detail));
    toggle.addEventListener("click", () => {
      pre.hidden = !pre.hidden;
      toggle.textContent = pre.hidden ? (step.kind === "action" ? "Show Code" : "Details") : "Hide";
    });
    head.append(toggle);
    body.append(pre);
  }
  updateStepRow(row, step, run);
  return row;
}

function stepIcon(step) {
  if (step.level === "pending") return null;
  if (step.kind === "action") return ACTION_ICONS.find(([pattern]) => pattern.test(step.title))?.[1] ?? "click";
  if (step.kind === "screen" && step.caption) return "globe";
  return STEP_ICONS[step.kind];
}

function updateStepRow(row, step, run) {
  row.className = `step kind-${step.kind} level-${step.level}`;
  const marker = row.querySelector(".step-marker");
  const iconName = stepIcon(step);
  if (marker.dataset.icon !== String(iconName)) {
    marker.dataset.icon = String(iconName);
    marker.replaceChildren(iconName ? icon(iconName) : el("span", "spinner"));
  }
  row.querySelector(".step-title").textContent = step.kind === "screen" && step.caption ? `Viewed ${step.caption}` : step.title;
  const offset = run.startedAt && step.at ? Date.parse(step.at) - Date.parse(run.startedAt) : null;
  row.querySelector(".step-time").textContent = offset === null || Number.isNaN(offset) ? "" : `+${clock(offset)}`;
}

/* ---------- sources ---------- */

const favicons = new Map(); // host → Promise<data URL | null>

function hostHue(host) {
  let hash = 0;
  for (const char of host) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

// The site's own icon when the main process can fetch it (renderer CSP allows only data: images), otherwise a
// coloured monogram so every source still has a recognisable mark.
function favicon(host, className = "favicon") {
  const mark = el("span", className);
  mark.style.setProperty("--hue", String(hostHue(host)));
  mark.textContent = host.replace(/^(www|m|en)\./, "").charAt(0).toUpperCase();
  if (bridge.favicon) {
    if (!favicons.has(host)) favicons.set(host, bridge.favicon(host).catch(() => null));
    void favicons.get(host).then((src) => {
      if (!src) return;
      const image = el("img");
      image.alt = "";
      image.src = src;
      image.addEventListener("error", () => image.remove());
      mark.replaceChildren(image);
      mark.classList.add("has-image");
    });
  }
  return mark;
}

function openSource(url) {
  void bridge.openExternal?.(url).then((result) => {
    if (result && !result.ok) toast(result.error ?? "That link can't be opened.", "error");
  });
}

function sourceChip(source) {
  const chip = el("button", "source-chip");
  chip.type = "button";
  chip.title = source.title ? `${source.title}\n${source.url}` : source.url;
  chip.append(favicon(source.host), el("span", "", source.host));
  chip.addEventListener("click", () => openSource(source.url));
  return chip;
}

function sourceCard(source, index) {
  const card = el("button", "source-card");
  card.type = "button";
  card.title = source.url;
  const head = el("span", "source-head");
  head.append(favicon(source.host), el("span", "source-host", source.host), el("span", "source-index", String(index + 1)));
  card.append(head, el("span", "source-title", source.title || pathLabel(source.url)));
  card.addEventListener("click", () => openSource(source.url));
  return card;
}

function pathLabel(url) {
  try {
    const { pathname } = new URL(url);
    const last = decodeURIComponent(pathname.split("/").filter(Boolean).at(-1) ?? "");
    return last ? last.replace(/[-_]+/g, " ").replace(/\.\w+$/, "") : "Home page";
  } catch {
    return url;
  }
}

function renderSources(view, run) {
  const sources = run.sources ?? [];
  const running = isRunning(run);
  const signature = `${running}|${sources.map((source) => source.url).join("|")}`;
  if (view.sourcesSig === signature) return;
  view.sourcesSig = signature;
  // While it works: a strip of the sites it is reading, growing as it goes. When done: numbered source cards.
  view.strip.replaceChildren(...sources.slice(-8).map(sourceChip));
  if (sources.length > 8) view.strip.prepend(el("span", "source-more", `+${sources.length - 8}`));
  view.strip.hidden = !running || sources.length === 0;
  view.sourceList.replaceChildren(...sources.map(sourceCard));
  view.sourcesTitle.textContent = `${sources.length} source${sources.length === 1 ? "" : "s"}`;
  view.sources.hidden = running || sources.length === 0;
}

function createRunView(runId) {
  const root = el("article", "turn");
  root.dataset.run = runId;

  const user = el("div", "msg user");
  const bubble = el("div", "bubble");
  const files = el("ul", "attachments in-bubble");
  user.append(files, bubble);

  const agent = el("div", "msg agent");
  const avatar = el("div", "avatar");
  const column = el("div", "agent-col");
  const meta = el("div", "agent-meta");
  const name = el("span", "agent-name", "Jarvis");
  const model = el("span", "agent-model");
  const badge = el("span", "badge");
  meta.append(name, model, badge);

  const activity = el("div", "activity");
  const summary = el("button", "activity-summary");
  summary.type = "button";
  const summaryIcon = el("span", "activity-icon");
  const summaryText = el("span", "activity-text");
  const summaryNow = el("span", "activity-now");
  const summaryTime = el("span", "activity-time");
  summary.append(summaryIcon, summaryText, summaryNow, summaryTime, icon("chevron", "icon chevron"));
  const steps = el("ol", "steps");
  const strip = el("div", "source-strip");
  activity.append(summary, strip, steps);
  summary.addEventListener("click", () => {
    state.activityOpen.set(runId, !activity.classList.contains("open"));
    activity.classList.toggle("open");
  });

  const reply = el("div", "reply md");
  const sources = el("section", "sources");
  const sourcesHead = el("div", "sources-head");
  const sourcesTitle = el("span", "sources-title");
  sourcesHead.append(icon("link"), sourcesTitle);
  const sourceList = el("div", "source-list");
  sources.append(sourcesHead, sourceList);
  const error = el("div", "callout error");
  const actions = el("div", "msg-actions");
  const ask = el("div", "ask-card");
  ask.hidden = true;
  column.append(meta, activity, ask, reply, sources, error, actions);
  agent.append(avatar, column);
  root.append(user, agent);
  root.addEventListener("pointerdown", () => {
    if (state.focusRunId !== runId) {
      state.focusRunId = runId;
      renderScreen();
      renderRecent();
    }
  });

  const view = {
    root, bubble, files, model, badge, activity, summaryIcon, summaryText, summaryNow, summaryTime, steps, strip,
    reply, sources, sourcesTitle, sourceList, sourcesSig: null, error, actions, ask, rows: new Map(),
  };
  views.set(runId, view);
  return view;
}

function renderActions(view, run) {
  const signature = `${run.status}|${Boolean(run.reply)}`;
  if (view.actions.dataset.sig === signature) return;
  view.actions.dataset.sig = signature;
  view.actions.replaceChildren();
  if (isRunning(run)) return;
  if (run.reply) {
    const copy = el("button", "msg-action");
    copy.type = "button";
    copy.append(icon("copy"), el("span", "", "Copy"));
    copy.addEventListener("click", () => copyText(run.reply));
    view.actions.append(copy);
  }
  const retry = el("button", "msg-action");
  retry.type = "button";
  retry.append(icon("retry"), el("span", "", "Run Again"));
  retry.addEventListener("click", () => void send(run.prompt));
  const edit = el("button", "msg-action");
  edit.type = "button";
  edit.append(icon("steps"), el("span", "", "Edit Prompt"));
  edit.addEventListener("click", () => {
    $("#prompt").value = run.prompt;
    autosize();
    $("#prompt").focus();
    renderComposer();
  });
  view.actions.append(retry, edit);
}

function renderRun(run) {
  const view = views.get(run.runId) ?? createRunView(run.runId);
  if (!view.root.isConnected) $("#run-list").append(view.root);
  view.bubble.textContent = run.prompt;
  const attached = run.attachments ?? [];
  const filesSig = attached.map((item) => item.path).join("|");
  if (view.files.dataset.sig !== filesSig) {
    view.files.dataset.sig = filesSig;
    view.files.replaceChildren(...attached.map((item) => attachmentChip(item)));
  }
  view.files.hidden = attached.length === 0;
  view.model.textContent = [run.model ? modelLabel(run.model) : "", run.scenarioTitle].filter(Boolean).join(" · ");

  const paused = isRunning(run) && run.paused === true;
  const waiting = isRunning(run) && Boolean(run.question);
  const label = waiting ? "Waiting for you" : paused ? "Paused" : ({ starting: "Starting", running: "Working", completed: "Done", failed: "Failed", cancelled: "Stopped" }[run.status] ?? run.status);
  view.badge.textContent = label;
  view.badge.className = `badge ${run.status}`;

  const running = isRunning(run);
  const actions = run.steps.filter((step) => step.kind === "action").length;
  const sources = run.sources?.length ?? 0;
  view.activity.classList.toggle("running", running);
  view.activity.hidden = run.steps.length === 0 && !running;
  // The source strip and the current step say enough while it works; the full step list is one click away.
  view.activity.classList.toggle("open", state.activityOpen.get(run.runId) ?? false);
  const iconName = running ? null : run.status === "completed" ? "check" : run.status === "failed" ? "x" : "alert";
  if (view.summaryIcon.dataset.icon !== String(iconName)) {
    view.summaryIcon.dataset.icon = String(iconName);
    view.summaryIcon.replaceChildren(iconName ? icon(iconName) : el("span", "spinner"));
  }
  view.summaryIcon.className = `activity-icon ${run.status}`;
  const tally = [
    sources ? `${sources} source${sources === 1 ? "" : "s"}` : "",
    `${actions} step${actions === 1 ? "" : "s"}`,
    run.controlsScreen ? "used your screen" : "",
  ].filter(Boolean);
  if (running) {
    view.summaryText.textContent = waiting ? "Waiting for your answer" : paused ? "Paused" : run.status === "starting" ? "Starting" : run.controlsScreen ? "Working on your screen" : sources ? "Researching" : "Working";
    const latest = [...run.steps].reverse().find((step) => ["action", "thought"].includes(step.kind));
    view.summaryNow.textContent = latest ? latest.title : "";
  } else {
    view.summaryText.textContent = `${run.status === "completed" ? "Worked" : "Ran"} for ${humanDuration(elapsed(run))}`;
    view.summaryNow.textContent = tally.join(" · ");
  }
  view.summaryTime.textContent = running ? clock(elapsed(run)) : "";

  const seen = new Set();
  for (const step of run.steps) {
    seen.add(step.id);
    const existing = view.rows.get(step.id);
    if (existing) updateStepRow(existing, step, run);
    else {
      const row = stepRow(step, run);
      view.rows.set(step.id, row);
      view.steps.append(row);
    }
  }
  for (const [id, row] of view.rows) {
    if (!seen.has(id)) {
      row.remove();
      view.rows.delete(id);
    }
  }

  if (view.reply.dataset.text !== (run.reply ?? "")) {
    view.reply.dataset.text = run.reply ?? "";
    view.reply.replaceChildren(run.reply ? renderMarkdown(run.reply) : "");
  }
  view.reply.hidden = !run.reply;
  const errorText = run.error ?? (run.status === "cancelled" ? "The run was stopped before it finished." : "");
  view.error.hidden = !errorText;
  if (view.error.dataset.text !== errorText) {
    view.error.dataset.text = errorText;
    view.error.replaceChildren(icon(run.status === "cancelled" ? "alert" : "x"), el("span", "", errorText));
    view.error.className = `callout ${run.status === "cancelled" ? "warn" : "error"}`;
  }
  renderSources(view, run);
  renderActions(view, run);
  renderQuestion(view, run);
}

// The agent is waiting for the user: a question (option buttons, or type the answer) or an approval (Approve / Deny).
function renderQuestion(view, run) {
  const question = run.question;
  const signature = question ? `${question.id}|${state.answering.has(question.id)}` : "";
  if (view.ask.dataset.sig === signature) return;
  view.ask.dataset.sig = signature;
  view.ask.hidden = !question;
  view.ask.replaceChildren();
  if (!question) return;
  const approval = question.kind === "approval";
  const busy = state.answering.has(question.id);
  view.ask.className = `ask-card ${question.kind}`;
  const head = el("div", "ask-head");
  head.append(icon(approval ? "shield" : "question"), el("span", "", approval ? "Jarvis needs your OK" : "Jarvis is asking"));
  view.ask.append(head, el("p", "ask-text", question.text));
  if (question.detail) view.ask.append(el("pre", "ask-detail", question.detail));
  const buttons = el("div", "ask-actions");
  const choices = approval ? [["approve", "Approve"], ["deny", "Deny"]] : question.options.map((option) => [option, option]);
  for (const [answer, label] of choices) {
    const button = el("button", `button ${answer === "deny" ? "ghost" : ""}`, label);
    button.type = "button";
    button.disabled = busy;
    button.addEventListener("click", () => void answerQuestion(run.runId, question, answer));
    buttons.append(button);
  }
  if (!approval) buttons.append(el("span", "ask-hint", choices.length > 0 ? "or type your own answer below" : "Type your answer below"));
  view.ask.append(buttons);
}

async function answerQuestion(runId, question, answer) {
  if (state.answering.has(question.id)) return;
  state.answering.add(question.id);
  const run = state.runs.get(runId);
  if (run) upsertRun(run);
  const result = await bridge.answerRun(runId, question.id, answer);
  state.answering.delete(question.id);
  const latest = state.runs.get(runId);
  // Clear the card at once; the next poll brings the run's own record (and the "You answered" step).
  if (result.ok && latest?.question?.id === question.id) upsertRun({ ...latest, question: null });
  else if (latest) upsertRun(latest);
  if (!result.ok) toast(result.error, "error");
  renderComposer();
  return result.ok;
}

const YES = /^(y|yes|yeah|yep|ok|okay|sure|approve|approved|go ahead|do it|send it|confirm)\b/i;
const NO = /^(n|no|nope|deny|don'?t|do not|stop|cancel|decline)\b/i;

/** Typed or spoken words for an open question: the answer itself, or for an approval a clear yes or no (else null). */
function answerFor(question, words) {
  if (question.kind !== "approval") return words;
  if (YES.test(words)) return "approve";
  if (NO.test(words)) return "deny";
  return null;
}

/** A new question: bring the window back if it stepped aside, notify, and say it when Voice is on. */
function announceQuestion(run) {
  const question = run.question;
  if (!question || state.seenQuestions.has(question.id)) return;
  state.seenQuestions.add(question.id);
  if (state.steppedAsideFor === run.runId) {
    // The agent is waiting, so the screen is free; it steps aside again on its next screen step.
    state.steppedAsideFor = null;
    void bridge.comeBack();
  }
  const chat = chatOf(run.runId);
  const notification = new Notification(question.kind === "approval" ? "Jarvis needs your OK" : "Jarvis has a question", { body: question.text.slice(0, 180) });
  notification.addEventListener("click", () => {
    void bridge.comeBack();
    if (chat) switchChat(chat.id);
  });
  if (state.voice !== "off") void inConversation(() => say(question.kind === "approval" ? `${question.text} Should I go ahead?` : question.text));
}

function removeRunView(runId) {
  views.get(runId)?.root.remove();
  views.delete(runId);
}

function renderThread() {
  renderEmpty();
  for (const id of state.thread) {
    const run = state.runs.get(id);
    if (run) renderRun(run);
  }
  renderRecent();
  scrollToLatest();
}

/* ---------- screen panel ---------- */

function screenRun() {
  const id = state.focusRunId && state.runs.has(state.focusRunId) ? state.focusRunId : state.activeRunId ?? state.thread.at(-1);
  return id ? state.runs.get(id) ?? null : null;
}

function screenshots(run) {
  const images = run ? run.steps.filter((step) => step.kind === "screen" && step.image).map((step) => step.image) : [];
  if (run?.screenshot && images.at(-1) !== run.screenshot) images.push(run.screenshot);
  return images;
}

function renderScreen() {
  $("#app").classList.toggle("screen-closed", !state.screenOpen);
  $("#toggle-screen").setAttribute("aria-pressed", String(state.screenOpen));
  const run = screenRun();
  const running = isRunning(run);
  const images = screenshots(run);
  const latest = images.at(-1) ?? null;
  const image = $("#screen-image");
  if (latest && image.getAttribute("src") !== latest) image.src = latest;
  image.hidden = !latest;
  $("#screen-placeholder").hidden = Boolean(latest);
  $("#live-badge").hidden = !running;

  // The address bar names what the picture shows: the background browser's site, or the user's own screen.
  const frame = run ? [...run.steps].reverse().find((step) => step.kind === "screen" && step.image) : null;
  const where = frame ? (frame.caption ?? "Your screen") : running ? "Starting…" : "Idle";
  $("#viewport-url-text").textContent = where;
  const urlIcon = frame && !frame.caption ? "monitor" : "globe";
  const iconNode = $("#viewport-url-icon");
  if (iconNode.dataset.icon !== urlIcon) {
    iconNode.dataset.icon = urlIcon;
    hydrateIcons(iconNode.parentElement);
  }
  $("#viewport-url").classList.toggle("secure", Boolean(frame?.caption));
  $("#screen-placeholder-text").textContent = !run
    ? "Pages Jarvis reads and anything it does on your screen show up here."
    : running
      ? "Waiting for the first page…"
      : "Nothing to show: this answer didn't need a browser or your screen.";

  const now = run && [...run.steps].reverse().find((step) => step.kind === "action" || step.kind === "thought");
  $("#now").hidden = !(now && running);
  $("#now-text").textContent = now ? now.title : "";

  const film = $("#film");
  const recent = images.slice(-8);
  if (film.dataset.sig !== recent.join("|")) {
    film.dataset.sig = recent.join("|");
    film.replaceChildren();
    for (const src of recent) {
      const button = el("button", `frame ${src === latest ? "current" : ""}`);
      button.type = "button";
      button.setAttribute("aria-label", "Open picture");
      const thumb = el("img");
      thumb.alt = "";
      thumb.src = src;
      button.append(thumb);
      button.addEventListener("click", () => openGallery(run.runId, src));
      film.append(button);
    }
  }

  const stats = $("#stats");
  stats.replaceChildren();
  if (run && run.runId !== "pending") {
    const actions = run.steps.filter((step) => step.kind === "action").length;
    for (const [term, value] of [
      ["Status", { starting: "Starting", running: "Working", completed: "Done", failed: "Failed", cancelled: "Stopped" }[run.status] ?? run.status],
      ["Time", clock(elapsed(run))],
      ["Sources", String(run.sources?.length ?? 0)],
      ["Steps", String(actions)],
      ["Your screen", run.controlsScreen ? "Used" : "Not touched"],
      ["Model", run.model ? modelLabel(run.model) : "—"],
    ]) {
      const row = el("div", "stat");
      row.append(el("dt", "", term), el("dd", term === "Time" && running ? "elapsed-live" : "", value));
      stats.append(row);
    }
  }
}

/* ---------- lightbox ---------- */

function openGallery(runId, src) {
  const images = screenshots(state.runs.get(runId));
  if (images.length === 0) return;
  gallery = { images, index: Math.max(0, images.indexOf(src)) };
  showGalleryImage();
  $("#lightbox").showModal();
}

function showGalleryImage() {
  $("#lightbox-image").src = gallery.images[gallery.index];
  $("#lightbox-count").textContent = `${gallery.index + 1} / ${gallery.images.length}`;
  $("#lightbox-prev").disabled = gallery.index === 0;
  $("#lightbox-next").disabled = gallery.index === gallery.images.length - 1;
}

function stepGallery(delta) {
  const next = gallery.index + delta;
  if (next < 0 || next >= gallery.images.length) return;
  gallery.index = next;
  showGalleryImage();
}

/* ---------- composer ---------- */

function autosize() {
  const prompt = $("#prompt");
  prompt.style.height = "auto";
  prompt.style.height = `${Math.min(prompt.scrollHeight, 220)}px`;
}

function blocker() {
  if (state.online === false) return "Runner offline";
  if (state.auth && state.auth.choices.length === 0) return "Sign in to a model in Accounts";
  if (!state.scenarioId) return "Choose a workspace";
  return null;
}

function renderComposer() {
  const runId = state.activeRunId;
  const running = Boolean(runId);
  const paused = running && state.runs.get(runId)?.paused === true;
  const question = running ? state.runs.get(runId)?.question : null;
  const stopping = running && state.stopping.has(runId);
  const reason = blocker();
  const hasText = $("#prompt").value.trim().length > 0;
  // While this chat's task works, Send stays for follow-ups (add, change, queue next) next to Pause and Stop.
  $("#send").hidden = running && !hasText && !state.judging;
  $("#send").disabled = state.sending || state.judging || (!running && Boolean(reason)) || !hasText;
  $("#send").classList.toggle("busy", state.sending || state.judging);
  $("#send").setAttribute("aria-label", running ? "Send to the running task" : "Send");
  $("#stop").hidden = !running;
  $("#stop").disabled = stopping;
  const pause = $("#pause");
  pause.hidden = !running;
  pause.disabled = state.pausing || stopping;
  pause.classList.toggle("paused", paused);
  pause.setAttribute("aria-label", paused ? "Continue the task" : "Pause the task");
  pause.title = paused ? "Continue" : "Pause after the current step";
  const glyph = paused ? "play-fill" : "pause-fill";
  if (pause.dataset.glyph !== glyph) {
    pause.dataset.glyph = glyph;
    pause.replaceChildren(icon(glyph));
  }
  $("#prompt").placeholder = question
    ? question.kind === "approval"
      ? "Type yes or no, or use the buttons above…"
      : "Type your answer…"
    : running
      ? paused
        ? "Paused. Change the plan, or press play to continue…"
        : "Add to it, change it, or ask for something next…"
      : "Ask Jarvis anything…";
  $("#composer-hint").textContent = state.voicePending
    ? "Confirming · Esc or talk over it to change"
    : state.judging
      ? "Working out what you meant…"
      : question
        ? "Jarvis is waiting for your answer"
        : running
          ? paused
          ? "Paused · press play to continue"
          : hasText
            ? "Enter: Jarvis decides whether to add it, change the plan or do it next"
            : `${mod}. or “Hey Jarvis, stop” to stop`
        : reason ??
          (hasText
            ? "Enter to send"
            : state.voice === "listening" && holdControlOn()
              ? "Hold Control to talk"
              : state.voice === "listening" && state.voiceShortcut
                ? `Too loud? ${LISTEN_KEYS}`
                : "");
  $("#composer-hint").classList.toggle("warn", Boolean(reason) && !running);
}

/* ---------- voice ---------- */

const VOICE_LABELS = {
  off: "Voice",
  preparing: "Starting voice…",
  listening: "Say “Hey Jarvis”",
  hearing: "Listening…",
  transcribing: "Transcribing…",
  following: "Go ahead…",
  thinking: "Thinking…",
  speaking: "Speaking…",
};

function renderVoice(label) {
  const shown = state.voice === "off" ? "off" : (state.voicePhase ?? state.voice);
  const chip = $("#voice");
  chip.dataset.state = shown;
  chip.setAttribute("aria-pressed", String(state.voice !== "off"));
  const listening = shown === "listening" && !state.prefs.wakeWord ? (holdControlOn() ? "Hold Control" : `Press ${LISTEN_KEYS}`) : null;
  $("#voice-label").textContent = label ?? listening ?? VOICE_LABELS[shown];
}

// Hold Control to talk needs the macOS key watcher (built with Xcode's tools) and the setting on.
function holdControlOn() {
  return state.voiceHoldKey && state.prefs.holdControl;
}

async function enableVoice() {
  state.voice = "preparing";
  renderVoice();
  const result = await bridge.voiceEnable();
  if (!result.ok) {
    state.voice = "off";
    state.voiceOn = false;
    persist();
    renderVoice();
    toast(result.error, "error");
    return;
  }
  try {
    await startMicrophone((chunk) => bridge.voiceAudio(chunk));
  } catch (error) {
    await bridge.voiceDisable();
    state.voice = "off";
    state.voiceOn = false;
    persist();
    renderVoice();
    toast(`Jarvis can't use the microphone: ${error.message}`, "error");
    return;
  }
  state.voiceOn = true;
  state.voiceShortcut = Boolean(result.shortcut);
  state.voiceHoldKey = Boolean(result.holdKey);
  persist();
  if (state.voice === "preparing") state.voice = "listening";
  renderVoice();
}

async function disableVoice() {
  cancelVoicePending();
  stopSpeaking();
  state.voicePhase = null;
  await stopMicrophone();
  await bridge.voiceDisable();
  state.voice = "off";
  state.voiceOn = false;
  persist();
  renderVoice();
}

function setPrompt(text) {
  $("#prompt").value = text;
  autosize();
  renderComposer();
}

// Music stays ducked while any part of an exchange is in flight; nested exchanges (a result spoken during a reply)
// share one hold.
let conversationDepth = 0;
async function inConversation(job) {
  if (conversationDepth++ === 0) bridge.voiceBusy(true);
  try {
    return await job();
  } finally {
    if (--conversationDepth === 0) bridge.voiceBusy(false);
  }
}

let speech = null; // the reply being said: { id, player }
const speechPlayers = new Map(); // speech id → player, for the sentence chunks arriving from the voice process
const earlyChunks = new Map(); // chunks that arrived before say() registered their player
let newestSpeechId = 0; // chunks for an older id without a player belong to a reply that was cut off

function stopSpeaking() {
  if (!speech) return false;
  bridge.voiceSilence(speech.id);
  speech.player.stop();
  return true;
}

function playChunk({ id, samples, sampleRate, last }) {
  const player = speechPlayers.get(id);
  if (!player && id <= newestSpeechId) return;
  if (!player) {
    earlyChunks.set(id, [...(earlyChunks.get(id) ?? []), { id, samples, sampleRate, last }]);
    return;
  }
  player.push(samples, sampleRate);
  if (last) player.end();
}

/**
 * Says `request` ({ text } or { run }) out loud, sentence by sentence as the voice process renders them. Resolves true
 * when it played to the end, false when it was cut off, usually by the user talking over it. The microphone stays
 * open throughout; afterwards a short follow-up window takes a reply without the wake phrase.
 */
async function say(request, followUp = true) {
  if (state.voice === "off") return true;
  // "Speak replies out loud" off: the words still show, just not in Jarvis's voice. Task results have their own switch.
  if (typeof request === "string" && !state.prefs.speakReplies) {
    toast(request, "info");
    return true;
  }
  stopSpeaking();
  const started = await bridge.voiceSpeak(typeof request === "string" ? { text: request } : request);
  if (!started.ok || state.voice === "off") return true;
  if (document.hasFocus()) toast(started.text, "info");
  const player = createSpeechPlayer();
  speechPlayers.set(started.id, player);
  speech = { id: started.id, player };
  newestSpeechId = started.id;
  for (const chunk of earlyChunks.get(started.id) ?? []) playChunk(chunk);
  earlyChunks.delete(started.id);
  state.voicePhase = "speaking";
  renderVoice();
  bridge.voiceSpeaking(true);
  const finished = await player.done;
  speechPlayers.delete(started.id);
  if (speech?.player === player) speech = null;
  state.voicePhase = null;
  renderVoice();
  bridge.voiceSpeaking(false, followUp && finished && state.voice !== "off");
  return finished;
}

/** Drops a task Jarvis was about to start. Its words stay in the box for editing. */
function cancelVoicePending() {
  if (!state.voicePending) return false;
  state.voicePending = null;
  stopSpeaking();
  renderComposer();
  return true;
}

function lastReply() {
  for (const id of [...state.thread].reverse()) {
    const reply = state.runs.get(id)?.reply;
    if (reply) return reply.replace(/\s+/g, " ").slice(0, 300);
  }
  return null;
}

async function voiceStop(line) {
  if (cancelVoicePending()) {
    setPrompt("");
    await say(line ?? "Okay, I won't do that.");
  } else if (state.activeRunId ?? [...state.live].at(-1)) {
    // This chat's task first; from a chat with nothing running, the most recently started one.
    const runId = state.activeRunId ?? [...state.live].at(-1);
    state.voiceStoppedRunId = runId;
    void stopRun(runId);
    await say(line ?? "Stopping.");
  } else await say("Nothing is running right now.");
}

async function voiceCancel(line) {
  if (cancelVoicePending()) setPrompt("");
  await say(line ?? "Okay, cancelled.");
}

// Spoken prompts drive the real mouse and keyboard, so Jarvis says what it understood before doing it ("I'll open
// Spotify and play Runway. Proceeding."). That sentence is the moment to catch a mishearing: talk over it, press Esc
// or click the box. The run starts only if it plays to the end.
async function proposeTask({ say: line, prompt }) {
  setPrompt(prompt);
  if (state.activeRunId || state.sending) {
    await say("I'm still on the current task. I've put that in the message box for when it's done.");
    return;
  }
  if (!state.prefs.confirmTasks) {
    // No confirmation: start now, and say what it's doing while it works.
    await send();
    if (state.prefs.speakReplies) void say(line, false);
    return;
  }
  const pending = { prompt };
  state.voicePending = pending;
  renderComposer();
  const heard = await say(`${line} Proceeding.`);
  if (state.voicePending !== pending) return; // cancelled while Jarvis spoke
  state.voicePending = null;
  renderComposer();
  if (!heard) return; // talked over: the correction that follows decides what happens
  await send();
}

/** Lower-case words only, so "London." matches the option "London". */
function normalized(text) {
  return ` ${String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

async function onVoiceCommand({ action, prompt, source }) {
  const addressed = source === "wake" || source === "push-to-talk";
  if (action === "none") {
    if (addressed) toast("Didn't catch that.", "info");
    return;
  }
  await inConversation(async () => {
    // Plain "stop" / "cancel" need no model: act at once.
    if (action === "stop") return voiceStop();
    if (action === "cancel") return voiceCancel();
    // An open question takes what you say as its answer. Words caught in the follow-up window without "Hey Jarvis"
    // may be someone else talking, so they only count when they pick one of the offered options; approvals always
    // need you to address Jarvis (wake phrase, hold Control, the shortcut) or press a button.
    const asking = state.activeRunId ? state.runs.get(state.activeRunId) : null;
    if (asking?.question) {
      const question = asking.question;
      const deliberate = addressed || source === "barge-in";
      const option = question.options.find((choice) => normalized(prompt).includes(normalized(choice)));
      if (!deliberate && (question.kind === "approval" || !option)) {
        toast(question.kind === "approval" ? "To approve by voice, hold Control (or say “Hey Jarvis”) and say yes or no." : "Didn't take that as your answer. Hold Control and answer, or type it.", "info");
        return;
      }
      const answer = option ?? answerFor(question, prompt);
      if (answer === null) return say("Say yes or no.");
      if (await answerQuestion(asking.runId, question, answer)) return say(answer === "deny" ? "Okay, I won't." : "Got it.", false);
      return;
    }
    // While this chat's task works, what you say is judged against it: add, change the plan, queue, stop or answer.
    if (state.activeRunId) return followUp(prompt, { spoken: true });
    state.voicePhase = "thinking";
    renderVoice();
    const result = await bridge.voiceUnderstand({ text: prompt, source, running: null, lastReply: lastReply() });
    state.voicePhase = null;
    renderVoice();
    const reply = result.ok ? result.reply : { kind: "task", say: "On it.", prompt };
    if (reply.kind === "ignore") {
      if (addressed) toast("Didn't catch a task.", "info");
      return;
    }
    if (reply.kind === "stop") return voiceStop(reply.say);
    if (reply.kind === "cancel") return voiceCancel(reply.say);
    if (reply.kind === "answer") return say(reply.say);
    if (reply.kind === "remember" || reply.kind === "schedule") {
      // Saved by the main process already; refresh the lists in case Settings is open.
      void (reply.kind === "remember" ? renderMemories() : renderRoutines());
      return say(reply.say);
    }
    return proposeTask(reply);
  });
}

bridge.onVoice((kind, payload) => {
  if (kind === "progress") {
    renderVoice(`Downloading ${payload.label} ${Math.floor((payload.received / payload.total) * 100)}%`);
    return;
  }
  if (kind === "speech") {
    playChunk(payload);
    return;
  }
  if (kind === "command") {
    void onVoiceCommand(payload);
    return;
  }
  if (payload.error) toast(payload.error, "error");
  if (payload.state === "hearing") {
    stopSpeaking(); // barge-in: the user talked over Jarvis
    if (payload.source === "wake" || payload.source === "push-to-talk") chime();
  }
  if (payload.note === "no-speech") toast(payload.source === "wake" ? "Didn't catch anything after “Hey Jarvis”." : "Didn't catch anything.", "info");
  if (state.voice === "off" && payload.state !== "off") return; // late event after turning voice off
  state.voice = payload.state === "error" ? "off" : payload.state;
  if (state.voice === "off" && state.voiceOn) void disableVoice();
  renderVoice();
});

function fillModels() {
  const select = $("#model");
  select.replaceChildren();
  const choices = state.auth?.choices ?? [];
  if (choices.length === 0) {
    const option = el("option", "", "No signed-in model");
    option.value = "";
    select.append(option);
  }
  for (const choice of choices) {
    const option = el("option", "", choice.label);
    option.value = choice.model;
    select.append(option);
  }
  if (!choices.some((choice) => choice.model === state.model)) state.model = state.auth?.preferredModel ?? choices[0]?.model ?? "";
  select.value = state.model;
  persist();
}

/* ---------- runs ---------- */

function upsertRun(run) {
  state.runs.set(run.runId, run);
  // Runs in other chats keep updating in the background; only the open chat's are drawn.
  const shown = state.thread.includes(run.runId);
  if (shown) renderRun(run);
  renderRecent();
  renderChats();
  if (shown && screenRun()?.runId === run.runId) renderScreen();
  if (shown) scrollToLatest();
  // A question arriving or a pause changes what the composer offers.
  if (shown && run.runId === state.activeRunId) renderComposer();
}

function clearComposer() {
  $("#prompt").value = "";
  autosize();
  state.attachments = [];
  renderAttachments();
}

/**
 * Starts a task in `chat` (the open one, unless a queued task starts in a chat you've left). Typed words for a chat
 * whose task is still working are a follow-up instead: Jarvis judges whether they add to it, change it or queue next.
 */
async function send(promptOverride, { chat = currentChat(), attachments } = {}) {
  const typed = promptOverride === undefined;
  const prompt = (promptOverride ?? $("#prompt").value).trim();
  const files = attachments ?? (typed ? [...state.attachments] : []);
  if (!prompt || state.sending || state.judging) return;
  if (workingRunIn(chat)) {
    if (!typed) return;
    const run = state.runs.get(workingRunIn(chat));
    // An open question takes what you type as its answer.
    if (run?.question) {
      const answer = answerFor(run.question, prompt);
      if (answer === null) return toast("Press Approve or Deny, or type yes or no.", "info");
      clearComposer();
      if (!(await answerQuestion(run.runId, run.question, answer))) setPrompt(prompt);
      return;
    }
    clearComposer();
    return followUp(prompt, { attachments: files });
  }
  const reason = blocker();
  if (reason) {
    toast(reason, "error");
    return;
  }
  // "Every morning at 8 …" and "remember …" become a routine or a memory instead of a one-off task.
  if (typed && files.length === 0) {
    state.judging = true;
    renderComposer();
    const intent = await bridge.typedUnderstand(prompt).catch(() => ({ ok: false }));
    state.judging = false;
    renderComposer();
    const reply = intent.ok ? intent.reply : null;
    if (reply && ["remember", "schedule", "answer"].includes(reply.kind)) {
      clearComposer();
      // say() shows the words itself when it speaks them (or when replies aren't spoken); with Voice off, toast here.
      if (state.voice === "off") toast(reply.say, "ok");
      else void say(reply.say, false);
      if (reply.kind === "remember") void renderMemories();
      if (reply.kind === "schedule") void renderRoutines();
      return;
    }
  }
  state.sending = true;
  if (typed) clearComposer();
  // A chat is named after its first request.
  if (!chat.title && chat.thread.length === 0) chat.title = prompt.slice(0, 80);
  const shown = chat === currentChat();
  if (shown) {
    const pending = { runId: "pending", status: "starting", prompt, model: state.model, scenarioTitle: workspaceById(chat.workspaceId)?.name ?? scenario()?.title ?? "", steps: [], attachments: files, reply: null, error: null, startedAt: new Date().toISOString() };
    chat.thread.push("pending");
    state.runs.set("pending", pending);
    state.focusRunId = null;
    stickToBottom = true;
    renderEmpty();
    upsertRun(pending);
  }
  renderComposer();

  // A run in one of your workspaces goes to Any task with that workspace's instructions, and its folder attached.
  const workspace = workspaceById(chat.workspaceId);
  const withFolder = workspace?.folder && !files.some((item) => item.path === workspace.folder.path) ? [...files, { kind: "folder", ...workspace.folder }] : files;
  const result = await bridge.startRun({
    scenarioId: workspace ? "any-task" : state.scenarioId,
    model: state.model,
    prompt,
    attachments: withFolder,
    ...(workspace ? { workspace: { name: workspace.name, instructions: workspace.instructions } } : {}),
  });
  state.sending = false;
  chat.thread = chat.thread.filter((id) => id !== "pending");
  state.runs.delete("pending");
  removeRunView("pending");
  if (!result.ok) {
    if (typed && !$("#prompt").value) {
      setPrompt(prompt);
      state.attachments = files;
      renderAttachments();
    }
    renderEmpty();
    renderScreen();
    renderComposer();
    toast(result.error, "error");
    return;
  }
  if (result.rerouted) {
    // The selected workspace couldn't do this; follow the router so the next prompt goes there too.
    const from = scenario()?.title ?? "that workspace";
    state.scenarioId = result.scenarioId;
    renderScenarios();
    renderHeader();
    toast(`Moved to “${scenario()?.title ?? "Any task"}”: this isn't a ${from} task.`, "info");
  }
  chat.thread.push(result.run.runId);
  if (isRunning(result.run)) state.live.add(result.run.runId);
  persist();
  upsertRun(result.run);
  renderComposer();
}

function recentProgress(run) {
  return run.steps.filter((step) => ["action", "thought", "steer"].includes(step.kind)).map((step) => step.title).slice(-8);
}

/** Spoken follow-ups are answered out loud; typed ones get a toast. */
function tell(line, spoken) {
  if (spoken) return say(line);
  if (line) toast(line, "info");
}

/**
 * Something said or typed while this chat's task works. A quick model decides: add it to the task, change the plan,
 * queue it as the next task, stop, or just answer. Additions reach the agent at its next step.
 */
async function followUp(text, { spoken = false, attachments = [] } = {}) {
  const chat = currentChat();
  const runId = workingRunIn(chat);
  const run = runId ? state.runs.get(runId) : null;
  if (!run) return send(text, { chat, attachments });
  state.judging = true;
  renderComposer();
  const result = await bridge.followUp({ text, running: run.prompt, progress: recentProgress(run), paused: run.paused === true });
  state.judging = false;
  renderComposer();
  let decision = result.ok ? result.decision : { kind: "add", say: "Got it, I'll factor that in.", message: text };
  // Files only make sense as part of a task, so a question that came with them is an addition.
  if (attachments.length > 0 && decision.kind === "answer") decision = { kind: "add", say: "Got it, I'll take a look.", message: text };
  if (decision.kind === "stop") {
    if (spoken) state.voiceStoppedRunId = runId;
    void stopRun(runId);
    return tell(decision.say, spoken);
  }
  if (decision.kind === "answer") return tell(decision.say, spoken);
  if (decision.kind === "queue") {
    chat.queue.push({ prompt: decision.message, attachments });
    persist();
    renderQueue();
    renderChats();
    return tell(decision.say, spoken);
  }
  const steered = await bridge.steerRun(runId, decision.message, decision.kind, attachments);
  if (steered.ok) return tell(decision.say, spoken);
  // It finished while we were deciding: the words become the next task instead.
  if (!state.live.has(runId) || !isRunning(state.runs.get(runId))) return send(text, { chat, attachments });
  if (!spoken && !$("#prompt").value) {
    setPrompt(text);
    state.attachments = attachments;
    renderAttachments();
  }
  toast(steered.error, "error");
}

async function stopRun(runId = state.activeRunId) {
  if (!runId || state.stopping.has(runId)) return;
  state.stopping.add(runId);
  renderComposer();
  const result = await bridge.stopRun(runId);
  if (!result.ok) {
    state.stopping.delete(runId);
    renderComposer();
  }
  toast(result.ok ? "Stopping the run…" : result.error, result.ok ? "info" : "error");
}

// Pause waits before the agent's next step (a step already running finishes). Typed follow-ups still go in while paused.
async function togglePause() {
  const runId = state.activeRunId;
  const run = runId ? state.runs.get(runId) : null;
  if (!run || state.pausing) return;
  state.pausing = true;
  renderComposer();
  const result = run.paused ? await bridge.resumeRun(runId) : await bridge.pauseRun(runId);
  state.pausing = false;
  if (result.ok) upsertRun({ ...state.runs.get(runId), paused: result.paused });
  else toast(result.error, "error");
  renderComposer();
}

// The agent works in the background first (web lookups, AppleScript), so this window stays put while you keep
// using the computer. Only once the agent takes the real mouse or keyboard does it get out of the way: its
// screenshots would otherwise be mostly this window.
function stepAside(runId) {
  state.steppedAsideFor = runId;
  new Notification("The agent is using your screen", {
    body: "Move the mouse into a screen corner to stop it. This window comes back when it finishes.",
  });
  void bridge.stepAside();
}

function finish(run) {
  state.live.delete(run.runId);
  state.stopping.delete(run.runId);
  const chat = chatOf(run.runId);
  const elsewhere = Boolean(chat) && chat !== currentChat();
  if (elsewhere) chat.unread = true;
  persist();
  renderComposer();
  renderChats();
  const away = state.steppedAsideFor === run.runId;
  if (away) {
    state.steppedAsideFor = null;
    void bridge.comeBack();
  }
  if (state.voice !== "off" && state.prefs.speakResults && run.runId !== state.voiceStoppedRunId) {
    // Typed or spoken, the result is said out loud, then the follow-up window takes "thanks" or a next task.
    void inConversation(() => say({ run: { status: run.status, prompt: run.prompt, reply: run.reply, error: run.error } }));
  }
  if (state.voiceStoppedRunId === run.runId) state.voiceStoppedRunId = null;
  if (chat) startQueued(chat, run.status);
  if (!away && !elsewhere && document.hasFocus()) return;
  const title = run.status === "completed" ? "Agent finished" : run.status === "failed" ? "Run failed" : "Run stopped";
  const body = (run.reply ?? run.error ?? run.prompt).slice(0, 180);
  const notification = new Notification(elsewhere ? `${title} · ${chatTitle(chat)}` : title, { body, silent: run.status === "completed" });
  if (elsewhere) notification.addEventListener("click", () => switchChat(chat.id));
}

// "Up next" starts when the chat's task ends; stopping the task drops the queue, since stop means "not this".
function startQueued(chat, status) {
  if (chat.queue.length === 0) return;
  if (status === "cancelled") {
    const count = chat.queue.length;
    chat.queue = [];
    persist();
    renderQueue();
    toast(`Stopped, so I dropped ${count} queued task${count === 1 ? "" : "s"}.`, "info");
    return;
  }
  if (state.sending) {
    setTimeout(() => startQueued(chat, status), 500);
    return;
  }
  const next = chat.queue.shift();
  persist();
  renderQueue();
  void send(next.prompt, { chat, attachments: next.attachments });
}

let polling = false;
async function pollLive() {
  if (polling || state.live.size === 0) return;
  polling = true;
  const ids = [...state.live];
  const results = await Promise.all(ids.map((id) => bridge.getRun(id)));
  polling = false;
  ids.forEach((id, index) => {
    const result = results[index];
    if (!state.live.has(id)) return;
    if (!result.ok) {
      if (result.missing) state.live.delete(id);
      return;
    }
    const run = result.run;
    upsertRun(run);
    const lab = state.scenarios.find((item) => item.id === run.scenarioId)?.labId;
    announceQuestion(run);
    // Not while it waits for an answer: the window must stay up so the question can be answered.
    if (isRunning(run) && run.controlsScreen && !run.question && !state.steppedAsideFor && lab === "desktop") stepAside(id);
    if (!isRunning(run)) finish(run);
  });
}

/** Runs the runner is still working on (started before a restart, or by voice in a closed window) go back to their chat. */
async function adoptLive() {
  if (state.sending) return;
  const result = await bridge.liveRuns();
  if (!result.ok || state.sending) return;
  let adopted = false;
  for (const run of result.runs) {
    if (!run?.runId || !isRunning(run) || state.live.has(run.runId)) continue;
    const chat = chatOf(run.runId) ?? currentChat();
    if (!chat.title && chat.thread.length === 0) chat.title = run.prompt.slice(0, 80);
    if (!chat.thread.includes(run.runId)) chat.thread.push(run.runId);
    state.live.add(run.runId);
    upsertRun(run);
    adopted = true;
  }
  if (!adopted) return;
  persist();
  renderEmpty();
  renderComposer();
}

async function restoreChat(chat = currentChat()) {
  const ids = chat.thread.filter((id) => !state.runs.has(id));
  const results = await Promise.all(ids.map((id) => bridge.getRun(id)));
  ids.forEach((id, index) => {
    const result = results[index];
    if (result.ok) {
      state.runs.set(id, result.run);
      if (isRunning(result.run)) state.live.add(id);
    } else if (result.missing) chat.thread = chat.thread.filter((item) => item !== id);
  });
  persist();
  renderChats();
  if (chat !== currentChat()) return;
  renderThread();
  renderScreen();
  renderComposer();
}

function switchChat(chatId) {
  if (chatId === state.chatId || !state.chats.some((chat) => chat.id === chatId)) return;
  const leaving = currentChat();
  for (const id of leaving.thread) removeRunView(id);
  // An untouched chat isn't worth keeping in the list.
  if (leaving.thread.length === 0 && leaving.queue.length === 0) state.chats = state.chats.filter((chat) => chat !== leaving);
  state.chatId = chatId;
  currentChat().unread = false;
  // Opening a chat opens its workspace too (your workspaces always run on Any task).
  state.workspaceId = currentChat().workspaceId;
  if (state.workspaceId) state.scenarioId = "any-task";
  state.focusRunId = null;
  stickToBottom = true;
  persist();
  renderThread();
  renderScreen();
  renderComposer();
  renderQueue();
  renderChats();
  renderScenarios();
  renderWorkspaces();
  renderHeader();
  void restoreChat();
  $("#prompt").focus();
}

// A task still working in the chat you leave keeps going; it shows a spinner in Chats and notifies when done.
function newChat() {
  const open = currentChat();
  if (open.thread.length === 0 && open.queue.length === 0) {
    $("#prompt").focus();
    return;
  }
  const chat = newChatRecord(state.workspaceId);
  state.chats.unshift(chat);
  // Old, finished chats fall off the end; one with a task still working never does.
  while (state.chats.length > MAX_CHATS) {
    const index = state.chats.findLastIndex((item) => item !== chat && item !== open && !workingRunIn(item));
    if (index < 0) break;
    state.chats.splice(index, 1);
  }
  switchChat(chat.id);
}

/* ---------- your workspaces ---------- */

let editingWorkspace = null; // the workspace the dialog edits; null while creating one
let workspaceFolder = null;

function openWorkspaceDialog(workspace = null) {
  editingWorkspace = workspace;
  workspaceFolder = workspace?.folder ?? null;
  $("#workspace-dialog-title").textContent = workspace ? "Edit workspace" : "New workspace";
  $("#workspace-name").value = workspace?.name ?? "";
  $("#workspace-instructions").value = workspace?.instructions ?? "";
  $("#workspace-save").textContent = workspace ? "Save" : "Create";
  $("#workspace-delete").hidden = !workspace;
  resetWorkspaceDelete();
  $("#workspace-status").textContent = "";
  renderWorkspaceFolder();
  $("#workspace-dialog").showModal();
  $("#workspace-name").focus();
}

function renderWorkspaceFolder() {
  $("#workspace-folder").textContent = workspaceFolder ? workspaceFolder.path : "No folder: Jarvis works anywhere.";
  $("#workspace-folder").title = workspaceFolder?.path ?? "";
  $("#workspace-folder-clear").hidden = !workspaceFolder;
}

async function pickWorkspaceFolder() {
  const result = await bridge.pickAttachments("folder");
  if (!result.ok) return toast(result.error, "error");
  const [folder] = result.attachments;
  if (!folder) return;
  workspaceFolder = { path: folder.path, name: folder.name };
  renderWorkspaceFolder();
}

function saveWorkspace() {
  const name = $("#workspace-name").value.trim();
  const status = $("#workspace-status");
  status.classList.add("error");
  if (!name) {
    status.textContent = "Give it a name.";
    $("#workspace-name").focus();
    return;
  }
  const taken = state.workspaces.some((item) => item !== editingWorkspace && item.name.toLowerCase() === name.toLowerCase());
  if (taken || state.scenarios.some((item) => item.title.toLowerCase() === name.toLowerCase())) {
    status.textContent = "There's already a workspace with that name.";
    return;
  }
  const fields = { name, instructions: $("#workspace-instructions").value.trim().slice(0, 4000), folder: workspaceFolder };
  if (editingWorkspace) Object.assign(editingWorkspace, fields);
  else state.workspaces.push({ id: crypto.randomUUID(), ...fields });
  const created = editingWorkspace ? null : state.workspaces.at(-1);
  persist();
  $("#workspace-dialog").close();
  renderWorkspaces();
  renderChats();
  renderHeader();
  if (created) enterWorkspace(created.id);
  toast(created ? `“${name}” is ready. Its chats stay here, and Jarvis follows its instructions.` : "Workspace saved.", "ok");
}

function resetWorkspaceDelete() {
  const button = $("#workspace-delete");
  button.dataset.armed = "";
  button.textContent = "Delete workspace";
}

// Deleting a workspace keeps its chats: they move to the general list, so nothing you did is lost by accident.
function deleteWorkspace() {
  const button = $("#workspace-delete");
  if (!editingWorkspace) return;
  if (!button.dataset.armed) {
    button.dataset.armed = "1";
    button.textContent = "Click again to delete (its chats move to Chats)";
    return;
  }
  const gone = editingWorkspace;
  for (const chat of state.chats) if (chat.workspaceId === gone.id) chat.workspaceId = null;
  state.workspaces = state.workspaces.filter((item) => item !== gone);
  if (state.workspaceId === gone.id) state.workspaceId = null;
  persist();
  $("#workspace-dialog").close();
  renderWorkspaces();
  renderScenarios();
  renderChats();
  renderHeader();
  toast(`Deleted “${gone.name}”. Its chats are under Chats now.`, "ok");
}

/* ---------- up next + attachments ---------- */

function renderQueue() {
  const list = $("#queue");
  const queue = currentChat().queue;
  list.hidden = queue.length === 0;
  list.replaceChildren();
  queue.forEach((item, index) => {
    const row = el("li", "queue-item");
    const remove = el("button", "queue-remove");
    remove.type = "button";
    remove.setAttribute("aria-label", "Remove from up next");
    remove.append(icon("close"));
    remove.addEventListener("click", () => {
      currentChat().queue.splice(index, 1);
      persist();
      renderQueue();
      renderChats();
    });
    const files = item.attachments.length > 0 ? [el("span", "queue-files", `+${item.attachments.length} file${item.attachments.length === 1 ? "" : "s"}`)] : [];
    row.append(icon("queue"), el("span", "queue-label", "Up next"), el("span", "queue-text", item.prompt), ...files, remove);
    row.title = item.prompt;
    list.append(row);
  });
}

const thumbnails = new Map();
function thumbnailFor(filePath) {
  if (!thumbnails.has(filePath)) thumbnails.set(filePath, bridge.thumbnail(filePath).then((result) => (result.ok ? result.url : null)));
  return thumbnails.get(filePath);
}

function attachmentChip(item, onRemove) {
  const chip = el("li", `attachment ${item.kind}`);
  const name = item.name || item.path.split("/").at(-1);
  chip.title = item.path;
  const preview = el("span", "attachment-preview");
  preview.append(icon(item.kind === "folder" ? "folder" : "image"));
  if (item.kind === "image") {
    void thumbnailFor(item.path).then((url) => {
      if (!url) return;
      const image = el("img");
      image.src = url;
      image.alt = "";
      preview.replaceChildren(image);
    });
  }
  chip.append(preview, el("span", "attachment-name", name));
  if (onRemove) {
    const remove = el("button", "attachment-remove");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${name}`);
    remove.append(icon("close"));
    remove.addEventListener("click", onRemove);
    chip.append(remove);
  }
  return chip;
}

function renderAttachments() {
  const list = $("#attachments");
  list.hidden = state.attachments.length === 0;
  list.replaceChildren(
    ...state.attachments.map((item, index) =>
      attachmentChip(item, () => {
        state.attachments.splice(index, 1);
        renderAttachments();
        renderComposer();
      }),
    ),
  );
}

function addAttachments(items) {
  for (const item of items) {
    if (state.attachments.some((existing) => existing.path === item.path)) continue;
    if (state.attachments.length >= MAX_ATTACHMENTS) {
      toast(`Up to ${MAX_ATTACHMENTS} attachments at a time.`, "error");
      break;
    }
    state.attachments.push(item);
  }
  renderAttachments();
  renderComposer();
  $("#prompt").focus();
}

async function pickAttachments(kind) {
  $("#attach-menu").hidden = true;
  $("#attach").setAttribute("aria-expanded", "false");
  const result = await bridge.pickAttachments(kind);
  if (result.ok) addAttachments(result.attachments);
  else toast(result.error, "error");
}

async function attachDropped(files) {
  const paths = [...files].map((file) => bridge.pathForFile(file)).filter(Boolean);
  if (paths.length === 0) return;
  const result = await bridge.classifyAttachments(paths);
  if (!result.ok) return toast(result.error, "error");
  if (result.attachments.length < paths.length) toast("Only images (PNG, JPEG, GIF, WebP) and folders can be attached.", "info");
  addAttachments(result.attachments);
}

async function attachPasted(files) {
  for (const file of files) {
    const result = await bridge.saveImage(new Uint8Array(await file.arrayBuffer()), file.type);
    if (result.ok) addAttachments([result.attachment]);
    else toast(result.error, "error");
  }
}

/* ---------- runner + auth ---------- */

async function checkRunner() {
  const result = await bridge.health();
  const was = state.online;
  state.online = Boolean(result.online);
  state.base = result.base ?? "";
  renderRunner();
  renderComposer();
  if (state.online && was !== true) {
    await loadScenarios();
    await restoreChat();
    await adoptLive();
  } else if (state.online) await adoptLive();
  if (!state.online && was !== false) renderScenarios();
}

async function loadScenarios() {
  const result = await bridge.scenarios();
  if (!result.ok) return;
  state.scenarios = result.scenarios;
  if (!state.scenarios.some((item) => item.id === state.scenarioId)) state.scenarioId = result.preferredScenarioId;
  persist();
  renderScenarios();
  renderHeader();
  renderEmpty();
  renderComposer();
}

async function loadAuth() {
  $("#omp-summary").textContent = "Checking…";
  const result = await bridge.getAuth();
  if (!result.ok) {
    toast(result.error, "error");
    return;
  }
  state.auth = result.auth;
  fillModels();
  renderAccounts();
  renderSettings();
  renderHeader();
  renderComposer();
}

/* ---------- settings ---------- */

function openSettings(tab = "voice") {
  renderSettings();
  renderPrefs();
  void loadVoices();
  void loadProfile();
  void renderMemories();
  void renderRoutines();
  void renderConnections();
  selectSettingsTab(typeof tab === "string" ? tab : "voice");
  $("#settings").showModal();
}

function selectSettingsTab(name) {
  for (const tab of document.querySelectorAll("#settings .tab")) {
    const selected = tab.id === `tab-${name}`;
    tab.setAttribute("aria-selected", String(selected));
    $(`#${tab.getAttribute("aria-controls")}`).hidden = !selected;
  }
}

function renderPrefs() {
  for (const input of document.querySelectorAll("#settings [data-pref]")) {
    input.checked = input.dataset.pref === "screenOpen" ? state.screenOpen : Boolean(state.prefs[input.dataset.pref]);
  }
  for (const group of document.querySelectorAll("#settings [data-pref-group]")) {
    for (const input of group.querySelectorAll("input")) input.checked = input.value === state.prefs[group.dataset.prefGroup];
  }
  $("#pref-ptt-keys").textContent = LISTEN_KEYS;
}

// The main process needs the voice preferences (wake word, follow-up, music, personality) and the theme.
function applyPrefs() {
  const { wakeWord, followUp, pauseMusic, holdControl, personality, voice } = state.prefs;
  bridge.voicePrefs?.({ wakeWord, followUp, pauseMusic, holdControl, personality, voice });
  renderComposer();
  bridge.setTheme?.(state.prefs.theme);
  renderVoice();
}

function setPref(name, value) {
  if (name === "screenOpen") {
    state.screenOpen = value;
    renderScreen();
  } else state.prefs[name] = value;
  persist();
  applyPrefs();
}

/* ---------- settings: voice, profile, connections ---------- */

async function loadVoices() {
  const select = $("#voice-select");
  if (select.options.length === 0 && bridge.voiceList) {
    const voices = await bridge.voiceList().catch(() => []);
    for (const [label, gender] of [["Women", "female"], ["Men", "male"]]) {
      const group = el("optgroup");
      group.label = label;
      for (const voice of voices.filter((item) => item.gender === gender)) {
        const option = el("option", "", `${voice.name} · ${voice.accent}`);
        option.value = voice.id;
        group.append(option);
      }
      if (group.children.length) select.append(group);
    }
  }
  select.value = state.prefs.voice;
}

async function previewVoice() {
  if (state.voice === "off") {
    toast("Turn on Voice under the message box to hear Jarvis.", "info");
    return;
  }
  const name = $("#voice-select").selectedOptions[0]?.textContent.split(" · ")[0] ?? "Jarvis";
  await inConversation(() => say(`Hi, I'm Jarvis, speaking as ${name}. Good choice, if I say so myself.`, false));
}

const PROFILE_FIELDS = ["name", "callMe", "location", "about"];

async function loadProfile() {
  const profile = (await bridge.getProfile?.().catch(() => null)) ?? {};
  for (const field of PROFILE_FIELDS) $(`#profile-form [name="${field}"]`).value = profile[field] ?? "";
  $("#profile-status").textContent = "";
}

async function saveProfile() {
  const profile = Object.fromEntries(PROFILE_FIELDS.map((field) => [field, $(`#profile-form [name="${field}"]`).value.trim()]));
  const result = (await bridge.saveProfile?.(profile)) ?? { ok: false, error: "Restart Jarvis to use profiles." };
  $("#profile-status").textContent = result.ok ? "Saved. Jarvis will remember." : result.error;
  $("#profile-status").classList.toggle("error", !result.ok);
}

async function renderMemories() {
  const list = $("#memory-list");
  const result = await bridge.memories().catch((error) => ({ ok: false, error: String(error) }));
  if (!result.ok) {
    list.replaceChildren(el("li", "app-row muted small", result.error));
    return;
  }
  if (result.memories.length === 0) {
    list.replaceChildren(el("li", "app-row muted small", "Nothing yet."));
    return;
  }
  list.replaceChildren(
    ...[...result.memories].reverse().map((memory) => {
      const row = el("li", "app-row");
      const remove = el("button", "button ghost", "Forget");
      remove.type = "button";
      remove.addEventListener("click", async () => {
        const outcome = await bridge.removeMemory(memory.id);
        if (!outcome.ok) toast(outcome.error, "error");
        void renderMemories();
      });
      row.append(el("span", "app-name memory-text", memory.text), remove);
      return row;
    }),
  );
}

async function addMemoryFromForm() {
  const input = $("#memory-input");
  const text = input.value.trim();
  if (!text) return;
  const result = await bridge.addMemory(text);
  if (!result.ok) return toast(result.error, "error");
  input.value = "";
  void renderMemories();
}

async function renderRoutines() {
  const list = $("#routine-list");
  const result = await bridge.routines().catch((error) => ({ ok: false, error: String(error) }));
  if (!result.ok) {
    list.replaceChildren(el("li", "app-row muted small", result.error));
    return;
  }
  if (result.routines.length === 0) {
    list.replaceChildren(el("li", "app-row muted small", "No routines yet. Add one below, or say “every morning at 8, tell me the news”."));
    return;
  }
  list.replaceChildren(
    ...result.routines.map((routine) => {
      const row = el("li", `app-row routine-row ${routine.enabled ? "on" : ""}`);
      const text = el("div", "routine-text");
      const next = routine.enabled && routine.nextRunAt ? ` · next ${new Date(routine.nextRunAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}` : routine.enabled ? "" : " · off";
      text.append(el("span", "app-name", routine.prompt), el("span", "app-status", `${routine.schedule}${next}`));
      const toggle = el("input", "switch");
      toggle.type = "checkbox";
      toggle.setAttribute("role", "switch");
      toggle.setAttribute("aria-label", routine.enabled ? "Turn off" : "Turn on");
      toggle.checked = routine.enabled;
      toggle.addEventListener("change", async () => {
        const outcome = await bridge.saveRoutine({ ...routine, enabled: toggle.checked });
        if (!outcome.ok) toast(outcome.error, "error");
        void renderRoutines();
      });
      const runNow = el("button", "button ghost", "Run now");
      runNow.type = "button";
      runNow.addEventListener("click", () => void startRoutine({ id: routine.id, prompt: routine.prompt, schedule: routine.schedule }));
      const remove = el("button", "button ghost", "Delete");
      remove.type = "button";
      remove.addEventListener("click", async () => {
        const outcome = await bridge.removeRoutine(routine.id);
        if (!outcome.ok) toast(outcome.error, "error");
        void renderRoutines();
      });
      row.append(text, toggle, runNow, remove);
      return row;
    }),
  );
}

async function addRoutineFromForm() {
  const prompt = $("#routine-prompt").value.trim();
  const days = [...document.querySelectorAll("#routine-days input:checked")].map((input) => Number(input.value));
  const status = $("#routine-status");
  const result = await bridge.saveRoutine({ prompt, time: $("#routine-time").value, days, enabled: true });
  status.textContent = result.ok ? "Added." : result.error;
  status.classList.toggle("error", !result.ok);
  if (!result.ok) return;
  $("#routine-prompt").value = "";
  void renderRoutines();
}

/** A routine runs like any task, in its own chat that collects every run of it. */
async function startRoutine(routine) {
  let chat = state.chats.find((item) => item.routineId === routine.id);
  if (!chat) {
    chat = { ...newChatRecord(), title: `Routine · ${routine.prompt.slice(0, 60)}`, routineId: routine.id };
    state.chats.unshift(chat);
    persist();
    renderChats();
  }
  if (workingRunIn(chat)) return; // last time's run is still going
  while (state.sending) await new Promise((resolve) => setTimeout(resolve, 300));
  await send(routine.prompt, { chat });
}

// Due routines wait in the main process until the app is ready to start tasks (runner up, model signed in).
let drainingRoutines = false;
async function runDueRoutines() {
  if (drainingRoutines) return;
  if (blocker()) {
    setTimeout(() => void runDueRoutines(), 5000);
    return;
  }
  drainingRoutines = true;
  try {
    const result = await bridge.takeDueRoutines();
    for (const routine of result.routines ?? []) {
      toast(`Routine: ${routine.prompt.slice(0, 80)}`, "info");
      await startRoutine(routine);
    }
  } finally {
    drainingRoutines = false;
  }
}

// Sites people most often want Jarvis to use while signed in, when the app isn't connected through Composio.
const SIGN_IN_SITES = [
  ["Gmail", "https://mail.google.com/"],
  ["Slack", "https://app.slack.com/"],
  ["X", "https://x.com/login"],
  ["LinkedIn", "https://www.linkedin.com/login"],
  ["WhatsApp", "https://web.whatsapp.com/"],
  ["YouTube", "https://www.youtube.com/"],
];

async function renderConnections() {
  const list = $("#app-list");
  const summary = $("#connections-summary");
  if (!bridge.connections) {
    summary.textContent = "Restart Jarvis to connect apps.";
    return;
  }
  summary.textContent = "Checking…";
  const result = await bridge.connections().catch((error) => ({ configured: false, error: String(error), apps: [] }));
  $("#composio-key").hidden = result.configured;
  summary.textContent = result.error
    ? result.error
    : result.configured
      ? "Connected apps let Jarvis read and send for you. It always asks before sending or posting."
      : "Optional: with a free Composio key Jarvis can use Gmail, Calendar, Slack and more through their APIs. Without one, it uses the sites you're signed in to below.";
  list.replaceChildren(
    ...result.apps.map((app) => {
      const row = el("li", `app-row ${app.connected ? "on" : ""}`);
      const action = el("button", `button ${app.connected ? "ghost" : ""}`, app.connected ? "Disconnect" : "Connect");
      action.type = "button";
      action.addEventListener("click", async () => {
        // Without a Composio key nothing can connect; a greyed-out button that silently does nothing looked broken.
        if (!result.configured) return askForComposioKey(app.name);
        action.disabled = true;
        const outcome = app.connected ? await bridge.disconnectApp(app.slug) : await bridge.connectApp(app.slug);
        if (!outcome.ok) toast(outcome.error ?? "That didn't work.", "error");
        else if (!app.connected) toast(`Finish connecting ${app.name} in your browser, then press Refresh.`, "info");
        await renderConnections();
      });
      const status = el("span", "app-status", app.connected ? "Connected" : app.status || "Not connected");
      if (app.hint) status.title = app.hint;
      row.append(favicon(appHost(app.slug), "favicon app-mark"), el("span", "app-name", app.name), status, action);
      if (app.hint && !app.connected) row.append(el("p", "app-hint", app.hint));
      return row;
    }),
  );
  if (!result.configured && pendingConnect) $("#composio-key").classList.add("needed");
  const sites = $("#site-list");
  if (sites.childElementCount === 0) {
    for (const [name, url] of SIGN_IN_SITES) {
      const button = el("button", "site-chip");
      button.type = "button";
      button.append(favicon(new URL(url).hostname.replace(/^(www|app|mail|web)\./, "")), el("span", "", name));
      button.addEventListener("click", async () => {
        const outcome = (await bridge.browserSignIn?.(url)) ?? { ok: false, error: "Restart Jarvis to use sign-in." };
        if (!outcome.ok) return toast(outcome.error, "error");
        // On macOS closing the window leaves Chromium running (and tasks keep using it), so ask for a real quit.
        toast(`Sign in to ${name} in the window that opened, then quit it (${bridge.platform === "darwin" ? "⌘Q" : "close it"}).`, "info");
        if (outcome.signInAgain) {
          toast("Jarvis now keeps website logins in the macOS Keychain, so sign in to your sites again. If macOS asks about “Chromium Safe Storage”, click Always Allow.", "info");
        }
      });
      sites.append(button);
    }
  }
}

// The app the user tried to connect before adding a key, so the next message can tell them what to press.
let pendingConnect = null;
function askForComposioKey(appName) {
  pendingConnect = appName;
  const box = $("#composio-key");
  box.hidden = false;
  box.classList.add("needed");
  box.scrollIntoView({ behavior: "smooth", block: "center" });
  $("#composio-key-input").focus();
  toast(`To connect ${appName}, Jarvis first needs a free Composio key: sign up at composio.dev, copy the API key from Settings → API keys, and paste it here.`, "info");
}

function appHost(slug) {
  return { gmail: "gmail.com", googlecalendar: "calendar.google.com", slack: "slack.com", twitter: "x.com", github: "github.com", notion: "notion.so", googledrive: "drive.google.com", linkedin: "linkedin.com" }[slug] ?? `${slug}.com`;
}

function renderSettings() {
  const auth = state.auth;
  const count = auth?.accounts.length ?? 0;
  $("#omp-summary").textContent = auth
    ? `${count} image-capable model${count === 1 ? "" : "s"} from omp.${auth.ompDetail ? ` ${auth.ompDetail}` : ""}`
    : "Checking…";
  const models = $("#omp-models");
  models.replaceChildren();
  for (const account of auth?.accounts.slice(0, 8) ?? []) {
    const item = el("li", "model");
    item.append(el("span", "model-name", account.name), el("span", "model-provider", account.provider));
    models.append(item);
  }
  if (count > 8) models.append(el("li", "model more", `and ${count - 8} more`));

  const cards = $("#key-cards");
  cards.replaceChildren(el("h3", "", "API Keys"));
  for (const form of KEY_FORMS) {
    const savedKey = Boolean(auth?.[form.flag]);
    const row = el("div", "key-row");
    const head = el("div", "key-head");
    const status = el("span", `status ${savedKey ? "on" : ""}`, savedKey ? "Saved" : "Not set");
    const toggle = el("button", "button ghost", savedKey ? "Replace" : "Add");
    toggle.type = "button";
    head.append(icon("key"), el("span", "key-title", form.title), status, toggle);
    const fields = el("div", "key-fields");
    if (form.hint) fields.append(el("p", "key-hint", form.hint));
    fields.hidden = true;
    const inputs = form.fields.map((field) => {
      const label = el("label", "field");
      label.append(el("span", "", field.label));
      const input = el("input");
      input.type = field.type;
      input.name = field.key;
      input.autocomplete = "off";
      input.spellcheck = false;
      input.placeholder = { url: "https://api.example.com/v1", text: "Account ID from the Cloudflare dashboard…" }[field.type] ?? "Paste the key…";
      label.append(input);
      fields.append(label);
      return input;
    });
    const save = el("button", "button", "Save Key");
    save.type = "button";
    save.addEventListener("click", async () => {
      const updates = Object.fromEntries(inputs.map((input) => [input.name, input.value]));
      const result = await bridge.saveAuth(updates);
      if (!result.ok) {
        toast(result.error, "error");
        return;
      }
      toast(`${form.title} saved. Restart the runner to use it.`, "ok");
      await loadAuth();
    });
    fields.append(save);
    toggle.addEventListener("click", () => {
      fields.hidden = !fields.hidden;
      if (!fields.hidden) inputs[0].focus();
    });
    row.append(head, fields);
    cards.append(row);
  }
}

/* ---------- scrolling ---------- */

function scrollToLatest() {
  const thread = $("#thread");
  if (stickToBottom) thread.scrollTop = thread.scrollHeight;
  $("#jump").hidden = stickToBottom;
}

$("#thread").addEventListener("scroll", () => {
  const thread = $("#thread");
  stickToBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
  $("#jump").hidden = stickToBottom;
});

/* ---------- wiring ---------- */

$("#composer").addEventListener("submit", (event) => {
  event.preventDefault();
  void send();
});
$("#prompt").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void send();
  }
});
$("#prompt").addEventListener("input", () => {
  cancelVoicePending();
  autosize();
  renderComposer();
});
$("#prompt").addEventListener("pointerdown", () => cancelVoicePending());
$("#voice").addEventListener("click", () => {
  if (state.voice === "off") void enableVoice();
  else if (state.voice !== "preparing") void disableVoice();
});
$("#stop").addEventListener("click", () => void stopRun());
$("#pause").addEventListener("click", () => void togglePause());
$("#attach").addEventListener("click", (event) => {
  event.stopPropagation();
  const menu = $("#attach-menu");
  menu.hidden = !menu.hidden;
  $("#attach").setAttribute("aria-expanded", String(!menu.hidden));
});
for (const item of document.querySelectorAll("#attach-menu [data-kind]")) item.addEventListener("click", () => void pickAttachments(item.dataset.kind));
document.addEventListener("click", (event) => {
  if ($("#attach-menu").hidden || event.target.closest(".attach-wrap")) return;
  $("#attach-menu").hidden = true;
  $("#attach").setAttribute("aria-expanded", "false");
});
// Drop images or folders anywhere on the composer; paste a screenshot straight into the box.
$("#composer").addEventListener("dragover", (event) => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  $("#composer-card").classList.add("dropping");
});
$("#composer").addEventListener("dragleave", (event) => {
  if (!$("#composer").contains(event.relatedTarget)) $("#composer-card").classList.remove("dropping");
});
$("#composer").addEventListener("drop", (event) => {
  event.preventDefault();
  $("#composer-card").classList.remove("dropping");
  void attachDropped(event.dataTransfer?.files ?? []);
});
$("#prompt").addEventListener("paste", (event) => {
  const images = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
  if (images.length === 0) return;
  event.preventDefault();
  void attachPasted(images);
});
$("#model").addEventListener("change", (event) => {
  state.model = event.target.value;
  persist();
  renderHeader();
});
$("#new-chat").addEventListener("click", newChat);
$("#add-workspace").addEventListener("click", () => openWorkspaceDialog());
$("#workspace-save").addEventListener("click", () => saveWorkspace());
$("#workspace-delete").addEventListener("click", () => deleteWorkspace());
$("#workspace-folder-pick").addEventListener("click", () => void pickWorkspaceFolder());
$("#workspace-folder-clear").addEventListener("click", () => {
  workspaceFolder = null;
  renderWorkspaceFolder();
});
// Enter in the name field would submit (close) the dialog; save instead.
$("#workspace-name").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  saveWorkspace();
});
$("#open-settings").addEventListener("click", () => openSettings());
$("#account-pill").addEventListener("click", () => openSettings("accounts"));
for (const tab of document.querySelectorAll("#settings .tab")) tab.addEventListener("click", () => selectSettingsTab(tab.id.replace("tab-", "")));
$("#voice-select").addEventListener("change", (event) => setPref("voice", event.target.value));
$("#voice-preview").addEventListener("click", () => void previewVoice());
$("#profile-save").addEventListener("click", () => void saveProfile());
// Enter in a profile field would submit the settings dialog (closing it); save instead.
$("#profile-form").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target.tagName === "INPUT") {
    event.preventDefault();
    void saveProfile();
  }
});
$("#connections-refresh").addEventListener("click", () => void renderConnections());
$("#memory-add").addEventListener("click", () => void addMemoryFromForm());
$("#routine-add").addEventListener("click", () => void addRoutineFromForm());
// Enter would submit (close) the settings dialog; act on the field instead.
$("#memory-input").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  void addMemoryFromForm();
});
bridge.onSignInWaiting?.(() => toast("The sign-in window opens as soon as the running task finishes its browser step.", "info"));
bridge.onRoutineDue(() => void runDueRoutines());
// Connecting finishes in the browser; when the user comes back to Jarvis, show the new state.
window.addEventListener("focus", () => {
  if ($("#settings").open && !$("#pane-connections").hidden) void renderConnections();
  void checkPermissions();
});
$("#grant-accessibility").addEventListener("click", () => void bridge.openPermission("accessibility"));
$("#grant-screen").addEventListener("click", async () => {
  await bridge.openPermission("screen");
  // macOS applies Screen Recording on the next launch.
  $("#relaunch-app").hidden = false;
});
$("#relaunch-app").addEventListener("click", () => void bridge.relaunch());
$("#composio-key-save").addEventListener("click", async () => {
  const key = $("#composio-key-input").value.trim();
  if (!key) return;
  const result = await bridge.saveAuth({ COMPOSIO_API_KEY: key });
  if (!result.ok) {
    toast(result.error, "error");
    return;
  }
  $("#composio-key-input").value = "";
  // The runner reads the key at the start of every task, so nothing needs restarting.
  toast(pendingConnect ? `Key saved. Now press Connect next to ${pendingConnect} again.` : "Composio key saved.", "ok");
  pendingConnect = null;
  $("#composio-key").classList.remove("needed");
  await renderConnections();
});
$("#settings").addEventListener("change", (event) => {
  const input = event.target;
  if (input.dataset.pref) setPref(input.dataset.pref, input.checked);
  const group = input.closest("[data-pref-group]");
  if (group && input.checked) setPref(group.dataset.prefGroup, input.value);
});
// Citations in replies open in the user's browser, never inside the app window.
$("#thread").addEventListener("click", (event) => {
  const link = event.target.closest("a.md-link");
  if (!link) return;
  event.preventDefault();
  openSource(link.href);
});
$("#refresh-auth").addEventListener("click", () => void loadAuth());
$("#login-omp").addEventListener("click", async () => {
  await bridge.loginOmp();
  toast("omp login opened. Finish it there, then press Refresh.", "info");
});
$("#runner-pill").addEventListener("click", () => void checkRunner());
$("#copy-runner-command").addEventListener("click", () => copyText("pnpm dev:python", "Command copied"));
$("#toggle-screen").addEventListener("click", () => {
  state.screenOpen = !state.screenOpen;
  persist();
  renderScreen();
});
$("#screen-frame").addEventListener("click", () => {
  const run = screenRun();
  const latest = screenshots(run).at(-1);
  if (latest) openGallery(run.runId, latest);
});
$("#jump").addEventListener("click", () => {
  stickToBottom = true;
  scrollToLatest();
});
$("#lightbox-prev").addEventListener("click", () => stepGallery(-1));
$("#lightbox-next").addEventListener("click", () => stepGallery(1));
$("#lightbox").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) $("#lightbox").close();
});
$("#settings").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) $("#settings").close();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && (cancelVoicePending() || stopSpeaking())) return;
  if ($("#lightbox").open && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
    stepGallery(event.key === "ArrowLeft" ? -1 : 1);
    return;
  }
  const primary = bridge.platform === "darwin" ? event.metaKey : event.ctrlKey;
  if (!primary) return;
  const actions = {
    n: newChat,
    ",": openSettings,
    "\\": () => $("#toggle-screen").click(),
    ".": () => void stopRun(),
    k: () => $("#prompt").focus(),
  };
  const action = actions[event.key.toLowerCase()];
  if (action) {
    event.preventDefault();
    action();
  }
});

/* ---------- boot ---------- */

hydrateIcons();
document.body.classList.add(`platform-${bridge.platform}`);
for (const node of document.querySelectorAll("[data-shortcut]")) node.textContent = `${mod}${node.dataset.shortcut}`;
renderRunner();
renderScenarios();
renderAccounts();
renderRecent();
renderChats();
renderWorkspaces();
renderQueue();
renderHeader();
renderEmpty();
renderScreen();
renderComposer();
$("#prompt").focus();

applyPrefs();
void loadAuth();
if (state.voiceOn) void enableVoice();
void checkRunner();
void checkPermissions();
void runDueRoutines();
setInterval(() => void pollLive(), 1000);
setInterval(() => void checkRunner(), 5000);
setInterval(() => {
  for (const id of state.thread) {
    const run = state.runs.get(id);
    if (isRunning(run)) renderRun(run);
  }
  if (isRunning(screenRun())) {
    const live = document.querySelector(".elapsed-live");
    if (live) live.textContent = clock(elapsed(screenRun()));
  }
}, 1000);
