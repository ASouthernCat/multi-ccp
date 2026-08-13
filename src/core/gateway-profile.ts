import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { CcpError } from "./errors.js";
import type { PathContext } from "./paths.js";
import {
  readJsonFile,
  readMeta,
  readSettings,
  writeJsonFileAtomic,
  writeMeta,
  writeSettings
} from "./settings.js";
import {
  readGatewayUpstream,
  readGatewayUpstreamConfig,
  validateGatewayProtocolCompatibility
} from "./gateway-upstreams.js";
import type {
  ClaudeSettings,
  GatewayCompatibility,
  GatewayProfileBinding,
  GatewayProfileConfig,
  GatewayProfileSecret,
  GatewayResolvedSecret,
  GatewayResponsesCompatibility,
  ProfileMeta,
  UpdateGatewayProfileInput
} from "./types.js";
import {
  getGatewayEndpoint,
  normalizeGatewayEndpoint,
  readGatewayRuntimeConfig,
  resolveGatewayChatCompletionsUrl
} from "../gateway/config.js";
import { gatewayModelAlias } from "../gateway/models.js";

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

export function validateGatewayProfileBinding(value: unknown): GatewayProfileBinding {
  if (!value || typeof value !== "object") throw new CcpError("Gateway profile binding is missing.");
  const binding = value as Partial<GatewayProfileBinding>;
  const upstreamId = String(binding.upstreamId ?? "").trim();
  const model = String(binding.model ?? "").trim();
  if (!upstreamId || !model) {
    throw new CcpError("Gateway profile binding requires upstreamId and model.");
  }
  return { upstreamId, model };
}

export function validateGatewayProfileConfig(value: unknown): GatewayProfileConfig {
  if (!value || typeof value !== "object") throw new CcpError("Gateway route config is missing.");
  const config = value as Record<string, unknown>;
  if (config.provider !== "openai" && config.provider !== "openai-compatible") {
    throw new CcpError("Gateway provider must be openai or openai-compatible.");
  }
  if (config.protocol !== "openai_chat_completions" && config.protocol !== "openai_responses") {
    throw new CcpError("Gateway protocol is invalid.");
  }
  const model = String(config.model ?? "").trim();
  if (!model) throw new CcpError("Gateway route model is required.");
  const protocol = config.protocol;
  const endpointUrl = config.endpointUrl !== undefined
    ? normalizeGatewayEndpoint(protocol, config.provider, String(config.endpointUrl))
    : protocol === "openai_chat_completions"
      ? resolveGatewayChatCompletionsUrl(config.provider, String(config.chatCompletionsUrl ?? ""))
      : normalizeGatewayEndpoint(protocol, config.provider, "");
  if (protocol === "openai_responses") {
    return {
      provider: config.provider,
      protocol,
      endpointUrl,
      model,
      compatibility: validateGatewayProtocolCompatibility(
        protocol,
        config.provider,
        config.compatibility as Partial<GatewayResponsesCompatibility> | undefined
      )
    };
  }
  return {
    provider: config.provider,
    protocol,
    endpointUrl,
    model,
    compatibility: validateGatewayProtocolCompatibility(
      protocol,
      config.provider,
      config.compatibility as Partial<GatewayCompatibility> | undefined
    )
  };
}

export function validateGatewayProfileSecret(value: unknown): GatewayProfileSecret {
  if (!value || typeof value !== "object") throw new CcpError("Gateway profile secret is missing.");
  const secret = value as Partial<GatewayProfileSecret>;
  if (secret.version !== 1 || !secret.localToken?.trim()) {
    throw new CcpError("Gateway profile secret must contain version and localToken.");
  }
  return { version: 1, localToken: secret.localToken.trim() };
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
  secret: Pick<GatewayProfileSecret, "localToken">,
  defaultModel?: string
): ClaudeSettings {
  const env = { ...(current?.env ?? {}) };
  for (const name of MODEL_ENV_NAMES) delete env[name];
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
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    // Gateway model ids are provider-defined, so Claude Code cannot infer
    // their context window from the id alone.
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
    MAX_THINKING_TOKENS: "0",
    ENABLE_TOOL_SEARCH: "false"
  });
  return {
    ...(current ?? {}),
    ...(defaultModel === undefined ? {} : { model: gatewayModelAlias(defaultModel) }),
    theme: current?.theme ?? "dark",
    env
  };
}

