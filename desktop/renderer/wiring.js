/* global bridge, renderVoice, playChunk, onVoiceCommand, toast, stopSpeaking, chime, state, disableVoice, $, stickToBottom: writable, send, cancelVoicePending, autosize, renderComposer, enableVoice, stopRun, togglePause, pickAttachments, attachDropped, attachPasted, persist, renderHeader, newChat, openWorkspaceDialog, runSearch, saveWorkspace, deleteWorkspace, pickWorkspaceFolder, clearWorkspaceFolder, openSettings, selectSettingsTab, setPref, renderPrefs, previewVoice, saveProfile, renderConnections, addMemoryFromForm, addRoutineFromForm, runDueRoutines, checkPermissions, openSetup, pendingConnect: writable, openSource, loadAuth, checkRunner, renderScreen, screenRun, screenshots, openGallery, scrollToLatest, stepGallery */
// Event wiring: the voice process, scrolling, and every control's listeners. Loads after every script it calls into.

/* ---------- voice events ---------- */

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

/* ---------- scrolling ---------- */

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
$("#chat-search").addEventListener("input", () => void runSearch());
$("#chat-search").addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    $("#chat-search").value = "";
    void runSearch();
    $("#prompt").focus();
  } else if (event.key === "Enter") {
    event.preventDefault();
    $("#search-results .search-hit")?.click();
  }
});
$("#workspace-save").addEventListener("click", () => saveWorkspace());
$("#workspace-delete").addEventListener("click", () => deleteWorkspace());
$("#workspace-folder-pick").addEventListener("click", () => void pickWorkspaceFolder());
$("#workspace-folder-clear").addEventListener("click", () => clearWorkspaceFolder());
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
// From the floating Jarvis's right-click menu: a changed setting (saved here, where settings live), or "Settings…".
bridge.onAvatarPrefs?.((prefs) => {
  for (const [name, value] of Object.entries(prefs ?? {})) if (name === "floatingFace" || name === "floatingSize") setPref(name, value);
  if ($("#settings").open) renderPrefs();
});
bridge.onOpenSettings?.((tab) => openSettings(tab));
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
$("#copy-diagnostics").addEventListener("click", async () => {
  const result = await bridge.copyDiagnostics();
  toast(result.ok ? "Diagnostics copied. Paste them into your message." : result.error, result.ok ? "ok" : "error");
});
$("#open-logs").addEventListener("click", async () => {
  const result = await bridge.openLogs();
  if (!result.ok) toast(result.error, "error");
});
$("#open-setup").addEventListener("click", () => {
  $("#settings").close();
  void openSetup();
});
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
$("#copy-runner-command").addEventListener("click", () => $("#copy-diagnostics").click());
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
