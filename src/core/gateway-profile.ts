import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { CcpError } from "./errors.js";
import type { PathContext } from "./paths.js";
import {
  readJsonFile,
  readMeta,
  readSettings,
  writeJsonFileAtomic,
  writeSettings
} from "./settings.js";
import type {
  ClaudeSettings,
  GatewayProfileConfig,
  GatewayProfileSecret,
  ProfileMeta
} from "./types.js";
import {
  getGatewayEndpoint,
  mergeGatewayCompatibility,
  normalizeChatCompletionsUrl,
  readGatewayRuntimeConfig
} from "../gateway/config.js";

export const GATEWAY_SECRET_FILE = ".ccp-gateway.json";

const MODEL_ENV_NAMES = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "CLAUDE_CODE_SUBAGENT_MODEL"
];

export function getGatewaySecretPath(profileDir: string): string {
  return path.join(profileDir, GATEWAY_SECRET_FILE);
}

export function validateGatewayProfileConfig(value: unknown): GatewayProfileConfig {
  if (!value || typeof value !== "object") {
    throw new CcpError("Gateway profile config is missing.");
  }
  const config = value as GatewayProfileConfig;
  if (config.provider !== "openai" && config.provider !== "openai-compatible") {
    throw new CcpError("Gateway provider must be openai or openai-compatible.");
  }
  if (config.protocol !== "openai_chat_completions") {
    throw new CcpError("Gateway protocol must be openai_chat_completions.");
  }
  if (!config.chatCompletionsUrl?.trim() || !config.model?.trim()) {
    throw new CcpError("Gateway Chat Completions URL and model are required.");
  }
  const compatibility = mergeGatewayCompatibility(config.provider, config.compatibility);
  if (
    !["system", "developer"].includes(compatibility.instructionRole) ||
    !["max_tokens", "max_completion_tokens"].includes(compatibility.maxTokensField) ||
    typeof compatibility.supportsStop !== "boolean" ||
    typeof compatibility.supportsSampling !== "boolean" ||
    !["supported", "unsupported"].includes(compatibility.parallelToolCalls) ||
    !["include", "omit"].includes(compatibility.streamUsage) ||
    !["reasoning_effort", "output_config", "omit"].includes(compatibility.reasoningEffort) ||
    !["response_format", "output_config", "unsupported"].includes(compatibility.structuredOutput)
  ) {
    throw new CcpError("Gateway compatibility config is invalid.");
  }
  return {
    provider: config.provider,
    protocol: "openai_chat_completions",
    chatCompletionsUrl: normalizeChatCompletionsUrl(config.chatCompletionsUrl),
    model: config.model.trim(),
    compatibility: { ...compatibility }
  };
}

export function validateGatewayProfileSecret(value: unknown): GatewayProfileSecret {
  if (!value || typeof value !== "object") {
    throw new CcpError("Gateway secret is missing.");
  }
  const secret = value as Partial<GatewayProfileSecret>;
  if (secret.version !== 1 || !secret.localToken?.trim() || !secret.apiKey?.trim()) {
    throw new CcpError("Gateway secret must contain version, localToken, and apiKey.");
  }
  return { version: 1, localToken: secret.localToken.trim(), apiKey: secret.apiKey.trim() };
}

export async function readGatewayProfileSecret(profileDir: string): Promise<GatewayProfileSecret | undefined> {
  const value = await readJsonFile<unknown>(getGatewaySecretPath(profileDir));
  return value === undefined ? undefined : validateGatewayProfileSecret(value);
}

export async function writeGatewayProfileSecret(
  profileDir: string,
  secret: GatewayProfileSecret
): Promise<void> {
  await writeJsonFileAtomic(getGatewaySecretPath(profileDir), validateGatewayProfileSecret(secret), 0o600);
}

export function buildGatewaySettings(
  current: ClaudeSettings | undefined,
  profileName: string,
  endpoint: string,
  secret: GatewayProfileSecret
): ClaudeSettings {
  const env = { ...(current?.env ?? {}) };
  for (const name of MODEL_ENV_NAMES) {
    delete env[name];
  }
  Object.assign(env, {
    ANTHROPIC_BASE_URL: `${endpoint}/p/${encodeURIComponent(profileName)}`,
    ANTHROPIC_AUTH_TOKEN: secret.localToken,
    NO_PROXY: "127.0.0.1,localhost",
    DISABLE_TELEMETRY: "1",
    DISABLE_COST_WARNINGS: "1",
    API_TIMEOUT_MS: "600000",
    CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    CLAUDE_CODE_DISABLE_THINKING: "1",
    CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1",
    MAX_THINKING_TOKENS: "0",
    ENABLE_TOOL_SEARCH: "false"
  });
  return { ...(current ?? {}), theme: current?.theme ?? "dark", env };
}

export async function readGatewayProfile(
  profileDir: string
): Promise<{ meta: ProfileMeta; config: GatewayProfileConfig; secret: GatewayProfileSecret }> {
  const [meta, secret] = await Promise.all([readMeta(profileDir), readGatewayProfileSecret(profileDir)]);
  if (meta?.type !== "gateway") {
    throw new CcpError(`Profile is not a gateway profile: ${profileDir}`);
  }
  if (!secret) {
    throw new CcpError(`Gateway secret is missing: ${getGatewaySecretPath(profileDir)}`);
  }
  return { meta, config: validateGatewayProfileConfig(meta.gateway), secret };
}

export async function repairGatewayProfileSettings(
  profileDir: string,
  profileName: string,
  context: PathContext = {}
): Promise<{ config: GatewayProfileConfig; secret: GatewayProfileSecret }> {
  const [{ config, secret }, runtimeConfig, current] = await Promise.all([
    readGatewayProfile(profileDir),
    readGatewayRuntimeConfig(context),
    readSettings(profileDir)
  ]);
  const expected = buildGatewaySettings(current, profileName, getGatewayEndpoint(runtimeConfig), secret);
  if (!jsonEqual(current, expected)) {
    await writeSettings(profileDir, expected);
  }
  return { config, secret };
}

export function tokensEqual(expected: string, actual: string): boolean {
  const expectedDigest = createHash("sha256").update(expected).digest();
  const actualDigest = createHash("sha256").update(actual).digest();
  return timingSafeEqual(expectedDigest, actualDigest);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
