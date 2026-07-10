import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayProfile } from "../../src/core/profiles.js";
import {
  getGatewaySecretPath,
  readGatewayProfileSecret,
  repairGatewayProfileSettings,
  validateGatewayProfileConfig,
  writeGatewayProfileSecret
} from "../../src/core/gateway-profile.js";
import { readMeta, readSettings, writeSettings } from "../../src/core/settings.js";
import { authorizeLocalGatewayRequest, readLocalGatewayToken } from "../../src/gateway/auth.js";
import { GatewayRegistry } from "../../src/gateway/registry.js";
import { normalizeChatCompletionsUrl } from "../../src/gateway/config.js";

const homes: string[] = [];

afterEach(async () => {
  await Promise.allSettled(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function createContext() {
  const homeDir = await mkdtemp(path.join(tmpdir(), "ccp-gateway-storage-"));
  homes.push(homeDir);
  return { homeDir };
}

describe("gateway profile storage", () => {
  it("keeps safe endpoint query parameters but rejects credential-like query keys", () => {
    expect(normalizeChatCompletionsUrl("https://example.test/openai?api-version=2026-01-01"))
      .toBe("https://example.test/openai/chat/completions?api-version=2026-01-01");
    expect(() => normalizeChatCompletionsUrl("https://example.test/v1?api_key=secret"))
      .toThrow("may contain credentials");
    expect(() => normalizeChatCompletionsUrl("https://example.test/v1?access_token=secret"))
      .toThrow("may contain credentials");
  });

  it("stores routing metadata, provider secret, and derived Claude settings separately", async () => {
    const context = await createContext();
    const profile = await createGatewayProfile({
      name: "openai-main",
      provider: "openai",
      chatCompletionsUrl: "https://api.openai.com/v1",
      apiKey: "sk-upstream-only",
      model: "gpt-test",
      preset: "openai-gateway"
    }, context);
    const [meta, secret, settings] = await Promise.all([
      readMeta(profile.dir),
      readGatewayProfileSecret(profile.dir),
      readSettings(profile.dir)
    ]);

    expect(meta).toMatchObject({
      type: "gateway",
      preset: "openai-gateway",
      gateway: {
        provider: "openai",
        protocol: "openai_chat_completions",
        chatCompletionsUrl: "https://api.openai.com/v1/chat/completions",
        model: "gpt-test"
      }
    });
    expect(JSON.stringify(meta)).not.toContain("sk-upstream-only");
    expect(secret?.apiKey).toBe("sk-upstream-only");
    expect(secret?.localToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(settings?.env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:3921/p/openai-main",
      ANTHROPIC_AUTH_TOKEN: secret?.localToken,
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
      CLAUDE_CODE_DISABLE_THINKING: "1",
      CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1",
      MAX_THINKING_TOKENS: "0",
      ENABLE_TOOL_SEARCH: "false"
    });
    expect(JSON.stringify(settings)).not.toContain("sk-upstream-only");
    expect(settings?.env?.ANTHROPIC_MODEL).toBeUndefined();
    expect(settings?.env?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
    if (process.platform !== "win32") {
      expect((await stat(getGatewaySecretPath(profile.dir))).mode & 0o777).toBe(0o600);
    }
  });

  it("normalizes legacy compatibility config with conservative output mappings", () => {
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
    const profile = await createGatewayProfile({
      name: "repair",
      provider: "openai-compatible",
      chatCompletionsUrl: "https://example.test/v1/chat/completions",
      apiKey: "provider-key",
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
});

describe("gateway registry and authentication", () => {
  it("coalesces concurrent loads, deeply freezes snapshots, and reloads changed secrets", async () => {
    const context = await createContext();
    const profile = await createGatewayProfile({
      name: "reload",
      provider: "openai-compatible",
      chatCompletionsUrl: "https://example.test/chat/completions",
      apiKey: "first-key",
      model: "first-model"
    }, context);
    const registry = new GatewayRegistry(context);
    const [first, same] = await Promise.all([registry.resolve("reload"), registry.resolve("reload")]);

    expect(first).toBe(same);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.config)).toBe(true);
    expect(Object.isFrozen(first.config.compatibility)).toBe(true);
    expect(Object.isFrozen(first.secret)).toBe(true);

    await writeGatewayProfileSecret(profile.dir, {
      version: 1,
      localToken: first.secret.localToken,
      apiKey: "second-provider-key-longer"
    });
    const reloaded = await registry.resolve("reload");
    expect(reloaded).not.toBe(first);
    expect(reloaded.secret.apiKey).toBe("second-provider-key-longer");
    expect(registry.countProfiles()).resolves.toBe(1);
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
    expect(authorizeLocalGatewayRequest({ authorization: "Basic local-secret" }, expected)).toBe(false);
  });

  it("fails closed when profile metadata or secret JSON is invalid", async () => {
    const context = await createContext();
    const profile = await createGatewayProfile({
      name: "invalid",
      provider: "openai-compatible",
      chatCompletionsUrl: "https://example.test/chat/completions",
      apiKey: "key",
      model: "model"
    }, context);
    await writeFile(getGatewaySecretPath(profile.dir), "{}", "utf8");

    await expect(new GatewayRegistry(context).resolve("invalid")).rejects.toThrow("Gateway secret");
  });
});
