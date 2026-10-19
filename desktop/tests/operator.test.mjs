import assert from "node:assert/strict";
import test from "node:test";

import {
  accountsFromOmpStdout,
  authSnapshot,
  describeCode,
  modelChoices,
  ompLoginCommand,
  preferredModel,
  preferredScenario,
  projectRun,
  readAuthEnv,
  runnerErrorText,
  safeScreenshotPath,
  routeScenario,
  screenshotSrc,
  startRunBody,
  upsertEnv,
  validateAuthUpdates,
  wireAttachments,
  wireWorkspace,
  usageText,
} from "../operator.mjs";

test("usage reads as tokens and cost, and older runs without it show nothing", () => {
  const run = projectRun({ run: { id: "r", status: "completed", usage: { inputTokens: 11200, outputTokens: 1250, cachedTokens: 9000, costUsd: 0.0437, turns: 3 }, modelSwitches: [{ to: "omp:anthropic/claude-opus-5-5" }] } });
  assert.equal(run.usageLabel, "12.4k tokens · $0.04");
  assert.equal(run.switchedTo, "omp:anthropic/claude-opus-5-5");
  assert.equal(projectRun({ run: { id: "o", status: "completed" } }).usageLabel, "");
  assert.equal(usageText({ inputTokens: 300, outputTokens: 20, costUsd: 0.001 }), "320 tokens · <$0.01");
  assert.equal(usageText({ inputTokens: 300, outputTokens: 20, costUsd: null }), "320 tokens");
});

test("auto mode's model choice and switch read as plain steps", () => {
  const run = projectRun({
    run: { id: "m", status: "running" },
    events: [
      event("c", "run_progress", "Chose a model for this task.", { detail: "omp:anthropic/claude-haiku-5-5 · quick question" }),
      event("s", "run_progress", "Switched to a stronger model.", { level: "warn", detail: "omp:anthropic/claude-opus-5-5 · two failed steps" }),
    ],
  });
  assert.deepEqual(run.steps.map(({ kind, title }) => ({ kind, title })), [
    { kind: "model", title: "Using claude-haiku-5-5 (quick question)" },
    { kind: "model", title: "Switched to claude-opus-5-5 (two failed steps)" },
  ]);
});

test("a workspace reaches the runner as a trimmed name and instructions, or not at all", () => {
  const body = startRunBody("any-task", "Draft a reply", "omp:a/b", [], { id: "w1", name: "  Glymph work ", instructions: " Use my work Gmail. ", folder: { path: "/x" } });
  assert.deepEqual(body.workspace, { name: "Glymph work", instructions: "Use my work Gmail." });
  assert.equal("workspace" in startRunBody("any-task", "Draft a reply", "omp:a/b", [], { name: "   " }), false);
  assert.deepEqual(wireWorkspace({ name: "x".repeat(90) }), { name: "x".repeat(80), instructions: "" });
});

test("auth snapshot reports presence without the key", () => {
  const snapshot = authSnapshot(
    {
      OPENAI_API_KEY: "sk-secret",
      ANTHROPIC_API_KEY: "",
      JARVIS_COMPATIBLE_API_KEY: "key",
      JARVIS_COMPATIBLE_BASE_URL: "https://example.test/v1",
      CLOUDFLARE_ACCOUNT_ID: "acc",
      CLOUDFLARE_API_TOKEN: "cf-secret",
      COMPOSIO_API_KEY: "ck-secret",
    },
    [{ provider: "cursor", id: "gpt", selector: "cursor/gpt", name: "GPT" }],
  );
  assert.equal(snapshot.openai, true);
  assert.equal(snapshot.anthropic, false);
  assert.equal(snapshot.compatible, true);
  assert.equal(snapshot.cloudflare, true);
  assert.equal(snapshot.composio, true);
  assert.equal(authSnapshot({}, []).composio, false);
  assert.equal(authSnapshot({ CLOUDFLARE_API_TOKEN: "cf-secret" }, []).cloudflare, false, "a token without an account id is unusable");
  assert.equal(/sk-secret|cf-secret|ck-secret/.test(JSON.stringify(snapshot)), false);
  assert.deepEqual(validateAuthUpdates({ COMPOSIO_API_KEY: " ck " }), { COMPOSIO_API_KEY: "ck" });
  // Copied as a whole env line from a dashboard: keep only the value.
  for (const pasted of ["COMPOSIO_API_KEY=ak_123", 'export COMPOSIO_API_KEY="ak_123"', "COMPOSIO_API_KEY: 'ak_123'", '"ak_123"']) {
    assert.deepEqual(validateAuthUpdates({ COMPOSIO_API_KEY: pasted }), { COMPOSIO_API_KEY: "ak_123" }, pasted);
  }
  // Another field's name is not stripped, and a name with no value is no value.
  assert.deepEqual(validateAuthUpdates({ OPENAI_API_KEY: "COMPOSIO_API_KEY=x" }), { OPENAI_API_KEY: "COMPOSIO_API_KEY=x" });
  assert.throws(() => validateAuthUpdates({ COMPOSIO_API_KEY: "COMPOSIO_API_KEY=" }), /single-line value/);
});

