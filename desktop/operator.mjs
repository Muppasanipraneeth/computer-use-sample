/** Values the Electron window is allowed to show. API keys never leave this module's caller. */

import path from "node:path";

import { CURATED_APPS } from "./connections.mjs";

export const ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "JARVIS_COMPATIBLE_API_KEY",
  "JARVIS_COMPATIBLE_BASE_URL",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "COMPOSIO_API_KEY",
];
export const DEFAULT_SCENARIO = "any-task";

const SELECTOR = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SCREENSHOT_PATH = /^\/api\/runs\/[A-Za-z0-9_-]+\/artifacts\/screenshots\/[A-Za-z0-9._-]+$/;

export function parseEnv(text) {
  const values = {};
  for (const line of text.split("\n")) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#") || !line.includes("=")) continue;
    const separator = line.indexOf("=");
    values[line.slice(0, separator).trim()] = unquote(line.slice(separator + 1).trim());
  }
  return values;
}

function unquote(raw) {
  if (raw.length >= 2 && raw[0] === raw.at(-1) && (raw[0] === '"' || raw[0] === "'")) {
    const inner = raw.slice(1, -1);
    return raw[0] === "'" ? inner : inner.replaceAll("\\\\", "\\").replaceAll('\\"', '"');
  }
  return raw;
}

export function quoteEnv(value) {
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error("A saved value cannot contain a line break.");
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function upsertEnv(text, updates) {
  const lines = text.split("\n");
  const seen = new Set();
  const rewritten = [];
  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#") || !line.includes("=")) {
      rewritten.push(line);
      continue;
    }
    const key = line.slice(0, line.indexOf("=")).trim();
    if (Object.hasOwn(updates, key)) {
      rewritten.push(`${key}=${quoteEnv(updates[key])}`);
      seen.add(key);
    } else {
      rewritten.push(line);
    }
  }
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) rewritten.push(`${key}=${quoteEnv(value)}`);
  }
  const body = rewritten.join("\n").replace(/\n$/, "");
  return body ? `${body}\n` : "";
}

export function readAuthEnv(text, environ = {}) {
  const values = Object.fromEntries(ENV_KEYS.map((key) => [key, String(environ[key] ?? "").trim()]));
  const parsed = parseEnv(text);
  for (const key of ENV_KEYS) {
    if (String(parsed[key] ?? "").trim()) values[key] = parsed[key].trim();
  }
  return values;
}

export function validateAuthUpdates(updates) {
  if (!updates || typeof updates !== "object") throw new Error("Nothing to save.");
  const clean = {};
  for (const [key, value] of Object.entries(updates)) {
    if (!ENV_KEYS.includes(key)) throw new Error("That sign-in field is not supported.");
    if (typeof value !== "string" || !value.trim() || value.includes("\n") || value.includes("\r")) {
      throw new Error("Enter a single-line value.");
    }
    clean[key] = value.trim();
  }
  if (Object.keys(clean).length === 0) throw new Error("Nothing to save.");
  return clean;
}

export function authSnapshot(env, accounts, ompDetail = null) {
  return {
    openai: Boolean(env.OPENAI_API_KEY),
    anthropic: Boolean(env.ANTHROPIC_API_KEY),
    compatible: Boolean(env.JARVIS_COMPATIBLE_API_KEY && env.JARVIS_COMPATIBLE_BASE_URL),
    cloudflare: Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN),
    composio: Boolean(env.COMPOSIO_API_KEY),
    accounts,
    ompDetail,
    choices: modelChoices(accounts, env),
    preferredModel: preferredModel(accounts),
  };
}

export function accountsFromOmpStdout(stdout) {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let payload;
  try {
    payload = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return [];
  }
  const models = Array.isArray(payload?.models) ? payload.models : [];
  const unique = new Map();
  for (const model of models) {
    if (!model || model.kind !== "chat" || !Array.isArray(model.input) || !model.input.includes("image")) continue;
    const { provider, id, selector, name } = model;
    if (![provider, id, selector, name].every((value) => typeof value === "string" && value)) continue;
    if (!SELECTOR.test(selector) || unique.has(selector)) continue;
    unique.set(selector, { provider, id, selector, name });
  }
  return [...unique.values()].sort((left, right) => left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name));
}

