import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayProfile } from "../../src/core/profiles.js";
import {
  getGatewaySecretPath,
  readGatewayProfileSecret,
  repairGatewayProfileSettings,
  updateGatewayProfile,
  validateGatewayProfileConfig
} from "../../src/core/gateway-profile.js";
import {
  createGatewayUpstream,
  getGatewayUpstreamPath,
  getGatewayUpstreamSecretPath,
  listGatewayUpstreams,
  readGatewayUpstream,
  removeGatewayUpstream,
  updateGatewayUpstream,
  validateGatewayUpstreamConfig
} from "../../src/core/gateway-upstreams.js";
import { readMeta, readSettings, writeSettings } from "../../src/core/settings.js";
import { authorizeLocalGatewayRequest, readLocalGatewayToken } from "../../src/gateway/auth.js";
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
    const [meta, profileSecret, upstream, settings] = await Promise.all([
      readMeta(profile.dir),
      readGatewayProfileSecret(profile.dir),
      readGatewayUpstream("openai", context),
      readSettings(profile.dir)
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
      ANTHROPIC_AUTH_TOKEN: profileSecret?.localToken
    });
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
      env: {
        ANTHROPIC_BASE_URL: "http://wrong.invalid",
        ANTHROPIC_AUTH_TOKEN: "wrong-token",
        ANTHROPIC_MODEL: "wrong-model",
        CUSTOM_ENV: "keep"
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

    const [meta, preserved, snapshot] = await Promise.all([
      readMeta(profile.dir),
      readGatewayProfileSecret(profile.dir),
      new GatewayRegistry(context).resolve("editable")
    ]);
    expect(meta?.gateway).toEqual({ upstreamId: "second", model: "new-model" });
    expect(preserved?.localToken).toBe(original?.localToken);
    expect(snapshot.secret.apiKey).toBe("second-key");
    expect(snapshot.config.model).toBe("new-model");
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