test("env round trip updates one key and keeps comments", () => {
  const next = upsertEnv('# local\nOPENAI_API_KEY="old"\nHOST="127.0.0.1"\n', {
    ANTHROPIC_API_KEY: 'quoted"key',
  });
  const env = readAuthEnv(next, {});
  assert.equal(env.OPENAI_API_KEY, "old");
  assert.equal(env.ANTHROPIC_API_KEY, 'quoted"key');
  assert.match(next, /HOST="127\.0\.0\.1"/);
  assert.throws(() => validateAuthUpdates({ NOT_A_KEY: "value" }), /not supported/);
});

test("omp accounts are deduped and a command needs a model", () => {
  const stdout = JSON.stringify({
    models: [
      { kind: "chat", input: ["text", "image"], provider: "openai-codex", id: "gpt-6-astra", selector: "openai-codex/gpt-6-astra", name: "GPT 6 Astra" },
      { kind: "chat", input: ["text", "image"], provider: "openai-codex", id: "gpt-6-astra", selector: "openai-codex/gpt-6-astra", name: "GPT 6 Astra" },
      { kind: "chat", input: ["text"], provider: "text", id: "only", selector: "text/only", name: "Text" },
    ],
  });
  const accounts = accountsFromOmpStdout(stdout);
  assert.deepEqual(accounts, [{ provider: "openai-codex", id: "gpt-6-astra", selector: "openai-codex/gpt-6-astra", name: "GPT 6 Astra" }]);
  assert.equal(preferredModel(accounts), "omp:openai-codex/gpt-6-astra");
  const choices = modelChoices(accounts, {});
  assert.equal(choices[0].model, "omp:openai-codex/gpt-6-astra");
  const body = startRunBody("desktop-cad-engine", "Place a cube", choices[0].model);
  assert.equal(body.model, "omp:openai-codex/gpt-6-astra");
  assert.equal(body.browserMode, "headful");
  assert.equal(body.maxResponseTurns, null, "desktop runs have no turn limit");
  assert.throws(() => startRunBody("desktop-cad-engine", "Place a cube", "compatible:"), /signed-in model/);
});

const shot = "/api/runs/run-1/artifacts/screenshots/frame.png";

function event(id, type, message, extra = {}) {
  return { id, type, message, level: "ok", createdAt: "2026-10-18T10:00:00Z", ...extra };
}

test("only absolute image or folder paths reach the runner, at most ten", () => {
  const sent = wireAttachments([
    { kind: "image", path: "/Users/me/shot.png", name: "shot.png", thumbnail: "data:…" },
    { kind: "folder", path: "/Users/me/project" },
    { kind: "image", path: "relative.png" },
    { kind: "script", path: "/bin/sh" },
    null,
  ]);
  assert.deepEqual(sent, [
    { kind: "image", path: "/Users/me/shot.png" },
    { kind: "folder", path: "/Users/me/project" },
  ]);
  assert.equal(wireAttachments(Array.from({ length: 12 }, (_, index) => ({ kind: "image", path: `/tmp/${index}.png` }))).length, 10);
  assert.equal("attachments" in startRunBody("any-task", "Describe this", "omp:a/b", "not a list"), false);
  assert.deepEqual(startRunBody("any-task", "Describe this", "omp:a/b", [{ kind: "image", path: "/tmp/a.png" }]).attachments, [{ kind: "image", path: "/tmp/a.png" }]);
});