export function ompLoginCommand(platform = process.platform) {
  if (platform === "darwin") return ["osascript", "-e", 'tell application "Terminal" to do script "omp login"'];
  return ["omp", "login"];
}

export function preferredModel(accounts) {
  const match = accounts.find((account) => account.selector === "openai-codex/gpt-6-astra");
  if (match) return `omp:${match.selector}`;
  return accounts[0] ? `omp:${accounts[0].selector}` : null;
}

export function modelChoices(accounts, env) {
  const choices = accounts.map((account) => ({
    label: `${account.name} · ${account.provider}`,
    model: `omp:${account.selector}`,
  }));
  if (env.OPENAI_API_KEY) choices.push({ label: "OpenAI API key", model: "gpt-6-astra" });
  if (env.ANTHROPIC_API_KEY) choices.push({ label: "Claude API key", model: "anthropic:claude-sonnet-4-5" });
  if (env.JARVIS_COMPATIBLE_API_KEY && env.JARVIS_COMPATIBLE_BASE_URL) choices.push({ label: "Other API", model: "compatible:" });
  return choices;
}

export function preferredScenario(scenarios) {
  const ids = scenarios.map((item) => String(item?.id ?? ""));
  if (ids.includes(DEFAULT_SCENARIO)) return DEFAULT_SCENARIO;
  return ids[0] ?? "";
}

export function scenarioSummary(item) {
  return {
    id: String(item.id),
    title: String(item.title || item.id),
    description: typeof item.description === "string" ? item.description : "",
    defaultPrompt: typeof item.defaultPrompt === "string" ? item.defaultPrompt : "",
    labId: typeof item.labId === "string" ? item.labId : "",
  };
}

// Words that only make sense inside each narrow workspace. A prompt with none of them is not that workspace's job.
// "Any task" has no entry: it can do anything, so it is where everything else goes.
const WORKSPACE_CUES = {
  "paint-draw-poster": ["draw", "drawing", "sketch", "paint", "brush", "pencil", "eraser", "canvas", "layer", "smiley", "shape", "rectangle", "circle", "ellipse", "poster", "artwork", "doodle"],
  "kanban-reprioritize-sprint": ["board", "kanban", "card", "cards", "column", "columns", "sprint", "backlog", "launch planner"],
  "booking-complete-reservation": ["book", "booking", "hotel", "reservation", "reserve", "room", "check-in", "check in", "northstar", "luma harbor"],
  "desktop-cad-engine": ["unreal", "uproject", "actor", "actors", "viewport", "blueprint", "level", "camera actor", "place actors", "point light", "outliner"],
};
const ROUTE_TARGET = "any-task";

function mentions(prompt, cue) {
  const escaped = cue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "[\\s-]+");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i").test(prompt);
}

/**
 * Picks the workspace a prompt actually belongs to. A sticky lab selection must not swallow unrelated requests
 * ("open Spotify" in Sketch Studio launched the drawing lab and its rules), so prompts without any of the selected
 * workspace's cues go to "Any task".
 */
export function routeScenario(prompt, selectedId, scenarioIds) {
  const cues = WORKSPACE_CUES[selectedId];
  if (!cues || !scenarioIds.includes(ROUTE_TARGET) || cues.some((cue) => mentions(prompt, cue))) {
    return { scenarioId: selectedId, rerouted: false };
  }
  return { scenarioId: ROUTE_TARGET, rerouted: true };
}

/** Desktop runs have no turn limit (`maxResponseTurns: null`): the agent works until it answers or the operator presses Stop. */
export function startRunBody(scenarioId, prompt, model, attachments = []) {
  const command = prompt.trim();
  if (!scenarioId) throw new Error("Choose a scenario first.");
  if (!command) throw new Error("Enter a command first.");
  if (!model.trim() || model.endsWith(":")) throw new Error("Choose a signed-in model first.");
  const files = wireAttachments(attachments);
  return {
    scenarioId,
    prompt: command,
    model: model.trim(),
    browserMode: "headful",
    maxResponseTurns: null,
    ...(files.length > 0 ? { attachments: files } : {}),
  };
}

