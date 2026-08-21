import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayProfile } from "../../src/core/profiles.js";
import {
  getGatewayModelCachePath,
  getGatewaySecretPath,
  readGatewayProfileSecret,
  repairGatewayProfileSettings,
  updateGatewayProfile,
  validateGatewayProfileConfig
} from "../../src/core/gateway-profile.js";
import {
  createGatewayUpstream,
  fetchGatewayModels,
  getGatewayUpstreamPath,
  getGatewayUpstreamSecretPath,
  listGatewayUpstreams,
  readGatewayUpstream,
  removeGatewayUpstream,
  updateGatewayUpstream,
  validateGatewayUpstreamConfig
} from "../../src/core/gateway-upstreams.js";
import { getSettingsPath, readMeta, readSettings, writeSettings } from "../../src/core/settings.js";
import { authorizeLocalGatewayRequest, readLocalGatewayToken } from "../../src/gateway/auth.js";
import {
  buildGatewayLiveModelAliases,
  gatewayDefaultModelAlias,
  gatewayLiveModelAlias,
  gatewayModelOptionAlias
} from "../../src/gateway/models.js";
import { GatewayRegistry } from "../../src/gateway/registry.js";
import {
  normalizeChatCompletionsUrl,
  normalizeGatewayEndpoint,
  OPENAI_CHAT_COMPLETIONS_URL,
  OPENAI_GATEWAY_COMPATIBILITY,
  OPENAI_RESPONSES_COMPATIBILITY,
  OPENAI_RESPONSES_URL,
  resolveGatewayBaseUrl,
  resolveGatewayChatCompletionsUrl
} from "../../src/gateway/config.js";

const homes: string[] = [];

