import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OmpModelInfo, OmpModelsResponse } from "@jarvis/contracts";

import type { JavaScriptSession } from "./browser/javascript-process.js";
import { RunnerCoreError } from "./errors.js";
import type { RunExecutionContext } from "./scenario-runtime.js";

type ToolOutput =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: string };

type OmpAction =
  | { action: "code"; code: string }
  | { action: "final"; text: string };

type OmpHistory =
  | { kind: "code"; code: string; output: string }
  | { kind: "invalid"; text: string };

const selectorPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function resolveOmpBinary() {
  const configured = process.env.OMP_BIN?.trim();
  if (configured) return configured;
  const found = spawnSync("which", ["omp"], { encoding: "utf8" });
  const path = found.stdout.trim();
  if (found.status !== 0 || !path) {
    throw new RunnerCoreError("omp is not installed, so its accounts cannot be used.", {
      code: "omp_unavailable",
      hint: "Install omp and run `omp login` for Cursor, Claude, Codex, or any other account, then refresh the console.",
      statusCode: 400,
    });
  }
  return path;
}

export function assertOmpSelector(selector: string) {
  if (!selectorPattern.test(selector)) {
    throw new RunnerCoreError("An omp model must look like provider/model, for example openai-codex/gpt-6-astra.", {
      code: "invalid_request",
      hint: "Pick a model from the OMP accounts list.",
      statusCode: 400,
    });
  }
}

export function parseOmpCatalog(payload: unknown): OmpModelInfo[] {
  const models = payload && typeof payload === "object" && "models" in payload ? payload.models : undefined;
  if (!Array.isArray(models)) {
    throw new RunnerCoreError("omp models returned an unreadable catalog.", {
      code: "omp_unavailable",
      statusCode: 502,
    });
  }
  const listed: OmpModelInfo[] = [];
  for (const model of models) {
    if (!model || typeof model !== "object") continue;
    const record = model as Record<string, unknown>;
    const input = record.input;
    if (record.kind !== "chat" || !Array.isArray(input) || !input.includes("image")) continue;
    const provider = record.provider;
    const id = record.id;
    const selector = record.selector;
    const name = record.name;
    if (typeof provider !== "string" || typeof id !== "string" || typeof selector !== "string" || typeof name !== "string") continue;
    if (!selectorPattern.test(selector)) continue;
    listed.push({ provider, id, selector, name });
  }
  return listed;
}

export function assistantTextFromOmpEvents(stdout: string) {
  let text = "";
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object" || !("type" in event) || event.type !== "message_end") continue;
    const message = "message" in event ? event.message : undefined;
    if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") continue;
    const content = "content" in message ? message.content : undefined;
    if (!Array.isArray(content)) continue;
    text = content
      .map((part) => (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string" ? part.text.trim() : ""))
      .filter(Boolean)
      .join("\n");
  }
  return text;
}

export function parseOmpAction(text: string): OmpAction {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const source = (fenced?.[1] ?? text).trim();
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new RunnerCoreError("The omp model did not return a JSON action.", {
      code: "unexpected_model_response",
      hint: "The model must return {\"action\":\"code\",\"code\":\"...\"} or {\"action\":\"final\",\"text\":\"...\"}.",
      statusCode: 400,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(source.slice(start, end + 1));
  } catch {
    throw new RunnerCoreError("The omp model returned malformed JSON.", {
      code: "unexpected_model_response",
      statusCode: 400,
    });
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || !("action" in value)) {
    throw new RunnerCoreError("The omp model returned an action this runner cannot run.", {
      code: "unexpected_model_response",
      statusCode: 400,
    });
  }
  const record = value as Record<string, unknown>;
  if (record.action === "code" && typeof record.code === "string") return { action: "code", code: record.code };
  if (record.action === "final" && typeof record.text === "string" && record.text.trim()) {
    return { action: "final", text: record.text.trim() };
  }
  throw new RunnerCoreError("The omp model returned an action this runner cannot run.", {
    code: "unexpected_model_response",
    statusCode: 400,
  });
}

function runProcess(binary: string, args: string[], signal: AbortSignal, timeoutMs: number) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    const onAbort = () => child.kill("SIGTERM");
    const finish = (error?: Error, result?: { stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result!);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (signal.aborted) finish(new Error("Run aborted."));
      else if (code !== 0) finish(new Error(stderr.trim().split("\n").slice(-4).join("\n") || `omp exited ${code}.`));
      else finish(undefined, { stdout, stderr });
    });
  });
}

export async function listOmpModels(): Promise<OmpModelsResponse> {
  let binary: string;
  try {
    binary = resolveOmpBinary();
  } catch (error) {
    return {
      available: false,
      detail: error instanceof Error ? error.message : "omp is not installed.",
      models: [],
    };
  }
  try {
    const { stdout } = await runProcess(binary, ["models", "--json", "--no-extensions"], new AbortController().signal, 20_000);
    const start = stdout.indexOf("{");
    const end = stdout.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("omp models returned no JSON catalog.");
    return { available: true, models: parseOmpCatalog(JSON.parse(stdout.slice(start, end + 1))) };
  } catch (error) {
    return {
      available: false,
      detail: error instanceof Error ? error.message : "omp models could not be listed.",
      models: [],
    };
  }
}

