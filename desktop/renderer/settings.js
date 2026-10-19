/* global $, state, LISTEN_KEYS, bridge, renderComposer, renderVoice, renderScreen, persist, el, toast, inConversation, say, newChatRecord, renderChats, workingRunIn, send, blocker, favicon, icon, loadAuth */
/* exported openSettings, selectSettingsTab, applyPrefs, setPref, previewVoice, saveProfile, renderMemories, addMemoryFromForm, renderRoutines, addRoutineFromForm, runDueRoutines, renderConnections, pendingConnect, renderSettings */
// The settings sheet: preferences, voice, profile, memories, routines, connections and API keys.

/* ---------- settings ---------- */

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
  const { wakeWord, followUp, pauseMusic, holdControl, floatingFace, personality, voice } = state.prefs;
  bridge.voicePrefs?.({ wakeWord, followUp, pauseMusic, holdControl, floatingFace, personality, voice });
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
