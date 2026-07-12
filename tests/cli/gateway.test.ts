import { describe, expect, it } from "vitest";
import { createProgram } from "../../src/cli/program.js";
import { getProfilePreset, listProfilePresets } from "../../src/core/presets.js";
import { listGatewayUpstreamTemplates } from "../../src/core/gateway-upstream-templates.js";

describe("gateway CLI surface", () => {
  it("registers the gateway lifecycle command", () => {
    const gateway = createProgram().commands.find((command) => command.name() === "gateway");
    expect(gateway).toBeDefined();
    expect(gateway?.description()).toContain("OpenAI-format upstreams");
    expect(gateway?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["status", "start", "stop", "restart", "list", "add", "edit", "remove", "use"])
    );
  });

  it("publishes one provider-neutral gateway profile preset", () => {
    expect(getProfilePreset("gateway")).toMatchObject({
      type: "gateway",
      category: "gateway",
      label: "Built-in Gateway"
    });
    expect(listProfilePresets().filter((preset) => preset.category === "gateway")).toHaveLength(1);
  });

  it("publishes reusable upstream templates for the CLI and Web UI", () => {
    const templates = listGatewayUpstreamTemplates();
    expect(templates.map((template) => template.id)).toEqual([
      "openai-official",
      "xai-grok-4.5",
      "aicodemirror",
      "custom"
    ]);
    expect(templates.find((template) => template.id === "openai-official")).toMatchObject({
      provider: "openai",
      protocol: "openai_responses",
      endpointUrl: "https://api.openai.com/v1/responses",
      compatibility: { protocol: "openai_responses", supportsSampling: false },
      models: ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]
    });
    expect(templates.find((template) => template.id === "xai-grok-4.5")).toMatchObject({
      protocol: "openai_responses",
      endpointUrl: "https://api.x.ai/v1/responses",
      models: ["grok-4.5"],
      compatibility: {
        protocol: "openai_responses",
        instructions: "instructions",
        maxOutputTokens: "max_output_tokens",
        supportsStop: false,
        supportsSampling: true,
        reasoningEffort: "reasoning.effort",
        structuredOutput: "text.format",
        store: false
      }
    });
    expect(templates.find((template) => template.id === "aicodemirror")).toMatchObject({
      protocol: "openai_responses",
      endpointUrl: "https://api.aicodemirror.com/api/codex/backend-api/codex/v1/responses",
      models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5"]
    });
    expect(templates.find((template) => template.id === "custom")).toMatchObject({
      protocol: "openai_responses",
      endpointUrl: "",
      compatibilityMode: "responses"
    });
  });
});
