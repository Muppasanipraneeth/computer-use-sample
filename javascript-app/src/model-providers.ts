import { parseModelSelection, type ModelProvider } from "@jarvis/contracts";

import type { JavaScriptSession } from "./browser/javascript-process.js";
import { RunnerCoreError } from "./errors.js";
import { buildCodeToolDefinitions } from "./responses-loop.js";
import type { RunExecutionContext } from "./scenario-runtime.js";

const anthropicUrl = "https://api.anthropic.com/v1/messages";

type ToolOutput =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: string };

type ToolCall = { id: string; name: string; code: string };

type TurnRecord = {
  calls: ToolCall[];
  commentary: string;
  results: Array<{ callId: string; output: ToolOutput[] }>;
};

type ModelTurn =
  | { kind: "calls"; calls: ToolCall[]; commentary: string }
  | { kind: "final"; text: string; commentary: string };

type ExternalSelection = { provider: Exclude<ModelProvider, "openai">; modelId: string };

function readErrorMessage(payload: unknown) {
  if (!payload || typeof payload !== "object" || !("error" in payload)) return undefined;
  const error = payload.error;
  if (!error || typeof error !== "object" || !("message" in error) || typeof error.message !== "string") return undefined;
  const message = error.message.trim();
  return message || undefined;
}

function unexpected(message: string) {
  return new RunnerCoreError(message, { code: "unexpected_model_response", statusCode: 400 });
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal) {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw new Error("Run aborted.");
    throw new RunnerCoreError("The model API could not be reached.", {
      code: "model_request_failed",
      hint: error instanceof Error ? error.message : "Check the provider base URL and network.",
      statusCode: 502,
    });
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new RunnerCoreError(readErrorMessage(payload) ?? `Model API returned HTTP ${response.status}.`, {
      code: "model_request_failed",
      hint: "Check the API key, model id, and that the model accepts images and function tools.",
      statusCode: response.status >= 400 && response.status < 500 ? 400 : 502,
    });
  }
  if (!payload || typeof payload !== "object") {
    throw new RunnerCoreError("Model API returned an unreadable response.", {
      code: "unexpected_model_response",
      statusCode: 502,
    });
  }
  return payload as Record<string, unknown>;
}

function textBlocks(output: ToolOutput[]) {
  const blocks = output
    .filter((item): item is { type: "input_text"; text: string } => item.type === "input_text")
    .map((item) => ({ type: "text" as const, text: item.text }));
  return blocks.length ? blocks : [{ type: "text" as const, text: "Tool completed." }];
}

function imageBlocks(output: ToolOutput[]) {
  return output.flatMap((item) => {
    if (item.type !== "input_image") return [];
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(item.image_url);
    if (!match?.[1] || !match[2]) {
      throw new RunnerCoreError("Tool returned an image the model provider cannot read.", {
        code: "unexpected_tool_output",
        statusCode: 500,
      });
    }
    if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(match[1])) {
      throw new RunnerCoreError(`Unsupported screenshot type: ${match[1]}.`, {
        code: "unexpected_tool_output",
        statusCode: 500,
      });
    }
    return [{ type: "image" as const, source: { type: "base64" as const, media_type: match[1], data: match[2] } }];
  });
}

export function buildAnthropicBody(
  modelId: string,
  instructions: string,
  prompt: string,
  turns: TurnRecord[],
  tool: ReturnType<typeof buildCodeToolDefinitions>[number],
) {
  const messages: Array<Record<string, unknown>> = [{ role: "user", content: prompt }];
  for (const turn of turns) {
    const content: Array<Record<string, unknown>> = [];
    if (turn.commentary) content.push({ type: "text", text: turn.commentary });
    for (const call of turn.calls) {
      content.push({ type: "tool_use", id: call.id, name: call.name, input: { code: call.code } });
    }
    messages.push({ role: "assistant", content });
    messages.push({
      role: "user",
      content: turn.results.map((result) => ({
        type: "tool_result",
        tool_use_id: result.callId,
        content: [...textBlocks(result.output), ...imageBlocks(result.output)],
      })),
    });
  }
  return {
    max_tokens: 8192,
    model: modelId,
    system: instructions,
    tools: [{ name: tool.name, description: tool.description, input_schema: tool.parameters }],
    messages,
  };
}

