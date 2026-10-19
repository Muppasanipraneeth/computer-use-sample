/* global state, renderRun, renderRecent, renderChats, screenRun, renderScreen, scrollToLatest, renderComposer, bridge, toast, chatOf, inConversation, say, currentChat, $, workingRunIn, clearComposer, setPrompt, blocker, renderMemories, renderRoutines, workspaceById, scenario, setStickToBottom, renderEmpty, removeRunView, renderAttachments, renderScenarios, renderHeader, isRunning, persist, renderQueue, chatTitle, renderThread, renderWorkspaces, newChatRecord, MAX_CHATS */
/* exported answerQuestion, answerFor, send, followUp, stopRun, togglePause, pollLive, adoptLive, restoreChat, switchChat, newChat */
// Runs: answering questions, starting, following up, stopping, pausing, polling, and switching chats.

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
  if (result.ok) bridge.avatarTask?.(null);
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
  // Not looking at Jarvis (and it didn't step aside): the floating face asks, so the question is seen at once.
  if (!document.hasFocus() && state.steppedAsideFor !== run.runId) bridge.avatarTask?.("asking", question.text);
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
    setStickToBottom(true);
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
  // The window gets out of the way, so the floating face keeps the user company and shows what the agent is doing.
  bridge.avatarTask?.("working", "Working on your screen. Move the mouse into a corner to stop me.");
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
  // A reaction on the floating face when the user wasn't watching: pleased, or sorry, with the first line of the result.
  if (away || !document.hasFocus()) {
    const line = (run.reply ?? run.error ?? "").replace(/[*_`#>[\]]/g, "").replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0] ?? "";
    bridge.avatarTask?.("done", line.slice(0, 140) || (run.status === "completed" ? "Done." : "That didn't work."), run.status);
  } else bridge.avatarTask?.(null);
  if (state.voice !== "off" && state.prefs.speakResults && run.runId !== state.voiceStoppedRunId) {
    // Typed or spoken, the result is said out loud, then the follow-up window takes "thanks" or a next task.
    const workspace = workspaceById(chat?.workspaceId);
    void inConversation(() => say({ run: { status: run.status, prompt: run.prompt, reply: run.reply, error: run.error, workspace: workspace ? { name: workspace.name, instructions: workspace.instructions } : null } }));
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
    // While it works on the screen, the floating face shows the step it's on.
    if (isRunning(run) && state.steppedAsideFor === id) {
      const step = run.steps.findLast((item) => item.kind === "action" || item.kind === "thought");
      if (step && step.title !== state.faceStep) {
        state.faceStep = step.title;
        bridge.avatarTask?.("working", step.title);
      }
    }
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
  setStickToBottom(true);
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