export async function readGatewayProfile(
  profileDir: string,
  context: PathContext = {}
): Promise<{
  meta: ProfileMeta;
  binding: GatewayProfileBinding;
  config: GatewayProfileConfig;
  profileSecret: GatewayProfileSecret;
  secret: GatewayResolvedSecret;
}> {
  const [meta, profileSecret] = await Promise.all([
    readMeta(profileDir),
    readGatewayProfileSecret(profileDir)
  ]);
  if (meta?.type !== "gateway") throw new CcpError(`Profile is not a gateway profile: ${profileDir}`);
  if (!profileSecret) throw new CcpError(`Gateway profile secret is missing: ${getGatewaySecretPath(profileDir)}`);
  const binding = validateGatewayProfileBinding(meta.gateway);
  const upstream = await readGatewayUpstream(binding.upstreamId, context);
  if (!upstream.config.models.includes(binding.model)) {
    throw new CcpError(
      `Gateway model '${binding.model}' is not configured for upstream '${binding.upstreamId}'.`
    );
  }
  const config = validateGatewayProfileConfig({ ...upstream.config, model: binding.model });
  return {
    meta,
    binding,
    config,
    profileSecret,
    secret: { localToken: profileSecret.localToken, apiKey: upstream.secret.apiKey }
  };
}

export async function repairGatewayProfileSettings(
  profileDir: string,
  profileName: string,
  context: PathContext = {}
): Promise<{ config: GatewayProfileConfig; secret: GatewayResolvedSecret }> {
  const [{ config, secret, profileSecret }, runtimeConfig, current] = await Promise.all([
    readGatewayProfile(profileDir, context),
    readGatewayRuntimeConfig(context),
    readSettings(profileDir)
  ]);
  const savedModel = typeof current?.model === "string" ? current.model.trim() : "";
  const expected = buildGatewaySettings(
    current,
    profileName,
    getGatewayEndpoint(runtimeConfig),
    profileSecret,
    savedModel ? undefined : config.model
  );
  if (!jsonEqual(current, expected)) await writeSettings(profileDir, expected);
  return { config, secret };
}

export async function updateGatewayProfile(
  profileDir: string,
  profileName: string,
  input: UpdateGatewayProfileInput,
  context: PathContext = {}
): Promise<{ binding: GatewayProfileBinding; config: GatewayProfileConfig; secret: GatewayResolvedSecret }> {
  const [meta, profileSecret, upstream, runtimeConfig, currentSettings] = await Promise.all([
    readMeta(profileDir),
    readGatewayProfileSecret(profileDir),
    readGatewayUpstreamConfig(input.upstreamId, context),
    readGatewayRuntimeConfig(context),
    readSettings(profileDir)
  ]);
  if (meta?.type !== "gateway") throw new CcpError(`Profile is not a gateway profile: ${profileDir}`);
  if (!profileSecret) throw new CcpError(`Gateway profile secret is missing: ${getGatewaySecretPath(profileDir)}`);
  const binding = validateGatewayProfileBinding(input);
  if (!upstream.models.includes(binding.model)) {
    throw new CcpError(`Gateway model '${binding.model}' is not configured for upstream '${binding.upstreamId}'.`);
  }
  const nextMeta: ProfileMeta = { ...meta, gateway: binding };
  const nextSettings = buildGatewaySettings(
    currentSettings,
    profileName,
    getGatewayEndpoint(runtimeConfig),
    profileSecret,
    binding.model
  );
  try {
    await writeMeta(profileDir, nextMeta);
    await writeSettings(profileDir, nextSettings);
  } catch (error) {
    await Promise.allSettled([
      writeMeta(profileDir, meta),
      currentSettings ? writeSettings(profileDir, currentSettings) : Promise.resolve()
    ]);
    throw error;
  }
  const resolved = await readGatewayProfile(profileDir, context);
  return { binding, config: resolved.config, secret: resolved.secret };
}

export function tokensEqual(expected: string, actual: string): boolean {
  const expectedDigest = createHash("sha256").update(expected).digest();
  const actualDigest = createHash("sha256").update(actual).digest();
  return timingSafeEqual(expectedDigest, actualDigest);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
