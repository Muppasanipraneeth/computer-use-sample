/* global $, state, icon, mod, holdControlOn, LISTEN_KEYS, el, persist, currentChat, renderChats, bridge, MAX_ATTACHMENTS, toast, runnerStuck, saved */
/* exported autosize, blocker, renderComposer, setPrompt, clearComposer, fillModels, renderQueue, attachmentChip, renderAttachments, pickAttachments, attachDropped, attachPasted */
// The message box: its buttons and hints, the model picker, "up next" and attachments.

/* ---------- composer ---------- */

function autosize() {
  const prompt = $("#prompt");
  prompt.style.height = "auto";
  prompt.style.height = `${Math.min(prompt.scrollHeight, 220)}px`;
}

function blocker() {
  if (state.online === false) return state.setup ? (state.setup.error ?? "Jarvis is getting ready… (first launch installs its engine, about a minute)") : runnerStuck() ? "Runner offline" : "Starting Jarvis…";
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
  $("#send").disabled = state.sending || state.judging || Boolean(state.voiceHeard) || (!running && Boolean(reason)) || !hasText;
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
  // While the box shows what you're saying (live, then the whole request being understood).
  const heardHint = state.voiceHeard ? (state.voiceHeard.final ? "Working out what you meant…" : "Pause when you're done") : null;
  $("#composer-hint").textContent = heardHint ?? (state.voicePending
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
                : ""));
  $("#composer-hint").classList.toggle("warn", Boolean(reason) && !running);
}

function setPrompt(text) {
  $("#prompt").value = text;
  autosize();
  renderComposer();
}

function clearComposer() {
  $("#prompt").value = "";
  autosize();
  state.attachments = [];
  renderAttachments();
}

function fillModels() {
  const select = $("#model");
  select.replaceChildren();
  const choices = state.auth?.choices ?? [];
  if (choices.length === 0) {
    const option = el("option", "", "No signed-in model");
    option.value = "";
    select.append(option);
  }
  // "Auto" starts each task on the fast model and moves to the strong one only if the task proves hard (runner side:
  // a stuck or failing fast model). Offered when the omp account has the Claude models it uses.
  const omp = new Set(choices.map((choice) => choice.model));
  const auto = omp.has("omp:anthropic/claude-sonnet-5-5") || omp.has("omp:anthropic/claude-opus-5-5");
  if (auto) {
    const option = el("option", "", "Auto · picks per task");
    option.value = "auto";
    select.append(option);
  }
  for (const choice of choices) {
    const option = el("option", "", choice.label);
    option.value = choice.model;
    select.append(option);
  }
  const valid = choices.some((choice) => choice.model === state.model) || (auto && state.model === "auto");
  // New installs start on Auto, and existing ones move to it once (the user asked for models picked per task): about
  // two-thirds of every step is the model thinking, so the right-sized model is the lever. A model picked after
  // that stays picked.
  if (!valid || (auto && !state.autoOffered && !saved.autoOffered)) state.model = auto ? "auto" : (state.auth?.preferredModel ?? choices[0]?.model ?? "");
  if (auto) state.autoOffered = true;
  select.value = state.model;
  persist();
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