function historyText(history: OmpHistory[]) {
  if (!history.length) return "";
  return history.map((item) => (
    item.kind === "code"
      ? `Code already run:\n${item.code}\n\nText output:\n${item.output || "(no text output)"}`
      : `The previous reply was not usable JSON:\n${item.text}\nReply again with one JSON object.`
  )).join("\n\n");
}

function outputText(output: ToolOutput[]) {
  return output
    .filter((item): item is { type: "input_text"; text: string } => item.type === "input_text")
    .map((item) => item.text)
    .join("\n")
    .slice(0, 4_000);
}

export async function completeOmp(input: {
  instructions: string;
  prompt: string;
  selector: string;
  imagePath: string;
  signal: AbortSignal;
}) {
  assertOmpSelector(input.selector);
  const binary = resolveOmpBinary();
  const directory = await mkdtemp(join(tmpdir(), "jarvis-omp-"));
  const promptPath = join(directory, "prompt.md");
  try {
    await writeFile(promptPath, input.prompt);
    const { stdout } = await runProcess(binary, [
      "--mode", "json",
      "-p",
      "--no-tools",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-rules",
      "--max-time", "180",
      "--system-prompt", input.instructions,
      "--model", input.selector,
      `@${input.imagePath}`,
      `@${promptPath}`,
    ], input.signal, 190_000);
    const text = assistantTextFromOmpEvents(stdout);
    if (!text) {
      throw new RunnerCoreError("omp returned no assistant message.", {
        code: "unexpected_model_response",
        hint: "Check that `omp login` is still valid for this model, then run it again.",
        statusCode: 502,
      });
    }
    return text;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function runOmpCodeLoop(input: {
  complete?: typeof completeOmp;
  context: RunExecutionContext;
  instructions: string;
  maxResponseTurns: number;
  selector: string;
  session: JavaScriptSession;
}) {
  assertOmpSelector(input.selector);
  const task = input.context.detail.run.prompt.trim();
  const history: OmpHistory[] = [];
  const complete = input.complete ?? completeOmp;
  let finalAssistantMessage: string | undefined;
  for (let turn = 1; turn <= input.maxResponseTurns; turn += 1) {
    if (input.context.signal.aborted) throw new Error("Run aborted.");
    const screenshot = await input.context.captureScreenshot(input.session, `omp-turn-${turn}`);
    const prior = historyText(history);
    let text: string;
    try {
      text = await complete({
        imagePath: screenshot.path,
        instructions: input.instructions,
        prompt: prior ? `Task:\n${task}\n\n${prior}` : task,
        selector: input.selector,
        signal: input.context.signal,
      });
    } catch (error) {
      if (error instanceof RunnerCoreError) throw error;
      throw new RunnerCoreError(error instanceof Error ? error.message : "omp could not complete this turn.", {
        code: "model_request_failed",
        hint: "Run `omp login` again if the account expired, and confirm the model accepts images.",
        statusCode: 502,
      });
    }
    await input.context.emitEvent({
      detail: `omp:${input.selector}`,
      level: "ok",
      message: `Model turn ${turn} completed.`,
      type: "run_progress",
    });
    let action: OmpAction;
    try {
      action = parseOmpAction(text);
    } catch (error) {
      history.push({ kind: "invalid", text: text.slice(0, 2_000) });
      await input.context.emitEvent({
        detail: error instanceof Error ? error.message : "Unreadable model reply.",
        level: "warn",
        message: "Model reply was not an action. Asking it to correct the reply.",
        type: "run_progress",
      });
      continue;
    }
    if (action.action === "final") {
      if (!history.some((item) => item.kind === "code")) {
        history.push({ kind: "invalid", text: text.slice(0, 2_000) });
        await input.context.emitEvent({
          detail: action.text,
          level: "warn",
          message: "Model answered before acting. Asking it to use the page first.",
          type: "run_progress",
        });
        continue;
      }
      finalAssistantMessage = action.text;
      break;
    }
    if (!action.code.trim()) {
      history.push({ kind: "invalid", text });
      continue;
    }
    await input.context.emitEvent({
      detail: `exec_js ${JSON.stringify({ code: action.code })}`,
      level: "pending",
      message: "Function tool call received from the model.",
      type: "function_call_requested",
    });
    const output = await input.session.execute(action.code, input.context.signal);
    await input.context.syncBrowserState(input.session);
    await input.context.captureScreenshot(input.session, `omp-code-turn-${Date.now()}`);
    await input.context.emitEvent({
      detail: "exec_js",
      level: "ok",
      message: "Function tool call completed.",
      type: "function_call_completed",
    });
    history.push({ kind: "code", code: action.code, output: outputText(output) });
  }
  if (!finalAssistantMessage) {
    throw new Error(`Model code loop exhausted the configured ${input.maxResponseTurns}-turn budget without producing a final assistant message.`);
  }
  await input.context.emitEvent({
    detail: finalAssistantMessage,
    level: "ok",
    message: "Model returned a final response.",
    type: "run_progress",
  });
  return {
    finalAssistantMessage,
    notes: [
      `Executed the scenario through omp (${input.selector}).`,
      `Model final response: ${finalAssistantMessage}`,
    ],
  };
}
