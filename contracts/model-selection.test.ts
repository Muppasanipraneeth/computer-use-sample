import { describe, expect, it } from "vitest";

import { formatModelSelection, parseModelSelection } from "./index.js";

describe("model selection", () => {
  it("keeps an unprefixed model on OpenAI", () => {
    expect(parseModelSelection("gpt-6-astra")).toEqual({ provider: "openai", modelId: "gpt-6-astra" });
    expect(formatModelSelection("openai", "gpt-6-astra")).toBe("gpt-6-astra");
  });

  it("round-trips Claude and compatible model ids, including a colon in the id", () => {
    expect(parseModelSelection("anthropic:claude-sonnet-4-5")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
    expect(formatModelSelection("anthropic", "claude-sonnet-4-5")).toBe("anthropic:claude-sonnet-4-5");
    expect(parseModelSelection("compatible:org:model")).toEqual({ provider: "compatible", modelId: "org:model" });
  });
});
