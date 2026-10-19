/* global el, state, icon, persist, renderEmpty, $, switchChat, newChatRecord, scenario, isRunning, setStickToBottom, views, renderScreen, currentWorkspace, workingRunIn, chatTitle, bridge, chatOf, workspaceById, toast, removeRunView, modelLabel */
/* exported renderWorkspaces, renderScenarios, renderRecent, renderChats, runSearch, renderHeader, openWorkspaceDialog, pickWorkspaceFolder, clearWorkspaceFolder, saveWorkspace, deleteWorkspace */
// Sidebar: built-in and your own workspaces, the chat list, search, this chat's requests, and the header crumb.

/* ---------- sidebar ---------- */

const LAB_ICONS = { desktop: "cube", kanban: "board", paint: "brush", booking: "bag" };
const SCENARIO_ICONS = { "any-task": "chat" };
// Tile colour per workspace, Notion-style: each place gets its own soft colour.
const SCENARIO_TONES = { "any-task": "lilac", "desktop-cad-engine": "mint" };
const LAB_TONES = { kanban: "sky", paint: "peach", booking: "mint" };

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
      setStickToBottom(false);
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

// Searching looks through every chat in every workspace: chat titles at once, then every saved request and answer
// on the runner. Results replace the chat list until the box is cleared (Esc).
let searchSeq = 0;
async function runSearch() {
  const query = $("#chat-search").value.trim();
  const box = $("#search-results");
  $("#chat-list").hidden = query.length > 0;
  box.hidden = query.length === 0;
  if (!query) return;
  const seq = ++searchSeq;
  const needle = query.toLowerCase();
  const titleHits = state.chats.filter((chat) => chatTitle(chat).toLowerCase().includes(needle)).map((chat) => ({ chat, runId: chat.thread.at(-1) ?? null, text: chatTitle(chat), snippet: "" }));
  renderSearchResults(titleHits, query.length >= 2);
  if (query.length < 2) return;
  await new Promise((resolve) => setTimeout(resolve, 200)); // wait for the typing to settle before asking the runner
  if (seq !== searchSeq) return;
  const result = await bridge.searchRuns(query).catch((error) => ({ ok: false, error: String(error) }));
  if (seq !== searchSeq) return;
  const seen = new Set(titleHits.map((hit) => hit.chat.id));
  const runHits = (result.ok ? result.results : []).map((hit) => ({ chat: chatOf(hit.runId), runId: hit.runId, text: hit.prompt, snippet: hit.snippet })).filter((hit) => !hit.chat || !seen.has(hit.chat.id));
  renderSearchResults([...titleHits, ...runHits], false, result.ok ? "" : result.error);
}

function renderSearchResults(hits, searching, error = "") {
  const box = $("#search-results");
  box.replaceChildren();
  for (const hit of hits.slice(0, 40)) {
    const button = el("button", "recent search-hit");
    button.type = "button";
    const where = hit.chat ? (workspaceById(hit.chat.workspaceId)?.name ?? "Chats") : "Older run";
    const text = el("span", "search-text");
    text.append(el("span", "recent-text", hit.text), el("span", "search-meta", hit.snippet ? `${where} · ${hit.snippet}` : where));
    button.append(icon("chat", "icon search-icon"), text);
    button.title = hit.text;
    button.addEventListener("click", () => openSearchHit(hit));
    const item = el("li");
    item.append(button);
    box.append(item);
  }
  if (hits.length === 0) box.append(el("li", "muted small side-note", error || (searching ? "Searching…" : "Nothing found.")));
}

/** Opens the chat holding a result (adopting a run no chat has any more into a new one) and scrolls to it. */
function openSearchHit(hit) {
  let chat = hit.chat;
  if (!chat) {
    chat = { ...newChatRecord(state.workspaceId), title: hit.text.slice(0, 80), thread: [hit.runId] };
    state.chats.unshift(chat);
    persist();
  }
  $("#chat-search").value = "";
  void runSearch();
  switchChat(chat.id);
  if (hit.runId) {
    state.focusRunId = hit.runId;
    setStickToBottom(false);
    // The chat's runs load just after switching; scroll once its view exists.
    setTimeout(() => views.get(hit.runId)?.root.scrollIntoView({ behavior: "smooth", block: "start" }), 400);
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

function renderHeader() {
  $("#crumb-title").textContent = currentWorkspace()?.name ?? scenario()?.title ?? "Jarvis";
  $("#crumb-model").textContent = state.model ? modelLabel(state.model) : "No model";
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

function clearWorkspaceFolder() {
  workspaceFolder = null;
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
