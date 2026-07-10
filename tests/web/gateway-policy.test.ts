import { describe, expect, it } from "vitest";
import type { ClaudeSettings, ProfileSummary } from "../../src/core/types.js";
import {
  assertWebProfileWritable,
  listWebProfilePresets,
  publicProfileSettings
} from "../../src/web/server.js";

function gatewayProfile(): ProfileSummary {
  return {
    name: "gateway",
    dir: "C:\\profiles\\gateway",
    type: "gateway",
    baseUrl: "http://127.0.0.1:3921/p/gateway",
    model: "model",
    tokenStatus: "set",
    settingsPath: "C:\\profiles\\gateway\\settings.json",
    meta: {
      version: 1,
      type: "gateway",
      gateway: {
        provider: "openai-compatible",
        protocol: "openai_chat_completions",
        chatCompletionsUrl: "https://example.test/v1/chat/completions",
        model: "model",
        compatibility: {
          instructionRole: "system",
          maxTokensField: "max_tokens",
          supportsStop: true,
          supportsSampling: true,
          parallelToolCalls: "unsupported",
          streamUsage: "omit"
        }
      }
    }
  };
}

describe("gateway Web UI policy", () => {
  it("never exposes the local gateway token in public settings", () => {
    const settings: ClaudeSettings = {
      theme: "dark",
      env: {
        ANTHROPIC_AUTH_TOKEN: "local-token-that-must-not-leak",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:3921/p/gateway"
      }
    };

    const publicValue = publicProfileSettings(gatewayProfile(), settings);
    expect(JSON.stringify(publicValue)).not.toContain("local-token-that-must-not-leak");
    expect((publicValue?.env as Record<string, string>).ANTHROPIC_AUTH_TOKEN).toBe("[managed by built-in gateway]");
  });

  it("keeps gateway creation out of the Web UI until full secret editing exists", () => {
    const types = listWebProfilePresets().map((preset) => preset.type);
    expect(types).not.toContain("gateway");
    expect(types).not.toContain("custom-gateway");
  });

  it("rejects gateway profile updates through the generic API editor", () => {
    expect(() => assertWebProfileWritable(gatewayProfile())).toThrow("read-only in the Web UI");
  });
});