export const MAX_ATTACHMENTS = 10;

/** Only `{ kind, path }` crosses to the runner, which checks the files itself; anything else from the renderer is dropped. */
export function wireAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .filter((item) => (item?.kind === "image" || item?.kind === "folder") && typeof item.path === "string" && path.isAbsolute(item.path))
    .slice(0, MAX_ATTACHMENTS)
    .map(({ kind, path: itemPath }) => ({ kind, path: itemPath }));
}

export const TERMINAL_STATUSES = ["completed", "failed", "cancelled"];

// The runner only marks these through the event message, so the strings are the contract (responses_loop.py, omp_client.py).
const FINAL_MESSAGE = "Model returned a final response.";
const PROGRESS_MESSAGE = "Model progress.";
// The runner's event when a follow-up reaches the agent (runner.py steer_run); its detail is "Added: …" or "Changed plan: …".
const STEER_MESSAGE = "User instruction added.";
// Ask-the-user events (runner.py): the question shows as Jarvis asking, the reply as the user's words.
const ASK_MESSAGES = new Set(["Waiting for your answer.", "Approval requested."]);
const REPLY_TITLES = { "You answered.": null, "You approved.": "Approved", "You declined.": "Declined" };
const TURN_MESSAGE = /turn (\d+) completed/i;
// One alternation so labels come out in code order. `display(web.screenshot())` must precede the generic `display(`.
const CALL =
  /pyautogui\.(?<gui>\w+)\((?<guiArgs>[^)]*)\)|web\.goto\((?<goto>[^)]*)\)|web\.page\.(?:[^\n]*?\.)?(?<pageOp>click|fill|type|press|check|select_option)\((?<pageArgs>[^)]*)\)|(?<![\w.])read\((?<read>[^)]*)\)|(?<![\w.])apps\.(?<appsOp>connected|search|run)\((?<appsArgs>[^)]*)\)|(?<webLook>display\(\s*web\.screenshot\(\s*\)\s*\))|(?<![\w.])display\(/g;
const STRING = /(["'])((?:\\.|(?!\1).)*)\1/;
const STRINGS = /(["'])((?:\\.|(?!\1).)*)\1/g;

function clip(text, length) {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function point(args) {
  const numbers = args.match(/-?\d+(?:\.\d+)?/g);
  return numbers && numbers.length >= 2 ? ` (${Math.round(numbers[0])}, ${Math.round(numbers[1])})` : "";
}

function keys(args) {
  return [...args.matchAll(STRINGS)].map((match) => match[2]).join("+") || "a key";
}

function host(args) {
  const text = args.match(STRING)?.[2];
  if (!text) return "a page";
  try {
    return new URL(text).hostname.replace(/^www\./, "");
  } catch {
    return clip(text, 40);
  }
}

function describePage(op, segment, args) {
  const where = "in the background browser";
  const texts = [...args.matchAll(STRINGS)].map((match) => match[2]);
  switch (op) {
    case "click": {
      const name = segment.match(/name\s*=\s*(["'])((?:\\.|(?!\1).)*)\1/)?.[2] ?? segment.match(/get_by_text\(\s*(["'])((?:\\.|(?!\1).)*)\1/)?.[2];
      return name ? `Click “${clip(name, 30)}” ${where}` : `Click ${where}`;
    }
    case "fill":
    case "type":
      return texts.length ? `Type “${clip(texts.at(-1), 40)}” ${where}` : `Type ${where}`;
    case "press":
      return `Press ${texts.at(-1) ?? "a key"} ${where}`;
    default:
      return `Choose an option ${where}`;
  }
}

/** apps.run("GMAIL_SEND_EMAIL", …) → "Gmail: send email"; Composio tool slugs are TOOLKIT_ACTION. */
function describeApps(op, args) {
  if (op === "connected") return "Check connected apps";
  if (op === "search") return "Find app tools";
  const slug = args.match(STRING)?.[2] ?? "";
  const app = CURATED_APPS.find((item) => slug.toLowerCase().startsWith(`${item.slug}_`));
  if (!app) return slug ? `Use ${clip(slug, 40)}` : "Use a connected app";
  return `${app.name}: ${clip(slug.slice(app.slug.length + 1).toLowerCase().replaceAll("_", " "), 40)}`;
}

function describeCall(name, args) {
  switch (name) {
    case "click":
    case "leftClick":
      return `Click${point(args)}`;
    case "doubleClick":
      return `Double-click${point(args)}`;
    case "tripleClick":
      return `Triple-click${point(args)}`;
    case "rightClick":
      return `Right-click${point(args)}`;
    case "middleClick":
      return `Middle-click${point(args)}`;
    case "moveTo":
    case "moveRel":
      return `Move pointer${point(args)}`;
    case "dragTo":
    case "dragRel":
      return `Drag${point(args)}`;
    case "mouseDown":
      return "Hold mouse";
    case "mouseUp":
      return "Release mouse";
    case "write":
    case "typewrite": {
      const text = args.match(STRING)?.[2];
      return text === undefined ? "Type text" : `Type “${clip(text, 40)}”`;
    }
    case "press":
    case "hotkey":
      return `Press ${keys(args)}`;
    case "keyDown":
      return `Hold ${keys(args)}`;
    case "keyUp":
      return `Release ${keys(args)}`;
    case "scroll":
    case "vscroll":
    case "hscroll":
      return /^\s*-/.test(args) ? "Scroll down" : "Scroll up";
    case "screenshot":
      return "Look at the screen";
    default:
      return null;
  }
}

/** Human labels for the instrument calls in one exec_py block, in order, without consecutive repeats. */
export function describeCode(code) {
  const labels = [];
  for (const match of String(code).matchAll(CALL)) {
    const { gui, guiArgs, goto, pageOp, pageArgs, read, appsOp, appsArgs, webLook } = match.groups;
    let label;
    if (gui) label = describeCall(gui, guiArgs);
    else if (goto !== undefined) label = `Open ${host(goto)}`;
    else if (pageOp) label = describePage(pageOp, match[0], pageArgs);
    else if (read !== undefined) label = `Read ${host(read)}`;
    else if (appsOp) label = describeApps(appsOp, appsArgs);
    else if (webLook) label = "Look at the background browser";
    else label = "Look at the screen";
    if (label && labels.at(-1) !== label) labels.push(label);
  }
  return labels;
}

function actionTitle(labels) {
  if (labels.length === 0) return "Ran Python";
  const shown = labels.slice(0, 2).join(" · ");
  return labels.length > 2 ? `${shown} · +${labels.length - 2} more` : shown;
}

function codeFromDetail(detail) {
  const text = String(detail ?? "");
  const json = text.startsWith("exec_py ") ? text.slice("exec_py ".length) : text;
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed.code === "string") return parsed.code;
  } catch {
    // Older runs logged plain text; show it as-is.
  }
  return text;
}

/** The http(s) URL in a string literal, or null: sources only cite pages a person could open. */
function webUrl(text) {
  if (typeof text !== "string") return null;
  try {
    const url = new URL(text.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Literal URLs passed to read(...) / web.goto(...) in one exec_py block, in code order. */
function visitedUrls(code) {
  const urls = [];
  for (const match of String(code).matchAll(CALL)) {
    const { goto, read } = match.groups;
    const args = goto ?? read;
    if (args === undefined) continue;
    const url = webUrl(args.match(STRING)?.[2]);
    if (url) urls.push(url);
  }
  return urls;
}

// Markdown links first so their URL is not counted again as a bare URL; the bare form stops at brackets and quotes.
const REPLY_LINK = /\[([^\]\n]+)\]\(\s*(https?:\/\/[^\s)]+)\s*\)|(https?:\/\/[^\s<>()[\]"'`]+)/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

function replyLinks(reply) {
  const links = [];
  for (const match of String(reply ?? "").matchAll(REPLY_LINK)) {
    const url = webUrl(match[2] ?? match[3].replace(TRAILING_PUNCTUATION, ""));
    if (url) links.push({ url, title: match[1]?.trim() || null });
  }
  return links;
}

function addSource(sources, seen, url, title = null) {
  const key = new URL(url.href);
  key.hash = "";
  const existing = seen.get(key.href);
  if (existing) {
    // A page read earlier and cited in the reply keeps its first position but gains the reply's label.
    if (!existing.title && title) existing.title = title;
    return;
  }
  const source = { url: url.href, host: url.hostname.replace(/^www\./, ""), title };
  seen.set(key.href, source);
  sources.push(source);
}

/** The renderer loads screenshots through the shot:// protocol, which only proxies validated runner paths. */
export function screenshotSrc(url) {
  try {
    return `shot://runner${safeScreenshotPath(url)}`;
  } catch {
    return null;
  }
}

function eventStep(event, browsingHost = null) {
  const base = { id: String(event.id), level: String(event.level || "ok"), at: String(event.createdAt || ""), detail: "" };
  const message = String(event.message || event.type || "Update");
  const detail = typeof event.detail === "string" ? event.detail : "";
  switch (event.type) {
    case "function_call_requested": {
      const code = codeFromDetail(detail);
      return { ...base, kind: "action", title: actionTitle(describeCode(code)), detail: code };
    }
    case "screenshot_captured": {
      // The runner's picture of the hidden browser's page (for Live), as opposed to a look at the real screen.
      const background = message.includes("(Background browser)");
      return {
        ...base,
        kind: "screen",
        title: background ? "Background browser" : "Looked at the screen",
        image: screenshotSrc(detail),
        caption: background ? browsingHost : null,
      };
    }
    case "run_failed":
      return { ...base, kind: "error", title: message, detail };
    case "run_cancelled":
      return { ...base, kind: "warning", title: message, detail };
    case "run_progress": {
      if (message === PROGRESS_MESSAGE) return { ...base, kind: "thought", title: detail || message };
      if (message === STEER_MESSAGE) return { ...base, kind: "steer", title: detail || message };
      if (ASK_MESSAGES.has(message)) return { ...base, kind: "question", title: detail.split("\n")[0] || message, detail };
      if (Object.hasOwn(REPLY_TITLES, message)) return { ...base, kind: "steer", title: REPLY_TITLES[message] ?? (detail || message) };
      const turn = message.match(TURN_MESSAGE);
      if (turn) return { ...base, kind: "turn", title: `Step ${turn[1]}`, detail };
      return { ...base, kind: base.level === "warn" ? "warning" : "note", title: message, detail };
    }
    default:
      return { ...base, kind: "note", title: message, detail };
  }
}

// pyautogui calls that drive the user's real mouse or keyboard (screenshots and size/position reads don't).
const SCREEN_CONTROL = /\bpyautogui\.(?:click|doubleClick|tripleClick|rightClick|middleClick|moveTo|moveRel|move|dragTo|dragRel|drag|mouseDown|mouseUp|scroll|vscroll|hscroll|press|hotkey|keyDown|keyUp|write|typewrite)\s*\(/;

/** True when this exec_py code takes the user's mouse or keyboard, as opposed to background work. */
export function controlsScreen(code) {
  return SCREEN_CONTROL.test(String(code));
}

/** The agent's open question, or null. Approvals always offer exactly Approve and Deny. */
function pendingQuestion(question) {
  if (!question || typeof question !== "object" || typeof question.id !== "string" || typeof question.text !== "string") return null;
  const approval = question.kind === "approval";
  return {
    id: question.id,
    kind: approval ? "approval" : "question",
    text: question.text,
    detail: typeof question.detail === "string" && question.detail ? question.detail : null,
    options: approval ? [] : Array.isArray(question.options) ? question.options.filter((option) => typeof option === "string" && option.trim()).slice(0, 6) : [],
  };
}

function isRunningStatus(status) {
  return !TERMINAL_STATUSES.includes(status);
}

/** Stateless view of one run: the renderer diffs steps by id, so the same detail can be projected on every poll. */
export function projectRun(detail) {
  const run = detail?.run && typeof detail.run === "object" ? detail.run : {};
  const status = String(run.status ?? "unknown");
  const steps = [];
  let reply = null;
  let error = null;
  let screen = false;
  const sources = [];
  const seenSources = new Map();
  // Host of the page the background browser was last pointed at, so its frames can say what they show.
  let browsingHost = null;
  for (const event of detail?.events ?? []) {
    if (!event || typeof event !== "object" || !event.id) continue;
    if (event.type === "run_completed") continue;
    if (event.type === "function_call_completed") {
      const pending = steps.findLast((step) => step.kind === "action" && step.level === "pending");
      if (pending) pending.level = "ok";
      continue;
    }
    if (event.type === "run_progress" && event.message === FINAL_MESSAGE) {
      reply = typeof event.detail === "string" ? event.detail : null;
      continue;
    }
    const step = eventStep(event, browsingHost);
    if (step.kind === "error") error = step.detail || step.title;
    if (step.kind === "action") {
      if (controlsScreen(step.detail)) screen = true;
      for (const url of visitedUrls(step.detail)) {
        addSource(sources, seenSources, url);
        browsingHost = url.hostname.replace(/^www\./, "");
      }
    }
    steps.push(step);
  }
  if (TERMINAL_STATUSES.includes(status)) {
    for (const step of steps) if (step.level === "pending") step.level = status === "completed" ? "ok" : "warn";
  }
  for (const { url, title } of replyLinks(reply)) addSource(sources, seenSources, url, title);
  const screenshots = detail?.browser && typeof detail.browser === "object" ? detail.browser.screenshots : null;
  const last = Array.isArray(screenshots) ? screenshots.at(-1) : null;
  return {
    runId: run.id ? String(run.id) : null,
    status,
    prompt: String(run.prompt ?? ""),
    model: String(run.model ?? ""),
    scenarioId: String(run.scenarioId ?? ""),
    scenarioTitle: String(detail?.scenario?.title ?? run.scenarioId ?? ""),
    startedAt: run.startedAt ?? null,
    completedAt: run.completedAt ?? null,
    durationMs: Number.isFinite(run.durationMs) ? run.durationMs : null,
    maxTurns: Number.isFinite(run.maxResponseTurns) ? run.maxResponseTurns : null,
    reply,
    error,
    steps,
    controlsScreen: screen,
    paused: run.paused === true,
    question: isRunningStatus(status) ? pendingQuestion(run.question) : null,
    attachments: Array.isArray(run.attachments)
      ? run.attachments.filter((item) => item && typeof item.path === "string").map((item) => ({ kind: item.kind === "folder" ? "folder" : "image", path: item.path, name: String(item.name || path.basename(item.path)) }))
      : [],
    screenshot: last ? screenshotSrc(last.url) : null,
    sources,
  };
}

export function runnerErrorText(payload) {
  if (payload && typeof payload === "object") {
    const error = String(payload.error || "The runner rejected the command.");
    return typeof payload.hint === "string" && payload.hint ? `${error} ${payload.hint}` : error;
  }
  return "The runner rejected the command.";
}

export function safeScreenshotPath(url) {
  if (typeof url !== "string" || !url.startsWith("/api/runs/")) throw new Error("That screenshot path is not allowed.");
  const parsed = new URL(url, "http://127.0.0.1");
  if (parsed.origin !== "http://127.0.0.1" || parsed.search || parsed.hash || !SCREENSHOT_PATH.test(parsed.pathname)) {
    throw new Error("That screenshot path is not allowed.");
  }
  return parsed.pathname;
}

export function assertRunnerBase(url) {
  const parsed = new URL(url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) || !["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("The runner must stay on this machine.");
  }
  return parsed.origin;
}