export function buildCompatibleBody(
  modelId: string,
  instructions: string,
  prompt: string,
  turns: TurnRecord[],
  tool: ReturnType<typeof buildCodeToolDefinitions>[number],
) {
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: instructions },
    { role: "user", content: prompt },
  ];
  for (const turn of turns) {
    messages.push({
      role: "assistant",
      content: turn.commentary || null,
      tool_calls: turn.calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify({ code: call.code }) },
      })),
    });
    for (const result of turn.results) {
      messages.push({
        role: "tool",
        tool_call_id: result.callId,
        content: textBlocks(result.output).map((block) => block.text).join("\n"),
      });
      const images = result.output.filter((item): item is { type: "input_image"; image_url: string } => item.type === "input_image");
      if (images.length) {
        messages.push({
          role: "user",
          content: [
            { type: "text", text: "Screenshot from the last action." },
            ...images.map((item) => ({ type: "image_url", image_url: { url: item.image_url } })),
          ],
        });
      }
    }
  }
  return {
    max_tokens: 8192,
    model: modelId,
    messages,
    tools: [{
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }],
  };
}

function messageText(content: unknown) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text.trim() : ""))
    .filter(Boolean)
    .join("\n\n");
}

function codeArgument(value: unknown, toolName: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unexpected(`${toolName} arguments are missing.`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "code") || typeof record.code !== "string") {
    throw unexpected(`${toolName} requires a code string and no other arguments.`);
  }
  return record.code;
}

export function classifyAnthropicResponse(payload: Record<string, unknown>, toolName: string): ModelTurn {
  if (payload.type === "error" || payload.error) throw unexpected(readErrorMessage(payload) ?? "Claude rejected the request.");
  if (!Array.isArray(payload.content)) throw unexpected("Claude response content is missing.");
  const calls: ToolCall[] = [];
  const texts: string[] = [];
  for (const block of payload.content) {
    if (!block || typeof block !== "object") throw unexpected("Claude response content is malformed.");
    const record = block as Record<string, unknown>;
    if (record.type === "thinking") continue;
    if (record.type === "text" && typeof record.text === "string" && record.text.trim()) {
      texts.push(record.text.trim());
      continue;
    }
    if (record.type !== "tool_use") throw unexpected(`Unsupported Claude content: ${String(record.type)}.`);
    if (record.name !== toolName || typeof record.id !== "string" || !record.id.trim()) {
      throw unexpected("Claude returned an invalid tool call.");
    }
    calls.push({ id: record.id, name: toolName, code: codeArgument(record.input, toolName) });
  }
  const commentary = texts.join("\n\n");
  if (calls.length) return { kind: "calls", calls, commentary };
  if (commentary) return { kind: "final", text: commentary, commentary: "" };
  throw unexpected("Claude returned no tool call or final answer.");
}

export function classifyCompatibleResponse(payload: Record<string, unknown>, toolName: string): ModelTurn {
  if (payload.error) throw unexpected(readErrorMessage(payload) ?? "The model API rejected the request.");
  if (!Array.isArray(payload.choices) || !payload.choices[0] || typeof payload.choices[0] !== "object") {
    throw unexpected("Compatible API response choices are missing.");
  }
  const message = (payload.choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== "object") throw unexpected("Compatible API response message is missing.");
  const record = message as { content?: unknown; tool_calls?: unknown };
  const text = messageText(record.content);
  const rawCalls = record.tool_calls ?? [];
  if (!Array.isArray(rawCalls)) throw unexpected("Compatible API tool calls are malformed.");
  const calls: ToolCall[] = [];
  for (const call of rawCalls) {
    if (!call || typeof call !== "object") throw unexpected("Compatible API tool calls are malformed.");
    const item = call as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    if (item.function?.name !== toolName || typeof item.id !== "string" || !item.id.trim()) {
      throw unexpected("Compatible API returned an invalid tool call.");
    }
    let args = item.function.arguments;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        throw unexpected("Function call arguments are not valid JSON.");
      }
    }
    calls.push({ id: item.id, name: toolName, code: codeArgument(args, toolName) });
  }
  if (calls.length) return { kind: "calls", calls, commentary: text };
  if (text) return { kind: "final", text, commentary: "" };
  throw unexpected("Compatible API returned no tool call or final answer.");
}

export class ExternalCodeModel {
  readonly selection: ExternalSelection;
  private readonly key: string;
  private readonly url?: string;

