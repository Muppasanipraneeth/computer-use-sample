/* global state, $, scenario, el, icon, autosize, renderComposer, openGallery, clock, bridge, toast, isRunning, renderScreen, renderRecent, views, copyText, send, attachmentChip, modelLabel, humanDuration, elapsed, renderMarkdown, answerQuestion, stickToBottom: writable */
/* exported renderEmpty, favicon, openSource, renderRun, removeRunView, renderThread, setStickToBottom, scrollToLatest */
// The thread: the empty state, each run's message (steps, sources, reply, question card), and scrolling.

/* ---------- empty state ---------- */

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

const STEP_ICONS = { action: "click", screen: "eye", thought: "thought", warning: "alert", error: "x", note: "dot", turn: "dot", steer: "chat", question: "question", model: "layers" };
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
    run.usageLabel ?? "",
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

/* ---------- scrolling ---------- */

// Whether the thread follows the newest message: picking an earlier request or scrolling up stops it.
function setStickToBottom(value) {
  stickToBottom = value;
}

function scrollToLatest() {
  const thread = $("#thread");
  if (stickToBottom) thread.scrollTop = thread.scrollHeight;
  $("#jump").hidden = stickToBottom;
}
