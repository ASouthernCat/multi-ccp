import { describe, expect, it } from "vitest";
import { createProgram } from "../../src/cli/program.js";
import { getProfilePreset, listProfilePresets } from "../../src/core/presets.js";

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
      chatCompletionsUrl: "https://api.openai.com/v1/chat/completions"
    });
    expect(getProfilePreset("custom-gateway")).toMatchObject({
      type: "custom-gateway",
      category: "gateway"
    });
    expect(listProfilePresets().filter((preset) => preset.category === "gateway")).toHaveLength(2);
  });
});