test("a follow-up shows as the user's words in the steps; pause and attachments come from the record", () => {
  const run = projectRun({
    run: { id: "run-5", status: "running", paused: true, attachments: [{ kind: "image", path: "/data/runs/run-5/attachments/1-shot.png", name: "shot.png" }, { kind: "folder", path: "/Users/me/site" }] },
    events: [event("s1", "run_progress", "User instruction added.", { detail: "Changed plan: play Runaway instead" })],
  });
  assert.deepEqual(run.steps.map(({ kind, title }) => ({ kind, title })), [{ kind: "steer", title: "Changed plan: play Runaway instead" }]);
  assert.equal(run.paused, true);
  assert.deepEqual(run.attachments, [
    { kind: "image", path: "/data/runs/run-5/attachments/1-shot.png", name: "shot.png" },
    { kind: "folder", path: "/Users/me/site", name: "site" },
  ]);
  // Records from before pause and attachments existed.
  const old = projectRun({ run: { id: "run-6", status: "completed" }, events: [] });
  assert.equal(old.paused, false);
  assert.deepEqual(old.attachments, []);
});

test("an open question shows only while the run works; approvals never offer free options", () => {
  const question = { id: "q1", kind: "approval", text: "Gmail: send email", options: ["Sure", "Nope"], detail: "To: a@b.c", createdAt: "2026-10-19T08:00:00Z" };
  const waiting = projectRun({
    run: { id: "run-7", status: "running", question },
    events: [event("a1", "run_progress", "Approval requested.", { level: "warn", detail: "Gmail: send email\nTo: a@b.c" }), event("a2", "run_progress", "You declined.", { level: "warn" })],
  });
  assert.deepEqual(waiting.question, { id: "q1", kind: "approval", text: "Gmail: send email", detail: "To: a@b.c", options: [] });
  assert.deepEqual(waiting.steps.map(({ kind, title }) => ({ kind, title })), [
    { kind: "question", title: "Gmail: send email" },
    { kind: "steer", title: "Declined" },
  ]);
  assert.equal(projectRun({ run: { id: "run-7", status: "cancelled", question } }).question, null);
  const asked = projectRun({ run: { id: "run-8", status: "running", question: { id: "q2", kind: "question", text: "Work or personal?", options: ["Work", " ", 3, "Personal"] } } });
  assert.deepEqual(asked.question.options, ["Work", "Personal"]);
});

test("run projection turns runner events into chat steps and a reply", () => {
  const code = "pyautogui.click(410, 220)\npyautogui.write('cube')\npyautogui.hotkey('command', 's')";
  const detail = {
    run: { id: "run-1", status: "completed", prompt: "Place a cube", model: "omp:a/b", durationMs: 4200 },
    events: [
      event("e1", "run_started", "Run run-1 started."),
      event("e2", "run_progress", "Model turn 1 completed.", { detail: "omp:a/b" }),
      event("e3", "run_progress", "Model progress.", { level: "pending", detail: "Opening Place Actors." }),
      event("e4", "function_call_requested", "Function tool call received from the model.", {
        level: "pending",
        detail: `exec_py ${JSON.stringify({ code })}`,
      }),
      event("e5", "screenshot_captured", "Screenshot captured.", { detail: shot }),
      event("e6", "function_call_completed", "Function tool call completed."),
      event("e7", "run_progress", "Model returned a final response.", { detail: "Placed **one** cube." }),
      event("e8", "run_completed", "Run finished."),
    ],
    browser: { screenshots: [{ url: shot }] },
  };
  const run = projectRun(detail);
  assert.equal(run.reply, "Placed **one** cube.");
  assert.deepEqual(run.steps.map((step) => step.kind), ["note", "turn", "thought", "action", "screen"]);
  const action = run.steps[3];
  assert.equal(action.title, "Click (410, 220) · Type “cube” · +1 more");
  assert.equal(action.detail, code);
  assert.equal(action.level, "ok", "function_call_completed settles the pending action");
  assert.equal(run.steps[1].title, "Step 1");
  assert.equal(run.steps[2].title, "Opening Place Actors.");
  assert.equal(run.screenshot, `shot://runner${shot}`);
  assert.deepEqual(projectRun(detail), run, "projection is stateless so every poll can re-project");
});

