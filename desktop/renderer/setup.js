/* global bridge, state, renderComposer, restoreChat, adoptLive, renderScenarios, persist, renderHeader, renderEmpty, $, toast, fillModels, renderSettings, openSettings, enableVoice, el, icon, saved */
/* exported checkRunner, loadAuth, renderAccounts, renderRunner, checkPermissions, openSetup, runnerStuck */
// Runner and accounts status, macOS permissions, and the setup checklist.

/* ---------- runner + auth ---------- */

async function checkRunner() {
  const result = await bridge.health();
  const was = state.online;
  state.online = Boolean(result.online);
  // When it went offline: the banner waits a few seconds, so the normal 2 s start at launch doesn't flash a warning.
  state.offlineSince = state.online ? null : (state.offlineSince ?? Date.now());
  state.runnerStarting = result.starting === true;
  state.base = result.base ?? "";
  state.setup = result.setup ?? null;
  renderRunner();
  renderComposer();
  if (state.online && was !== true) {
    await loadScenarios();
    await restoreChat();
    await adoptLive();
  } else if (state.online) await adoptLive();
  if (state.online) void maybeShowSetup();
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
  void maybeShowSetup();
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

function renderRunner() {
  const pill = $("#runner-pill");
  pill.dataset.state = state.online === null ? "pending" : state.online ? "online" : "offline";
  const setup = state.online === false ? state.setup : null;
  $("#runner-text").textContent = state.online === null ? "Connecting…" : state.online ? "Ready" : setup ? (setup.error ? "Setup failed" : "Setting up…") : runnerStuck() ? "Runner offline" : "Starting…";
  pill.title = setup ? (setup.error ?? setup.message ?? setup.output ?? "") : state.base ? `Runner at ${state.base}. Click to check again.` : "Check the runner again";
  $("#offline-banner").hidden = state.online !== false || (!setup && !runnerStuck());
  // First launch installs the engine (about a minute); afterwards the banner only shows while it restarts.
  $("#offline-title").textContent = setup ? (setup.error ? "Jarvis couldn't finish setting up" : "Getting Jarvis ready") : "Jarvis's engine isn't running";
  $("#offline-text").textContent = setup
    ? (setup.error ?? `${setup.message ?? "Installing…"}${setup.output ? ` ${setup.output}` : ""}`)
    : "It restarts on its own in a few seconds. If this stays, copy diagnostics and send them to whoever helps you.";
}

/** Offline long enough that it isn't just starting up (first-launch setup has its own messages). */
function runnerStuck() {
  return state.online === false && state.offlineSince !== null && Date.now() - state.offlineSince > 8000;
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

/* ---------- setup checklist ---------- */

// Each step: is it done, and the one button that fixes it. The first three are what tasks need; 8 of 9 failed runs
// in the field were a missing macOS permission, so this shows on first launch and whenever a required step is missing.
async function setupSteps() {
  const permissions = bridge.permissions ? await bridge.permissions().catch(() => null) : null;
  const mac = bridge.platform === "darwin";
  const connections = await bridge.connections?.().catch(() => null);
  return [
    { id: "runner", required: true, title: "Jarvis's engine is running", detail: state.online ? "Ready." : (state.setup?.error ?? state.setup?.message ?? "Starting… the first launch can take a minute while it installs."), done: state.online === true },
    {
      id: "model", required: true, title: "Sign in to an AI model", detail: "Jarvis thinks with your omp account (Claude, ChatGPT, Gemini…) or an API key.",
      done: Boolean(state.auth?.choices?.length), action: ["Sign in", () => openSettings("accounts")],
    },
    ...(mac
      ? [
          {
            id: "accessibility", required: true, title: "Allow mouse and keyboard", detail: "System Settings → Privacy & Security → Accessibility → turn on Jarvis.",
            done: permissions?.accessibility === true, action: ["Open settings", () => bridge.openPermission("accessibility")],
          },
          {
            id: "screen", required: true, title: "Allow screen recording", detail: "So Jarvis can see what it's doing. Turn on Jarvis, then press Reopen.",
            done: permissions?.screen === true, action: permissions?.screen === false && state.screenAsked ? ["Reopen Jarvis", () => bridge.relaunch()] : ["Open settings", () => { state.screenAsked = true; return bridge.openPermission("screen"); }],
          },
        ]
      : []),
    { id: "voice", title: "Talk to Jarvis (optional)", detail: "Hold Control or say “Hey Jarvis”. Everything you say stays on this computer.", done: state.voice !== "off", action: ["Turn on voice", () => enableVoice()] },
    { id: "web", title: "Sign in to your websites (optional)", detail: "Gmail, Slack, LinkedIn… once, in Jarvis's own browser; tasks reuse it in the background.", done: false, optionalDoneText: "Do it any time", action: ["Choose sites", () => openSettings("connections")] },
    { id: "apps", title: "Connect apps (optional)", detail: "Faster, more reliable Gmail, Calendar, Slack through Composio.", done: Boolean(connections?.apps?.some((item) => item.connected)), action: ["Connect", () => openSettings("connections")] },
  ];
}

async function renderSetup() {
  const steps = await setupSteps();
  const list = $("#setup-list");
  list.replaceChildren(
    ...steps.map((step) => {
      const row = el("li", `setup-step ${step.done ? "done" : ""} ${step.required ? "required" : ""}`);
      const mark = el("span", "setup-mark");
      mark.append(step.done ? icon("check") : el("span", "setup-dot"));
      const text = el("div", "setup-text");
      text.append(el("strong", "", step.title), el("span", "", step.done ? (step.id === "runner" ? "Ready." : "Done.") : step.detail));
      row.append(mark, text);
      if (!step.done && step.action) {
        const [label, run] = step.action;
        const button = el("button", `button ${step.required ? "" : "ghost"}`, label);
        button.type = "button";
        button.addEventListener("click", async () => {
          await run();
          setTimeout(() => void renderSetup(), 800);
        });
        row.append(button);
      }
      return row;
    }),
  );
  const missing = steps.filter((step) => step.required && !step.done).length;
  $("#setup-status").textContent = missing ? `${missing} required step${missing === 1 ? "" : "s"} left` : "You're all set.";
  $("#setup-status").classList.toggle("error", missing > 0);
  return missing;
}

async function openSetup() {
  await renderSetup();
  if (!$("#setup").open) $("#setup").showModal();
}

/** First launch, or a required step went missing (a permission reset by an update): show the checklist once per launch. */
let setupShown = false;
async function maybeShowSetup() {
  if (setupShown || state.online !== true || !state.auth) return;
  setupShown = true;
  const steps = await setupSteps();
  const missing = steps.some((step) => step.required && !step.done);
  if (!saved.setupSeen || missing) {
    state.setupSeen = true;
    persist();
    void openSetup();
  }
}
