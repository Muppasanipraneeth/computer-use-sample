/* global state, $, isRunning, hydrateIcons, el, clock, elapsed, modelLabel */
/* exported screenRun, screenshots, renderScreen, openGallery, stepGallery */
// The screen panel beside the thread, and the screenshot lightbox.

/* ---------- screen panel ---------- */

let gallery = { images: [], index: 0 };

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
      // Auto shows the model actually doing the work, and says so once it moved to the stronger one.
      ["Model", run.model ? `${modelLabel(run.model)}${run.switchedTo ? " (switched up)" : ""}` : "—"],
      ...(run.usageLabel ? [["Usage", run.usageLabel]] : []),
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