afterEach(async () => {
  await Promise.allSettled(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function createContext() {
  const homeDir = await mkdtemp(path.join(tmpdir(), "ccp-gateway-storage-"));
  homes.push(homeDir);
  return { homeDir };
}

async function createCompatibleUpstream(
  context: { homeDir: string },
  input: { id: string; url?: string; key?: string; models?: string[] }
) {
  return createGatewayUpstream({
    id: input.id,
    provider: "openai-compatible",
    chatCompletionsUrl: input.url ?? "https://example.test/v1/chat/completions",
    apiKey: input.key ?? "provider-key",
    models: input.models ?? ["model"]
  }, context);
}

describe("gateway upstream and profile storage", () => {
  it("discovers OpenAI and Gemini-style model catalogs from a gateway base URL", async () => {
    const requests: Array<{ url: string; authorization: string; userAgent: string }> = [];
    const fetchMock: typeof globalThis.fetch = async (url, init): Promise<Response> => {
      requests.push({
        url: String(url),
        authorization: String((init?.headers as Record<string, string>).authorization),
        userAgent: String((init?.headers as Record<string, string>)["user-agent"])
      });
      const payload = String(url).includes("gemini")
        ? { models: [{ name: "models/gemini-3.6-flash" }, { name: "models/gemini-3.5-flash" }] }
        : { data: [{ id: "gpt-5.6" }, { id: "gpt-5.5" }, { id: "gpt-5.6" }] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    };

    const openai = await fetchGatewayModels({
      provider: "openai-compatible",
      protocol: "openai_responses",
      baseUrl: "https://gateway.example/v1",
      apiKey: "secret",
      requestHeaders: { "user-agent": "codex_cli_rs/0.148.0" }
    }, { fetch: fetchMock });
    const gemini = await fetchGatewayModels({
      provider: "openai-compatible",
      protocol: "openai_chat_completions",
      baseUrl: "https://api.aicodemirror.com/api/gemini/v1",
      apiKey: "secret",
      requestHeaders: { "User-Agent": "claude-cli/2.1.230" }
    }, { fetch: fetchMock });

    expect(openai).toEqual({ models: ["gpt-5.6", "gpt-5.5"], modelsUrl: "https://gateway.example/v1/models" });
    expect(gemini).toEqual({
      models: ["gemini-3.6-flash", "gemini-3.5-flash"],
      modelsUrl: "https://api.aicodemirror.com/api/gemini/v1/models"
    });
    expect(requests).toEqual([
      { url: "https://gateway.example/v1/models", authorization: "Bearer secret", userAgent: "codex_cli_rs/0.148.0" },
      { url: "https://api.aicodemirror.com/api/gemini/v1/models", authorization: "Bearer secret", userAgent: "claude-cli/2.1.230" }
    ]);
  });

  it("normalizes custom request headers and protects gateway-managed headers", () => {
    const config = validateGatewayUpstreamConfig({
      version: 2,
      id: "custom-headers",
      provider: "openai-compatible",
      protocol: "openai_responses",
      endpointUrl: "https://example.test/v1/responses",
      models: ["model"],
      requestHeaders: { "User-Agent": "claude-cli/2.1.230", "X-Provider-Client": "multi-ccp" }
    });
    expect(config.requestHeaders).toEqual({
      "user-agent": "claude-cli/2.1.230",
      "x-provider-client": "multi-ccp"
    });
    expect(() => validateGatewayUpstreamConfig({
      version: 2,
      id: "managed-header",
      provider: "openai-compatible",
      protocol: "openai_responses",
      endpointUrl: "https://example.test/v1/responses",
      models: ["model"],
      requestHeaders: { Authorization: "Basic unsafe" }
    })).toThrow("managed by the gateway");
  });

  it("rejects unsafe, invalid, and empty model discovery responses", async () => {
    const fetchMock = async () => new Response("{}", { status: 200 });
    await expect(fetchGatewayModels({
      provider: "openai-compatible",
      protocol: "openai_responses",
      baseUrl: "https://gateway.example/v1?api_key=secret",
      apiKey: "secret"
    }, { fetch: fetchMock })).rejects.toThrow("may contain credentials");
    await expect(fetchGatewayModels({
      provider: "openai-compatible",
      protocol: "openai_responses",
      endpointUrl: "https://gateway.example/v1/chat/completions",
      apiKey: "secret"
    }, { fetch: fetchMock })).rejects.toThrow("must end with '/responses'");
    await expect(fetchGatewayModels({
      provider: "openai-compatible",
      protocol: "openai_responses",
      baseUrl: "https://gateway.example/v1",
      apiKey: "secret"
    }, { fetch: fetchMock })).rejects.toThrow("no usable models");
  });

  it("keeps safe query parameters, rejects credentials, and defaults the OpenAI endpoint", () => {
    expect(normalizeChatCompletionsUrl("https://example.test/openai?api-version=2026-01-01"))
      .toBe("https://example.test/openai/chat/completions?api-version=2026-01-01");
    expect(() => normalizeChatCompletionsUrl("https://example.test/v1?api_key=secret"))
      .toThrow("may contain credentials");
    expect(resolveGatewayChatCompletionsUrl("openai", "")).toBe(OPENAI_CHAT_COMPLETIONS_URL);
    expect(resolveGatewayChatCompletionsUrl("openai", "https://proxy.test/v1"))
      .toBe("https://proxy.test/v1/chat/completions");
  });

  it("completes flexible gateway base URLs without duplicating v1", () => {
    expect(resolveGatewayBaseUrl("openai_responses", "openai-compatible", "https://suoxie.codes/"))
      .toBe("https://suoxie.codes/v1/responses");
    expect(resolveGatewayBaseUrl("openai_responses", "openai-compatible", "https://suoxie.codes/v1"))
      .toBe("https://suoxie.codes/v1/responses");
    expect(resolveGatewayBaseUrl("openai_chat_completions", "openai-compatible", "https://example.test/custom"))
      .toBe("https://example.test/custom/v1/chat/completions");
    expect(resolveGatewayBaseUrl("openai_responses", "openai-compatible", "https://example.test/v1/responses"))
      .toBe("https://example.test/v1/responses");
  });

  it("strictly validates protocol endpoints while preserving legacy Chat URL completion", () => {
    expect(normalizeGatewayEndpoint(
      "openai_chat_completions",
      "openai-compatible",
      "https://example.test/v1/chat/completions/#section"
    )).toBe("https://example.test/v1/chat/completions");
    expect(normalizeGatewayEndpoint(
      "openai_responses",
      "openai-compatible",
      "https://example.test/v1/responses?api-version=2026-01-01#section"
    )).toBe("https://example.test/v1/responses?api-version=2026-01-01");
    expect(() => normalizeGatewayEndpoint(
      "openai_responses",
      "openai-compatible",
      "https://example.test/v1/chat/completions"
    )).toThrow("must end with '/responses'");
    expect(() => normalizeGatewayEndpoint(
      "openai_chat_completions",
      "openai-compatible",
      "https://user:pass@example.test/v1/chat/completions"
    )).toThrow("username or password");
    expect(() => normalizeGatewayEndpoint(
      "openai_responses",
      "openai-compatible",
      "https://example.test/v1/responses?access_token=secret"
    )).toThrow("may contain credentials");
    expect(normalizeGatewayEndpoint("openai_responses", "openai", "")).toBe(OPENAI_RESPONSES_URL);
    expect(normalizeGatewayEndpoint(
      "openai_responses",
      "openai",
      "https://proxy.test/v1/responses"
    )).toBe("https://proxy.test/v1/responses");
  });

  it("reads legacy v1 Chat configs as v2 without rewriting the file", async () => {
    const context = await createContext();
    const configPath = getGatewayUpstreamPath("legacy", context);
    await mkdir(path.dirname(configPath), { recursive: true });
    await mkdir(path.dirname(getGatewayUpstreamSecretPath("legacy", context)), { recursive: true });
    const original = `${JSON.stringify({
      version: 1,
      id: "legacy",
      provider: "openai-compatible",
      protocol: "openai_chat_completions",
      chatCompletionsUrl: "https://legacy.test/v1",
      models: ["legacy-model"],
      compatibility: {
        instructionRole: "system",
        maxTokensField: "max_tokens",
        supportsStop: true,
        supportsSampling: true,
        parallelToolCalls: "unsupported",
        streamUsage: "omit",
        reasoningEffort: "omit",
        structuredOutput: "unsupported"
      }
    }, null, 4)}\n`;
    await writeFile(configPath, original, "utf8");
    await writeFile(getGatewayUpstreamSecretPath("legacy", context), JSON.stringify({
      version: 1,
      apiKey: "legacy-key"
    }), "utf8");

    const upstream = await readGatewayUpstream("legacy", context);

    expect(upstream.config).toMatchObject({
      version: 2,
      protocol: "openai_chat_completions",
      endpointUrl: "https://legacy.test/v1/chat/completions",
      compatibility: { protocol: "openai_chat_completions", instructionRole: "system" }
    });
    expect(await readFile(configPath, "utf8")).toBe(original);
  });

  it("persists new Chat and Responses upstreams as version 2", async () => {
    const context = await createContext();
    await createGatewayUpstream({
      id: "chat-v2",
      provider: "openai-compatible",
      endpointUrl: "https://chat.test/v1/chat/completions",
      apiKey: "chat-key",
      models: ["chat-model"]
    }, context);
    const responses = await createGatewayUpstream({
      id: "responses-v2",
      provider: "openai-compatible",
      protocol: "openai_responses",
      endpointUrl: "https://responses.test/v1/responses",
      apiKey: "responses-key",
      models: ["responses-model"]
    }, context);

    const chatFile = JSON.parse(await readFile(getGatewayUpstreamPath("chat-v2", context), "utf8"));
    const responsesFile = JSON.parse(await readFile(getGatewayUpstreamPath("responses-v2", context), "utf8"));
    expect(chatFile).toMatchObject({
      version: 2,
      protocol: "openai_chat_completions",
      endpointUrl: "https://chat.test/v1/chat/completions",
      compatibility: { protocol: "openai_chat_completions" }
    });
    expect(chatFile.chatCompletionsUrl).toBeUndefined();
    expect(responses).toMatchObject({
      version: 2,
      protocol: "openai_responses",
      endpointUrl: "https://responses.test/v1/responses",
      compatibility: { ...OPENAI_RESPONSES_COMPATIBILITY, supportsSampling: true }
    });
    expect(responsesFile).toMatchObject({
      version: 2,
      protocol: "openai_responses",
      endpointUrl: "https://responses.test/v1/responses",
      compatibility: { ...OPENAI_RESPONSES_COMPATIBILITY, supportsSampling: true }
    });
  });

  it("keeps the Chat URL alias only on Chat summaries", async () => {
    const context = await createContext();
    const chat = await createGatewayUpstream({
      id: "chat-summary",
      provider: "openai-compatible",
      protocol: "openai_chat_completions",
      endpointUrl: "https://chat-summary.test/v1/chat/completions",
      apiKey: "chat-key",
      models: ["chat-model"]
    }, context);
    const responses = await createGatewayUpstream({
      id: "responses-summary",
      provider: "openai-compatible",
      protocol: "openai_responses",
      endpointUrl: "https://responses-summary.test/v1/responses",
      apiKey: "responses-key",
      models: ["responses-model"]
    }, context);

    expect(chat).toMatchObject({
      protocol: "openai_chat_completions",
      endpointUrl: "https://chat-summary.test/v1/chat/completions",
      chatCompletionsUrl: "https://chat-summary.test/v1/chat/completions"
    });
    expect(responses).toMatchObject({
      protocol: "openai_responses",
      endpointUrl: "https://responses-summary.test/v1/responses"
    });
    expect(responses.chatCompletionsUrl).toBeUndefined();
  });

  it("upgrades a legacy v1 upstream to v2 when it is edited", async () => {
    const context = await createContext();
    const configPath = getGatewayUpstreamPath("legacy-edit", context);
    await mkdir(path.dirname(configPath), { recursive: true });
    await mkdir(path.dirname(getGatewayUpstreamSecretPath("legacy-edit", context)), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      version: 1,
      id: "legacy-edit",
      provider: "openai-compatible",
      protocol: "openai_chat_completions",
      chatCompletionsUrl: "https://legacy.test/v1/chat/completions",
      models: ["model"],
      compatibility: {}
    }), "utf8");
    await writeFile(getGatewayUpstreamSecretPath("legacy-edit", context), JSON.stringify({
      version: 1,
      apiKey: "legacy-key"
    }), "utf8");

    await updateGatewayUpstream("legacy-edit", {
      provider: "openai-compatible",
      endpointUrl: "https://updated.test/v1/chat/completions",
      models: ["model"],
      compatibility: {}
    }, context);

    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      version: 2,
      protocol: "openai_chat_completions",
      endpointUrl: "https://updated.test/v1/chat/completions"
    });
  });

  it("rejects unknown versions, protocols, and mismatched compatibility", () => {
    expect(() => validateGatewayUpstreamConfig({
      version: 3,
      id: "future",
      provider: "openai-compatible",
      protocol: "openai_responses",
      endpointUrl: "https://example.test/v1/responses",
      models: ["model"]
    })).toThrow("version must be 1 or 2");
    expect(() => validateGatewayUpstreamConfig({
      version: 2,
      id: "unknown-protocol",
      provider: "openai-compatible",
      protocol: "unknown",
      endpointUrl: "https://example.test/v1/responses",
      models: ["model"]
    })).toThrow("protocol is invalid");
    expect(() => validateGatewayProfileConfig({
      provider: "openai-compatible",
      protocol: "openai_responses",
      endpointUrl: "https://example.test/v1/responses",
      model: "model",
      compatibility: { protocol: "openai_chat_completions" }
    })).toThrow("must match the upstream protocol");
    expect(() => validateGatewayProfileConfig({
      provider: "openai-compatible",
      protocol: "openai_responses",
      endpointUrl: "https://example.test/v1/responses",
      model: "model",
      compatibility: { instructionRole: "system" }
    })).toThrow("Chat-only fields");
    expect(() => validateGatewayProfileConfig({
      provider: "openai-compatible",
      protocol: "openai_chat_completions",
      endpointUrl: "https://example.test/v1/chat/completions",
      model: "model",
      compatibility: { store: false }
    })).toThrow("Responses-only fields");
    expect(() => validateGatewayProfileConfig({
      provider: "openai-compatible",
      protocol: "unknown",
      endpointUrl: "https://example.test/v1/responses",
      model: "model"
    })).toThrow("protocol is invalid");
  });

  it("rejects upstream models that collide with the internal gateway alias namespace", () => {
    expect(() => validateGatewayUpstreamConfig({
      version: 2,
      id: "reserved-anthropic-model",
      provider: "openai-compatible",
      protocol: "openai_chat_completions",
      endpointUrl: "https://example.test/v1/chat/completions",
      models: ["anthropic.ccp-default-test"],
      compatibility: {}
    })).toThrow("reserved 'anthropic.ccp-' prefix");
  });

  it("keeps live aliases distinct from stable gateway aliases", () => {
    const models = ["foo", "ccp-option-Zm9v"];
    const liveAliases = [...buildGatewayLiveModelAliases(models).values()];
    const allAliases = [
      ...liveAliases,
      ...models.map(gatewayModelOptionAlias),
      ...models.map(gatewayDefaultModelAlias)
    ];
    expect(new Set(allAliases).size).toBe(allAliases.length);
  });

  it("locks official OpenAI compatibility while preserving compatible-provider overrides", () => {
    const override = {
      instructionRole: "system" as const,
      maxTokensField: "max_tokens" as const,
      supportsStop: true,
      supportsSampling: true,
      parallelToolCalls: "unsupported" as const,
      streamUsage: "omit" as const,
      reasoningEffort: "output_config" as const,
      structuredOutput: "output_config" as const
    };
    const official = validateGatewayProfileConfig({
      provider: "openai",
      protocol: "openai_chat_completions",
      chatCompletionsUrl: "",
      model: "gpt-test",
      compatibility: override
    });
    const compatible = validateGatewayProfileConfig({
      provider: "openai-compatible",
      protocol: "openai_chat_completions",
      chatCompletionsUrl: "https://example.test/v1",
      model: "model",
      compatibility: override
    });

    expect(official.compatibility).toEqual({
      protocol: "openai_chat_completions",
      ...OPENAI_GATEWAY_COMPATIBILITY
    });
    expect(compatible.compatibility).toEqual({
      protocol: "openai_chat_completions",
      ...override
    });
  });

  it("stores upstream connection data separately from profile bindings and local tokens", async () => {
    const context = await createContext();
    await createGatewayUpstream({
      id: "openai",
      provider: "openai",
      chatCompletionsUrl: "",
      apiKey: "sk-upstream-only",
      models: ["gpt-test"]
    }, context);
    const profile = await createGatewayProfile({
      name: "openai-main",
      upstreamId: "openai",
      model: "gpt-test",
      preset: "gateway"
    }, context);
    const [meta, profileSecret, upstream, settings, modelCache] = await Promise.all([
      readMeta(profile.dir),
      readGatewayProfileSecret(profile.dir),
      readGatewayUpstream("openai", context),
      readSettings(profile.dir),
      readFile(getGatewayModelCachePath(profile.dir), "utf8").then(JSON.parse)
    ]);

    expect(meta).toMatchObject({
      type: "gateway",
      preset: "gateway",
      gateway: { upstreamId: "openai", model: "gpt-test" }
    });
    expect(JSON.stringify(meta)).not.toContain("sk-upstream-only");
    expect(JSON.stringify(profileSecret)).not.toContain("sk-upstream-only");
    expect(profileSecret?.localToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(upstream.config.endpointUrl).toBe(OPENAI_CHAT_COMPLETIONS_URL);
    expect(upstream.secret.apiKey).toBe("sk-upstream-only");
    expect(settings?.env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:3921/p/openai-main",
      ANTHROPIC_AUTH_TOKEN: profileSecret?.localToken,
      ANTHROPIC_DEFAULT_OPUS_MODEL: gatewayDefaultModelAlias("gpt-test"),
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
      CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1"
    });
    expect(settings?.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
    expect(settings?.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
    expect(settings?.env?.DISABLE_AUTO_COMPACT).toBeUndefined();
    expect(settings?.env?.DISABLE_COMPACT).toBeUndefined();
    expect(settings?.autoCompactWindow).toBeUndefined();
    expect(settings?.model).toBe("default");
    expect(settings?.availableModels).toEqual([gatewayModelOptionAlias("gpt-test")]);
    expect(settings?.modelOverrides).toEqual({
      "claude-opus-5": gatewayDefaultModelAlias("gpt-test"),
      "claude-opus-4-8": gatewayDefaultModelAlias("gpt-test")
    });
    expect(modelCache).toMatchObject({
      baseUrl: "http://127.0.0.1:3921/p/openai-main",
      models: [
        { id: gatewayDefaultModelAlias("gpt-test"), display_name: "gpt-test (openai)" },
        { id: gatewayModelOptionAlias("gpt-test"), display_name: "gpt-test (openai)" }
      ]
    });
    expect(modelCache.fetchedAt).toEqual(expect.any(Number));
    expect(settings?.env?.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME).toBeUndefined();
    expect(settings?.env?.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION).toBeUndefined();
    expect(JSON.stringify(settings)).not.toContain("sk-upstream-only");
    if (process.platform !== "win32") {
      expect((await stat(getGatewaySecretPath(profile.dir))).mode & 0o777).toBe(0o600);
      expect((await stat(getGatewayUpstreamSecretPath("openai", context))).mode & 0o777).toBe(0o600);
    }
  });

  it("renames an upstream and updates existing profile bindings", async () => {
    const context = await createContext();
    await createCompatibleUpstream(context, { id: "old-provider", models: ["model"] });
    const profile = await createGatewayProfile({
      name: "bound-profile",
      upstreamId: "old-provider",
      model: "model"
    }, context);

    const renamed = await updateGatewayUpstream("old-provider", {
      id: "new-provider",
      provider: "openai-compatible",
      protocol: "openai_chat_completions",
      endpointUrl: "https://example.test/v1/chat/completions",
      models: ["model"],
      compatibility: OPENAI_GATEWAY_COMPATIBILITY
    }, context);

    expect(renamed.id).toBe("new-provider");
    expect((await readMeta(profile.dir))?.gateway?.upstreamId).toBe("new-provider");
    await expect(readGatewayUpstream("old-provider", context)).rejects.toThrow("does not exist");
    expect((await readGatewayUpstream("new-provider", context)).secret.apiKey).toBe("provider-key");
  });

  it("preserves upstream ID casing while rejecting case-only duplicates on every filesystem", async () => {
    const context = await createContext();
    await createCompatibleUpstream(context, { id: "TeamGPT" });

    expect((await listGatewayUpstreams(context)).map((upstream) => upstream.id)).toEqual(["TeamGPT"]);
    await expect(createCompatibleUpstream(context, { id: "teamgpt" }))
      .rejects.toThrow("preserve letter case but must be unique ignoring letter case");
  });

  it("normalizes conservative compatibility fields for compatible providers", () => {
    const config = validateGatewayProfileConfig({
      provider: "openai-compatible",
      protocol: "openai_chat_completions",
      chatCompletionsUrl: "https://example.test/v1/chat/completions",
      model: "legacy-model",
      compatibility: {
        instructionRole: "system",
        maxTokensField: "max_tokens",
        supportsStop: true,
        supportsSampling: true,
        parallelToolCalls: "unsupported",
        streamUsage: "omit"
      }
    });

    expect(config.compatibility.reasoningEffort).toBe("omit");
    expect(config.compatibility.structuredOutput).toBe("unsupported");
  });

  it("repairs derived settings without overwriting unrelated profile settings", async () => {
    const context = await createContext();
    await createCompatibleUpstream(context, { id: "repair-upstream" });
    const profile = await createGatewayProfile({
      name: "repair",
      upstreamId: "repair-upstream",
      model: "model"
    }, context);
    const secret = await readGatewayProfileSecret(profile.dir);
    await writeSettings(profile.dir, {
      theme: "light",
      permissions: { allow: ["Read"] },
      autoCompactWindow: 300000,
      env: {
        ANTHROPIC_BASE_URL: "http://wrong.invalid",
        ANTHROPIC_AUTH_TOKEN: "wrong-token",
        ANTHROPIC_MODEL: "wrong-model",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "old-default",
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "Old default",
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: "300000",
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000",
        DISABLE_AUTO_COMPACT: "1",
        DISABLE_COMPACT: "1",
        CUSTOM_ENV: "keep"
      },
      modelOverrides: {
        "claude-sonnet-5": "keep-override",
        invalid: null
      }
    });

    await repairGatewayProfileSettings(profile.dir, profile.name, context);
    const repaired = await readSettings(profile.dir);

    expect(repaired?.theme).toBe("light");
    expect(repaired?.permissions).toEqual({ allow: ["Read"] });
    expect(repaired?.env?.CUSTOM_ENV).toBe("keep");
    expect(repaired?.env?.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:3921/p/repair");
    expect(repaired?.env?.ANTHROPIC_AUTH_TOKEN).toBe(secret?.localToken);
    expect(repaired?.env?.ANTHROPIC_MODEL).toBeUndefined();
    expect(repaired?.env?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(gatewayDefaultModelAlias("model"));
    expect(repaired?.env?.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME).toBeUndefined();
    expect(repaired?.env?.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT).toBe("1");
    expect(repaired?.env?.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBe("1");
    expect(repaired?.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
    expect(repaired?.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
    expect(repaired?.env?.DISABLE_AUTO_COMPACT).toBeUndefined();
    expect(repaired?.env?.DISABLE_COMPACT).toBeUndefined();
    expect(repaired?.autoCompactWindow).toBeUndefined();
    expect(repaired?.model).toBe("default");
    expect(repaired?.availableModels).toEqual([gatewayModelOptionAlias("model")]);
    expect(repaired?.modelOverrides).toEqual({
      "claude-sonnet-5": "keep-override",
      "claude-opus-5": gatewayDefaultModelAlias("model"),
      "claude-opus-4-8": gatewayDefaultModelAlias("model")
    });
  });

  it("preserves a canonical Claude Code /model selection when repairing gateway settings", async () => {
    const context = await createContext();
    await createCompatibleUpstream(context, { id: "saved-selection", models: ["first", "second"] });
    const profile = await createGatewayProfile({
      name: "saved-model",
      upstreamId: "saved-selection",
      model: "first"
    }, context);
    const current = await readSettings(profile.dir);
    await writeSettings(profile.dir, { ...current, model: gatewayModelOptionAlias("second") });

    await repairGatewayProfileSettings(profile.dir, profile.name, context);

    expect((await readSettings(profile.dir))?.model).toBe(gatewayModelOptionAlias("second"));
    expect((await readSettings(profile.dir))?.availableModels).toEqual([
      gatewayModelOptionAlias("first"),
      gatewayModelOptionAlias("second")
    ]);
    expect((await readMeta(profile.dir))?.gateway).toEqual({ upstreamId: "saved-selection", model: "first" });
  });

  it("normalizes a canonical binding-default alias to the single Default picker row", async () => {
    const context = await createContext();
    await createCompatibleUpstream(context, { id: "saved-default", models: ["first", "second"] });
    const profile = await createGatewayProfile({
      name: "saved-default-model",
      upstreamId: "saved-default",
      model: "first"
    }, context);
    const current = await readSettings(profile.dir);
    await writeSettings(profile.dir, { ...current, model: gatewayDefaultModelAlias("first") });

    await repairGatewayProfileSettings(profile.dir, profile.name, context);
    const repaired = await readSettings(profile.dir);

    expect(repaired?.model).toBe("default");
    expect(repaired?.availableModels).toEqual([
      gatewayModelOptionAlias("first"),
      gatewayModelOptionAlias("second")
    ]);
  });

  it("switches profile bindings while preserving the local token", async () => {
    const context = await createContext();
    await createCompatibleUpstream(context, { id: "first", key: "first-key", models: ["old-model"] });
    await createCompatibleUpstream(context, { id: "second", key: "second-key", models: ["new-model"] });
    const profile = await createGatewayProfile({
      name: "editable",
      upstreamId: "first",
      model: "old-model"
    }, context);
    const original = await readGatewayProfileSecret(profile.dir);

    await updateGatewayProfile(profile.dir, profile.name, {
      upstreamId: "second",
      model: "new-model"
    }, context);

    const [meta, preserved, settings, snapshot, modelCache] = await Promise.all([
      readMeta(profile.dir),
      readGatewayProfileSecret(profile.dir),
      readSettings(profile.dir),
      new GatewayRegistry(context).resolve("editable"),
      readFile(getGatewayModelCachePath(profile.dir), "utf8").then(JSON.parse)
    ]);
    expect(meta?.gateway).toEqual({ upstreamId: "second", model: "new-model" });
    expect(preserved?.localToken).toBe(original?.localToken);
    expect(snapshot.secret.apiKey).toBe("second-key");
    expect(snapshot.config.model).toBe("new-model");
    expect(settings?.model).toBe("default");
    expect(settings?.availableModels).toEqual([gatewayLiveModelAlias("new-model", ["new-model"])]);
    expect(settings?.env?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("new-model");
    expect(settings?.env?.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME).toBeUndefined();
    expect(settings?.modelOverrides?.["claude-opus-5"]).toBeUndefined();
    expect(settings?.modelOverrides?.["claude-opus-4-8"]).toBeUndefined();
    expect(modelCache).toMatchObject({
      baseUrl: "http://127.0.0.1:3921/p/editable",
      models: [
        { id: gatewayDefaultModelAlias("new-model"), display_name: "new-model (second)" },
        { id: gatewayModelOptionAlias("new-model"), display_name: "new-model (second)" }
      ]
    });
  });

  it("keeps a valid explicit /model selection when changing the binding default", async () => {
    const context = await createContext();
    await createCompatibleUpstream(context, { id: "defaults", models: ["first", "second"] });
    const profile = await createGatewayProfile({
      name: "explicit-selection",
      upstreamId: "defaults",
      model: "first"
    }, context);
    const current = await readSettings(profile.dir);
    await writeSettings(profile.dir, { ...current, model: gatewayModelOptionAlias("first") });

    await updateGatewayProfile(profile.dir, profile.name, {
      upstreamId: "defaults",
      model: "second"
    }, context);

    const [settings, modelCache] = await Promise.all([
      readSettings(profile.dir),
      readFile(getGatewayModelCachePath(profile.dir), "utf8").then(JSON.parse)
    ]);
    expect(settings?.model).toBe(gatewayModelOptionAlias("first"));
    expect(settings?.availableModels).toEqual([
      gatewayModelOptionAlias("first"),
      gatewayModelOptionAlias("second")
    ]);
    expect(settings?.modelOverrides).toMatchObject({
      "claude-opus-5": gatewayDefaultModelAlias("second"),
      "claude-opus-4-8": gatewayDefaultModelAlias("second")
    });
    expect(modelCache.models).toEqual([
      { id: gatewayDefaultModelAlias("second"), display_name: "second (defaults)" },
      { id: gatewayDefaultModelAlias("first"), display_name: "first (defaults)" },
      { id: gatewayModelOptionAlias("first"), display_name: "first (defaults)" },
      { id: gatewayModelOptionAlias("second"), display_name: "second (defaults)" }
    ]);
    expect((await readMeta(profile.dir))?.gateway).toEqual({ upstreamId: "defaults", model: "second" });
  });

  it("hot-adds a new upstream model to /model and uses its readable id for Default", async () => {
    const context = await createContext();
    await createCompatibleUpstream(context, { id: "hot-models", models: ["first", "second"] });
    const profile = await createGatewayProfile({
      name: "hot-model-profile",
      upstreamId: "hot-models",
      model: "first"
    }, context);
    const currentUpstream = await readGatewayUpstream("hot-models", context);
    await updateGatewayUpstream("hot-models", {
      ...currentUpstream.config,
      models: ["first", "second", "third"]
    }, context);

    await updateGatewayProfile(profile.dir, profile.name, {
      upstreamId: "hot-models",
      model: "third"
    }, context);
    const hotSettings = await readSettings(profile.dir);

    expect(hotSettings?.model).toBe("default");
    expect(hotSettings?.availableModels).toEqual([
      gatewayModelOptionAlias("first"),
      gatewayModelOptionAlias("second"),
      gatewayLiveModelAlias("third", ["first", "second", "third"])
    ]);
    expect(hotSettings?.env?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("third");
    expect(hotSettings?.env?.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME).toBeUndefined();
    expect(hotSettings?.modelOverrides?.["claude-opus-5"]).toBeUndefined();
    expect(hotSettings?.modelOverrides?.["claude-opus-4-8"]).toBeUndefined();

    const liveThird = gatewayLiveModelAlias("third", ["first", "second", "third"]);
    await writeSettings(profile.dir, { ...hotSettings, model: liveThird });
    await repairGatewayProfileSettings(profile.dir, profile.name, context);
    const repaired = await readSettings(profile.dir);
    expect(repaired?.model).toBe(gatewayModelOptionAlias("third"));
    expect(repaired?.availableModels).toEqual([
      gatewayModelOptionAlias("first"),
      gatewayModelOptionAlias("second"),
      gatewayModelOptionAlias("third")
    ]);
    expect(repaired?.modelOverrides).toMatchObject({
      "claude-opus-5": gatewayDefaultModelAlias("third"),
      "claude-opus-4-8": gatewayDefaultModelAlias("third")
    });
    expect(repaired?.env?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(gatewayDefaultModelAlias("third"));
    expect(repaired?.env?.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME).toBeUndefined();
  });

  it("treats a canonical binding-default alias as Default when changing the binding before startup repair", async () => {
    const context = await createContext();
    await createCompatibleUpstream(context, { id: "canonical-default", models: ["first", "second"] });
    const profile = await createGatewayProfile({
      name: "canonical-default-selection",
      upstreamId: "canonical-default",
      model: "first"
    }, context);
    const current = await readSettings(profile.dir);
    await writeSettings(profile.dir, { ...current, model: gatewayDefaultModelAlias("first") });

    await updateGatewayProfile(profile.dir, profile.name, {
      upstreamId: "canonical-default",
      model: "second"
    }, context);

    expect((await readSettings(profile.dir))?.model).toBe("default");
    expect((await readMeta(profile.dir))?.gateway).toEqual({ upstreamId: "canonical-default", model: "second" });
  });

  it("removes newly derived settings when a binding update fails and no settings existed", async () => {
    const context = await createContext();
    await createCompatibleUpstream(context, { id: "rollback", models: ["first", "second"] });
    const profile = await createGatewayProfile({
      name: "rollback-profile",
      upstreamId: "rollback",
      model: "first"
    }, context);
    const originalMeta = await readMeta(profile.dir);
    await rm(getSettingsPath(profile.dir), { force: true });
    await rm(getGatewayModelCachePath(profile.dir), { force: true });
    await mkdir(getGatewayModelCachePath(profile.dir), { recursive: true });

    await expect(updateGatewayProfile(profile.dir, profile.name, {
      upstreamId: "rollback",
      model: "second"
    }, context)).rejects.toThrow();

    expect(await readMeta(profile.dir)).toEqual(originalMeta);
    expect(await readSettings(profile.dir)).toBeUndefined();
  });

  it("prevents deleting an upstream that is referenced by a profile", async () => {
    const context = await createContext();
    await createCompatibleUpstream(context, { id: "used" });
    await createGatewayProfile({ name: "bound", upstreamId: "used", model: "model" }, context);

    await expect(removeGatewayUpstream("used", context)).rejects.toThrow("used by profile");
  });
});

describe("gateway registry and authentication", () => {
  it("coalesces loads, freezes snapshots, and hot-reloads upstream and profile changes", async () => {
    const context = await createContext();
    await createCompatibleUpstream(context, {
      id: "reload-upstream",
      key: "first-key",
      models: ["first-model", "second-model"]
    });
    const profile = await createGatewayProfile({
      name: "reload",
      upstreamId: "reload-upstream",
      model: "first-model"
    }, context);
    const registry = new GatewayRegistry(context);
    const [first, same] = await Promise.all([registry.resolve("reload"), registry.resolve("reload")]);

    expect(first).toBe(same);
    expect(Object.isFrozen(first.config.compatibility)).toBe(true);
    expect(Object.isFrozen(first.secret)).toBe(true);

    await updateGatewayUpstream("reload-upstream", {
      provider: "openai-compatible",
      chatCompletionsUrl: "https://changed.test/v1",
      apiKey: "second-provider-key-longer",
      models: ["first-model", "second-model"],
      compatibility: { reasoningEffort: "reasoning_effort" }
    }, context);
    const upstreamReload = await registry.resolve("reload");
    expect(upstreamReload).not.toBe(first);
    expect(upstreamReload.secret.apiKey).toBe("second-provider-key-longer");
    expect(upstreamReload.config.endpointUrl).toBe("https://changed.test/v1/chat/completions");

    await updateGatewayProfile(profile.dir, profile.name, {
      upstreamId: "reload-upstream",
      model: "second-model"
    }, context);
    const profileReload = await registry.resolve("reload");
    expect(profileReload.config.model).toBe("second-model");
    await expect(registry.countProfiles()).resolves.toBe(1);
  });

  it("supports either local auth header and rejects conflicting credentials", () => {
    const expected = "local-secret";
    expect(readLocalGatewayToken({ authorization: "Bearer local-secret" })).toBe(expected);
    expect(readLocalGatewayToken({ "x-api-key": expected })).toBe(expected);
    expect(authorizeLocalGatewayRequest({ authorization: "bearer local-secret" }, expected)).toBe(true);
    expect(authorizeLocalGatewayRequest({ "x-api-key": expected }, expected)).toBe(true);
    expect(authorizeLocalGatewayRequest({
      authorization: "Bearer local-secret",
      "x-api-key": "another-secret"
    }, expected)).toBe(false);
  });

  it("fails closed when profile secret JSON is invalid", async () => {
    const context = await createContext();
    await createCompatibleUpstream(context, { id: "invalid-upstream" });
    const profile = await createGatewayProfile({
      name: "invalid",
      upstreamId: "invalid-upstream",
      model: "model"
    }, context);
    await writeFile(getGatewaySecretPath(profile.dir), "{}", "utf8");

    await expect(new GatewayRegistry(context).resolve("invalid")).rejects.toThrow("profile secret");
  });
});