test("failed runs surface the error and settle unfinished actions", () => {
  const run = projectRun({
    run: { id: "run-2", status: "failed" },
    events: [
      event("e1", "function_call_requested", "call", { level: "pending", detail: "exec_py {\"code\": \"display(pyautogui.screenshot())\"}" }),
      event("e2", "run_failed", "Run failed during execution.", { level: "error", detail: "omp timed out. Hint: retry." }),
    ],
  });
  assert.equal(run.error, "omp timed out. Hint: retry.");
  assert.equal(run.reply, null);
  assert.equal(run.steps[0].title, "Look at the screen");
  assert.equal(run.steps[0].level, "warn");
  assert.equal(run.screenshot, null);
});

test("only real mouse or keyboard input counts as taking over the screen", () => {
  const runWith = (...codes) =>
    projectRun({
      run: { id: "run-3", status: "running" },
      events: codes.map((code, index) => event(`e${index}`, "function_call_requested", "call", { detail: `exec_py ${JSON.stringify({ code })}` })),
    });
  // Background work: lookups, AppleScript, screenshots and reads of the pointer leave the window where it is.
  const background = runWith(
    "log(read('https://www.techmeme.com/'))",
    "web.goto('https://example.com')",
    "subprocess.run(['osascript', '-e', 'tell application \"Spotify\" to play'])",
    "display(pyautogui.screenshot())\nlog(pyautogui.position(), pyautogui.size())",
  );
  assert.equal(background.controlsScreen, false);
  for (const code of ["pyautogui.click(10, 20)", "pyautogui.hotkey('command', 'l')", "pyautogui.typewrite('hi')", "pyautogui.scroll(-3)"]) {
    assert.equal(runWith("log(read('https://example.com'))", code).controlsScreen, true, code);
  }
});

test("code descriptions read like the actions a person would take", () => {
  assert.deepEqual(describeCode("pyautogui.moveTo(10, 20)\npyautogui.moveTo(10, 20)\npyautogui.doubleClick(x=5.6, y=7)"), [
    "Move pointer (10, 20)",
    "Double-click (6, 7)",
  ]);
  assert.deepEqual(describeCode("pyautogui.press('enter'); pyautogui.scroll(-300)"), ["Press enter", "Scroll down"]);
  assert.deepEqual(describeCode("log('hello')"), []);
});

test("connected-app calls are labeled with the app and action", () => {
  const code = 'apps.connected()\nhits = apps.search("send email", app="gmail")\napps.run("GMAIL_SEND_EMAIL", {"to": "a@b.c"})\nmyapps.run("X")\napps.run("HUBSPOT_CREATE_CONTACT", {})';
  assert.deepEqual(describeCode(code), ["Check connected apps", "Find app tools", "Gmail: send email", "Use HUBSPOT_CREATE_CONTACT"]);
  assert.deepEqual(describeCode('apps.run("TWITTER_CREATION_OF_A_POST", {"text": "hi"})'), ["X: creation of a post"]);
});

test("background browser and reading calls get their own labels in code order", () => {
  const code = [
    "text = read('https://news.ycombinator.com/')",
    "web.goto('https://www.example.com/login')",
    "web.page.fill('#email', 'ada@example.com')",
    "web.page.get_by_role('button', name='Sign in').click()",
    "display(web.screenshot())",
    "data = open('notes.txt').read()",
    "display(pyautogui.screenshot())",
  ].join("\n");
  assert.deepEqual(describeCode(code), [
    "Read news.ycombinator.com",
    "Open example.com",
    "Type “ada@example.com” in the background browser",
    "Click “Sign in” in the background browser",
    "Look at the background browser",
    "Look at the screen",
  ]);
});

// Strings are exec_py code; objects are other runner events, kept in the given order.
function browsingRun(items, reply) {
  const events = items.map((item, index) =>
    typeof item === "string" ? event(`a${index}`, "function_call_requested", "call", { detail: `exec_py ${JSON.stringify({ code: item })}` }) : item,
  );
  return projectRun({
    run: { id: "run-4", status: "completed" },
    events: [...events, event("f", "run_progress", "Model returned a final response.", { detail: reply })],
  });
}

