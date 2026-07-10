import { describe, expect, it } from "vitest";
import { createProgram } from "../../src/cli/program.js";
import { getProfilePreset, listProfilePresets } from "../../src/core/presets.js";
import { OPENAI_GATEWAY_COMPATIBILITY } from "../../src/gateway/config.js";

describe("gateway CLI surface", () => {
  it("registers the gateway lifecycle command", () => {
    const gateway = createProgram().commands.find((command) => command.name() === "gateway");
    expect(gateway).toBeDefined();
    expect(gateway?.description()).toContain("OpenAI-compatible gateway");
  });

  it("publishes OpenAI and custom OpenAI-compatible gateway presets", () => {
    expect(getProfilePreset("openai-gateway")).toMatchObject({
      type: "gateway",
      provider: "openai",
      chatCompletionsUrl: "https://api.openai.com/v1/chat/completions",
      compatibility: {
        reasoningEffort: "reasoning_effort",
        structuredOutput: "response_format"
      }
    });
    expect(getProfilePreset("openai-gateway")).toMatchObject({
      compatibility: OPENAI_GATEWAY_COMPATIBILITY
    });
    expect(getProfilePreset("custom-gateway")).toMatchObject({
      type: "custom-gateway",
      category: "gateway"
    });
    expect(listProfilePresets().filter((preset) => preset.category === "gateway")).toHaveLength(2);
  });
});
