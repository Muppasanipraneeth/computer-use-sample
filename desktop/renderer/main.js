/* global cancelVoicePending, stopSpeaking, $, stepGallery, bridge, newChat, openSettings, stopRun, state, partOfDay, playWelcome, inConversation, say, hydrateIcons, mod, renderRunner, renderScenarios, renderAccounts, renderRecent, renderChats, renderWorkspaces, renderQueue, renderHeader, renderEmpty, renderScreen, renderComposer, applyPrefs, loadAuth, enableVoice, checkRunner, checkPermissions, runDueRoutines, pollLive, isRunning, renderRun, screenRun, clock, elapsed */
// Keyboard shortcuts, the welcome, and boot. Loads last: everything here runs at once.

/* ---------- keyboard shortcuts ---------- */

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
    f: () => $("#chat-search").focus(),
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

/* ---------- welcome ---------- */

const HELLOS = {
  witty: ["Jarvis is here. Let's make the computer do the boring parts.", "Jarvis is here. Try to give me something harder than yesterday.", "Jarvis is here, caffeinated and ready."],
  friendly: ["Jarvis is here. What can I do for you?", "Jarvis is here and happy to help."],
  concise: ["Jarvis is here."],
};

/** Anything that happened while the window was shut, to say once the intro is over (or "" when nothing did). */
function awayNews() {
  const finished = state.chats.filter((chat) => chat.unread).length;
  const working = state.live.size;
  return [
    finished ? `${finished} task${finished === 1 ? "" : "s"} finished while you were away.` : "",
    working ? `${working} task${working === 1 ? " is" : "s are"} still running.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

// The intro plays once per launch (not when a closed window is reopened). Its spoken hello is the cached recording,
// so it plays even with Voice off; the main process renders it in the background the first time, so on the very first
// launch the intro has only its chime, and with Voice on the hello is spoken live once the engine is listening.
async function welcome() {
  const overlay = $("#welcome");
  const first = await bridge.firstShow?.().catch(() => false);
  if (!first || !state.prefs.welcome) overlay.hidden = true;
  if (!first) return;
  const profile = await bridge.getProfile?.().catch(() => null);
  const name = (profile?.callMe || profile?.name || "").trim();
  const recorded = state.prefs.greet ? await bridge.welcomeVoice?.({ part: partOfDay(), name }).catch(() => null) : null;
  const voice = recorded?.ok ? recorded : null;
  if (state.prefs.welcome) await playWelcome({ name, sound: true, voice });
  if (!state.prefs.greet || !state.voiceOn) return;
  const hellos = HELLOS[state.prefs.personality] ?? HELLOS.witty;
  const line = [voice ? "" : `${partOfDay()}${name ? `, ${name}` : ""}. ${hellos[Math.floor(Math.random() * hellos.length)]}`, awayNews()].filter(Boolean).join(" ");
  if (!line) return;
  for (let waited = 0; waited < 25_000 && state.voice !== "listening"; waited += 300) {
    if (state.voice === "off" && !state.voiceOn) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  // Not over a task's result or the user already talking.
  if (state.voice === "listening" && !state.voicePhase) void inConversation(() => say(line));
}

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
void welcome();
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