test("sources list every page read, opened or cited, deduped without fragments in first-seen order", () => {
  const run = browsingRun(
    [
      "text = read('https://www.techmeme.com/#top')\nweb.goto(\"https://news.ycombinator.com/item?id=1\")",
      "read('file:///etc/passwd')\nread(path)\nweb.goto('about:blank')\nread('https://techmeme.com/')",
    ],
    "Per [Techmeme](https://www.techmeme.com/#latest) and [TechCrunch](https://techcrunch.com/2026/10/18/story/), see also https://example.com/a?b=1). Also javascript:alert(1).",
  );
  assert.deepEqual(run.sources, [
    { url: "https://www.techmeme.com/#top", host: "techmeme.com", title: "Techmeme" },
    { url: "https://news.ycombinator.com/item?id=1", host: "news.ycombinator.com", title: null },
    { url: "https://techmeme.com/", host: "techmeme.com", title: null },
    { url: "https://techcrunch.com/2026/10/18/story/", host: "techcrunch.com", title: "TechCrunch" },
    { url: "https://example.com/a?b=1", host: "example.com", title: null },
  ]);
  assert.deepEqual(browsingRun(["log('hi')"], "Done.").sources, []);
});

test("background browser frames are captioned with the last page read before them", () => {
  const frame = (id) => event(id, "screenshot_captured", "Screenshot captured. (Background browser)", { detail: shot });
  const run = browsingRun(
    [
      frame("s0"),
      "read('https://www.techmeme.com/')",
      frame("s1"),
      "web.goto('https://news.ycombinator.com/')\ndisplay(web.screenshot())",
      frame("s2"),
      event("s3", "screenshot_captured", "Screenshot captured.", { detail: shot }),
    ],
    "Done.",
  );
  const screens = run.steps.filter((step) => step.kind === "screen");
  assert.deepEqual(
    screens.map((step) => [step.title, step.caption]),
    [
      ["Background browser", null],
      ["Background browser", "techmeme.com"],
      ["Background browser", "news.ycombinator.com"],
      ["Looked at the screen", null],
    ],
  );
});

test("prompts that don't fit the selected lab go to Any task; fitting ones stay", () => {
  const all = ["any-task", "paint-draw-poster", "kanban-reprioritize-sprint", "booking-complete-reservation", "desktop-cad-engine"];
  const route = (prompt, selected) => routeScenario(prompt, selected, all);
  // Real prompts from runs that went to Sketch Studio by accident.
  assert.deepEqual(route("open spotify app and play any music", "paint-draw-poster"), { scenarioId: "any-task", rerouted: true });
  assert.deepEqual(route("hey open grokbot", "paint-draw-poster"), { scenarioId: "any-task", rerouted: true });
  assert.deepEqual(route("open spotify and play runway song", "desktop-cad-engine"), { scenarioId: "any-task", rerouted: true });
  // Real prompts that belong to their lab.
  assert.deepEqual(route("draw rectangle", "paint-draw-poster"), { scenarioId: "paint-draw-poster", rerouted: false });
  assert.deepEqual(route("Place one Camera Actor aimed at the property", "desktop-cad-engine"), { scenarioId: "desktop-cad-engine", rerouted: false });
  assert.equal(route("Book the Luma Harbor Hotel from 4/18 to 4/21", "booking-complete-reservation").rerouted, false);
  assert.equal(route("Move every card on the board to Done", "kanban-reprioritize-sprint").rerouted, false);
  // Whole words only: "blackboard" is not "board", "redraw" is not "draw".
  assert.equal(route("open the blackboard app", "kanban-reprioritize-sprint").rerouted, true);
  // "Any task" itself is never rerouted, and nothing is rerouted when it is unavailable.
  assert.equal(route("draw a cat", "any-task").rerouted, false);
  assert.deepEqual(routeScenario("open spotify", "paint-draw-poster", ["paint-draw-poster"]), { scenarioId: "paint-draw-poster", rerouted: false });
});

test("screenshot paths stay on the runner and other helpers keep their contracts", () => {
  assert.equal(safeScreenshotPath(shot), shot);
  assert.throws(() => safeScreenshotPath("https://example.test/secret.png"), /not allowed/);
  assert.equal(screenshotSrc("/api/runs/run-1/artifacts/screenshots/../../secret"), null);
  assert.equal(preferredScenario([{ id: "paint" }, { id: "any-task" }]), "any-task");
  assert.equal(runnerErrorText({ error: "A run is already active.", hint: "Stop it first." }), "A run is already active. Stop it first.");
  assert.equal(ompLoginCommand("darwin")[0], "osascript");
});