  constructor(selection: ExternalSelection) {
    this.selection = selection;
    if (selection.provider === "anthropic") {
      const key = process.env.ANTHROPIC_API_KEY?.trim();
      if (!key) {
        throw new RunnerCoreError("ANTHROPIC_API_KEY is required to run Claude.", {
          code: "missing_api_key",
          hint: "Set ANTHROPIC_API_KEY in the root .env, then rerun the scenario.",
          statusCode: 400,
        });
      }
      this.key = key;
      return;
    }
    const baseUrl = process.env.JARVIS_COMPATIBLE_BASE_URL?.trim().replace(/\/$/, "");
    const key = process.env.JARVIS_COMPATIBLE_API_KEY?.trim();
    if (!baseUrl || !key) {
      throw new RunnerCoreError("JARVIS_COMPATIBLE_BASE_URL and JARVIS_COMPATIBLE_API_KEY are required for this provider.", {
        code: "missing_api_key",
        hint: "Set both variables in the root .env. The base URL should end in /v1 for OpenAI-compatible servers.",
        statusCode: 400,
      });
    }
    if (!baseUrl.startsWith("https://") && !baseUrl.startsWith("http://")) {
      throw new RunnerCoreError("JARVIS_COMPATIBLE_BASE_URL must start with http:// or https://.", {
        code: "invalid_configuration",
        statusCode: 400,
      });
    }
    this.key = key;
    this.url = baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;
  }

  async complete(input: { instructions: string; prompt: string; turns: TurnRecord[]; signal: AbortSignal }): Promise<ModelTurn> {
    const tool = buildCodeToolDefinitions()[0]!;
    if (this.selection.provider === "anthropic") {
      const payload = await postJson(
        anthropicUrl,
        { "x-api-key": this.key, "anthropic-version": "2023-06-01" },
        buildAnthropicBody(this.selection.modelId, input.instructions, input.prompt, input.turns, tool),
        input.signal,
      );
      return classifyAnthropicResponse(payload, tool.name);
    }
    const payload = await postJson(
      this.url!,
      { authorization: `Bearer ${this.key}` },
      buildCompatibleBody(this.selection.modelId, input.instructions, input.prompt, input.turns, tool),
      input.signal,
    );
    return classifyCompatibleResponse(payload, tool.name);
  }
}

export function createExternalCodeModel(model: string) {
  const selection = parseModelSelection(model);
  if (selection.provider === "openai") {
    throw new RunnerCoreError("OpenAI models use the Responses API client.", {
      code: "unsupported_provider",
      statusCode: 400,
    });
  }
  return new ExternalCodeModel({ provider: selection.provider, modelId: selection.modelId });
}

function assertActive(signal: AbortSignal) {
  if (signal.aborted) throw new Error("Run aborted.");
}

export async function runExternalCodeLoop(input: {
  context: RunExecutionContext;
  instructions: string;
  maxResponseTurns: number | null;
  model: ExternalCodeModel;
  session: JavaScriptSession;
}) {
  const prompt = input.context.detail.run.prompt.trim();
  const turns: TurnRecord[] = [];
  let finalAssistantMessage: string | undefined;
  for (let turn = 1; turn <= (input.maxResponseTurns ?? Infinity); turn += 1) {
    assertActive(input.context.signal);
    const classified = await input.model.complete({
      instructions: input.instructions,
      prompt,
      turns,
      signal: input.context.signal,
    });
    await input.context.emitEvent({
      detail: `${input.model.selection.provider}:${input.model.selection.modelId}`,
      level: "ok",
      message: `Model turn ${turn} completed.`,
      type: "run_progress",
    });
    if (classified.kind === "calls" && classified.commentary) {
      await input.context.emitEvent({
        type: "run_progress",
        level: "pending",
        message: "Model progress.",
        detail: classified.commentary,
      });
    }
    if (classified.kind === "final") {
      finalAssistantMessage = classified.text;
      break;
    }
    const results: TurnRecord["results"] = [];
    for (const call of classified.calls) {
      assertActive(input.context.signal);
      await input.context.emitEvent({
        detail: `${call.name} ${JSON.stringify({ code: call.code })}`,
        level: "pending",
        message: "Function tool call received from the model.",
        type: "function_call_requested",
      });
      const output = call.code.trim()
        ? await input.session.execute(call.code, input.context.signal)
        : [{ type: "input_text" as const, text: "No code was provided to exec_js." }];
      if (call.code.trim()) {
        await input.context.syncBrowserState(input.session);
        await input.context.captureScreenshot(input.session, `model-code-turn-${Date.now()}`);
      }
      await input.context.emitEvent({
        detail: call.name,
        level: "ok",
        message: "Function tool call completed.",
        type: "function_call_completed",
      });
      results.push({ callId: call.id, output });
    }
    turns.push({ calls: classified.calls, commentary: classified.commentary, results });
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
  const provider = input.model.selection.provider === "anthropic" ? "Claude" : "OpenAI-compatible API";
  return {
    finalAssistantMessage,
    notes: [
      `Executed the scenario through the ${provider} code loop.`,
      `Model final response: ${finalAssistantMessage}`,
    ],
  };
}
