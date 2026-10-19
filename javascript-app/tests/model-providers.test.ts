import { afterEach, describe, expect, it, vi } from "vitest";

import { RunnerCoreError } from "../src/errors.js";
import {
  ExternalCodeModel,
  classifyAnthropicResponse,
  classifyCompatibleResponse,
  runExternalCodeLoop,
} from "../src/model-providers.js";

const originalEnv = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  JARVIS_COMPATIBLE_API_KEY: process.env.JARVIS_COMPATIBLE_API_KEY,
  JARVIS_COMPATIBLE_BASE_URL: process.env.JARVIS_COMPATIBLE_BASE_URL,
};

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("external model providers", () => {
  it("requires the Claude key before a run starts", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => new ExternalCodeModel({ provider: "anthropic", modelId: "claude-sonnet-4-5" })).toThrow(RunnerCoreError);
  });

  it("executes Claude code and sends the screenshot back", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      const payload = bodies.length === 1
        ? { content: [{ type: "tool_use", id: "toolu_1", name: "exec_js", input: { code: "console.log('ok')" } }] }
        : { content: [{ type: "text", text: "Done." }] };
      return { ok: true, json: async () => payload, status: 200 };
    }));
    const session = {
      execute: vi.fn(async () => [
        { type: "input_text" as const, text: "ok" },
        { type: "input_image" as const, image_url: "data:image/png;base64,cG5n", detail: "original" },
      ]),
    };
    const events: string[] = [];
    const result = await runExternalCodeLoop({
      context: {
        captureScreenshot: vi.fn(async () => ({})),
        detail: { run: { maxResponseTurns: 4, model: "anthropic:claude-sonnet-4-5", prompt: "Finish the board." } },
        emitEvent: async (event: { type: string }) => {
          events.push(event.type);
        },
        signal: new AbortController().signal,
        syncBrowserState: vi.fn(async () => undefined),
      } as never,
      instructions: "Use exec_js.",
      maxResponseTurns: 4,
      model: new ExternalCodeModel({ provider: "anthropic", modelId: "claude-sonnet-4-5" }),
      session: session as never,
    });

    expect(result.finalAssistantMessage).toBe("Done.");
    expect(session.execute).toHaveBeenCalledWith("console.log('ok')", expect.any(AbortSignal));
    const second = bodies[1]?.messages as Array<{ content: Array<{ type: string; content?: Array<{ type: string }> }> }>;
    const toolResult = second.at(-1)?.content[0];
    expect(toolResult?.type).toBe("tool_result");
    expect(toolResult?.content?.some((block) => block.type === "image")).toBe(true);
    expect(events).toContain("function_call_requested");
  });

  it("rejects a compatible tool call that is not exec_js code", () => {
    expect(() => classifyCompatibleResponse({
      choices: [{ message: { content: "", tool_calls: [{ id: "call_1", function: { name: "exec_js", arguments: "{\"code\":1}" } }] } }],
    }, "exec_js")).toThrow(RunnerCoreError);
    expect(classifyAnthropicResponse({
      content: [{ type: "text", text: "The board matches." }],
    }, "exec_js")).toMatchObject({ kind: "final", text: "The board matches." });
  });
});
