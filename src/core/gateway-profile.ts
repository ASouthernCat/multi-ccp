import { createHash, timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { CcpError } from "./errors.js";
import type { PathContext } from "./paths.js";
import {
  readJsonFile,
  readMeta,
  readSettings,
  getSettingsPath,
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
import {
  buildGatewayLiveModelAliases,
  buildGatewayModelCatalog,
  CCP_DEFAULT_MODEL_ALIAS,
  decodeGatewayDefaultModelAlias,
  decodeGatewayLiveModelAlias,
  decodeGatewayModelAlias,
  decodeGatewayModelOptionAlias,
  gatewayDefaultModelAlias,
  gatewayModelAlias,
  gatewayModelOptionAlias
} from "../gateway/models.js";

export const GATEWAY_SECRET_FILE = ".ccp-gateway.json";
export const GATEWAY_MODEL_CACHE_FILE = "gateway-models.json";

const MODEL_ENV_NAMES = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES",
  "CLAUDE_CODE_SUBAGENT_MODEL"
];

interface GatewaySettingsModels {
  models: readonly string[];
  defaultModel: string;
  legacyDefaultModel?: string;
  selectedModel?: string;
  liveKnownModels?: readonly string[];
}

// Claude Code 2.1.219+ resolves the LLM gateway Default row through Opus 5;
// 2.1.200-2.1.218 used Opus 4.8 and already supported modelOverrides.
const CLAUDE_CODE_DEFAULT_MODEL_IDS = ["claude-opus-5", "claude-opus-4-8"] as const;

export function getGatewaySecretPath(profileDir: string): string {
  return path.join(profileDir, GATEWAY_SECRET_FILE);
}

export function getGatewayModelCachePath(profileDir: string): string {
  return path.join(profileDir, "cache", GATEWAY_MODEL_CACHE_FILE);
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

export async function writeGatewayModelCache(
  profileDir: string,
  profileName: string,
  endpoint: string,
  upstreamId: string,
  models: readonly string[],
  defaultModel: string
): Promise<void> {
  const catalog = buildGatewayModelCatalog(upstreamId, models, defaultModel);
  await writeJsonFileAtomic(getGatewayModelCachePath(profileDir), {
    baseUrl: `${endpoint}/p/${encodeURIComponent(profileName)}`,
    fetchedAt: Date.now(),
    models: catalog.map(({ id, display_name }) => ({ id, display_name }))
  });
}

export function buildGatewaySettings(
  current: ClaudeSettings | undefined,
  profileName: string,
  endpoint: string,
  secret: Pick<GatewayProfileSecret, "localToken">,
  modelConfig: GatewaySettingsModels
): ClaudeSettings {
  const env = { ...(current?.env ?? {}) };
  for (const name of MODEL_ENV_NAMES) delete env[name];
  const knownModels = modelConfig.liveKnownModels ? new Set(modelConfig.liveKnownModels) : undefined;
  const isLiveDefault = knownModels !== undefined && !knownModels.has(modelConfig.defaultModel);
  const defaultTarget = isLiveDefault
    ? modelConfig.defaultModel
    : gatewayDefaultModelAlias(modelConfig.defaultModel);
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
    CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
    // Gateway model ids are provider-defined, so Claude Code cannot infer
    // their context window from the id alone.
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
    MAX_THINKING_TOKENS: "0",
    ENABLE_TOOL_SEARCH: "false"
  });
  // Claude hot-reloads env values but does not unset removed values. Always
  // replace this target so live Default changes also work in both directions.
  // A direct override for an uncached target would display the built-in Opus name.
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = defaultTarget;
  // Claude Code caches /v1/models for the process lifetime, but hot-reloads
  // settings. Models missing from that cache use the anthropic.* namespace so
  // they become selectable immediately; startup repair restores catalog aliases.
  const liveAliases = buildGatewayLiveModelAliases(modelConfig.models);
  const availableModels = modelConfig.models.map((model) =>
    knownModels && !knownModels.has(model)
      ? liveAliases.get(model) ?? gatewayModelOptionAlias(model)
      : gatewayModelOptionAlias(model)
  );
  const selectedModel = normalizeSelectedGatewayModel(modelConfig, availableModels);
  const modelOverrides = stringEntries(current?.modelOverrides);
  for (const modelId of CLAUDE_CODE_DEFAULT_MODEL_IDS) delete modelOverrides[modelId];
  if (!isLiveDefault) {
    for (const modelId of CLAUDE_CODE_DEFAULT_MODEL_IDS) modelOverrides[modelId] = defaultTarget;
  }
  return {
    ...(current ?? {}),
    model: selectedModel,
    availableModels,
    modelOverrides,
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
  models: readonly string[];
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
    models: upstream.config.models,
    profileSecret,
    secret: { localToken: profileSecret.localToken, apiKey: upstream.secret.apiKey }
  };
}

export async function repairGatewayProfileSettings(
  profileDir: string,
  profileName: string,
  context: PathContext = {}
): Promise<{ config: GatewayProfileConfig; secret: GatewayResolvedSecret }> {
  const [{ binding, config, models, secret, profileSecret }, runtimeConfig, current] = await Promise.all([
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
    {
      models,
      defaultModel: config.model,
      selectedModel: savedModel
    }
  );
  if (!jsonEqual(current, expected)) await writeSettings(profileDir, expected);
  await writeGatewayModelCache(
    profileDir,
    profileName,
    getGatewayEndpoint(runtimeConfig),
    binding.upstreamId,
    models,
    config.model
  );
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
  const currentBinding = validateGatewayProfileBinding(meta.gateway);
  const binding = validateGatewayProfileBinding(input);
  if (!upstream.models.includes(binding.model)) {
    throw new CcpError(`Gateway model '${binding.model}' is not configured for upstream '${binding.upstreamId}'.`);
  }
  const nextMeta: ProfileMeta = { ...meta, gateway: binding };
  const liveKnownModels = currentBinding.upstreamId === binding.upstreamId
    ? cachedGatewayModels(currentSettings, upstream.models)
    : [];
  const nextSettings = buildGatewaySettings(
    currentSettings,
    profileName,
    getGatewayEndpoint(runtimeConfig),
    profileSecret,
    {
      models: upstream.models,
      defaultModel: binding.model,
      legacyDefaultModel: currentBinding.model,
      selectedModel: typeof currentSettings?.model === "string" ? currentSettings.model : undefined,
      liveKnownModels
    }
  );
  try {
    await writeMeta(profileDir, nextMeta);
    await writeSettings(profileDir, nextSettings);
    await writeGatewayModelCache(
      profileDir,
      profileName,
      getGatewayEndpoint(runtimeConfig),
      binding.upstreamId,
      upstream.models,
      binding.model
    );
  } catch (error) {
    await Promise.allSettled([
      writeMeta(profileDir, meta),
      currentSettings
        ? writeSettings(profileDir, currentSettings)
        : rm(getSettingsPath(profileDir), { force: true })
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

function stringEntries(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string"
    )
  );
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function cachedGatewayModels(settings: ClaudeSettings | undefined, models: readonly string[]): string[] {
  const availableModels = new Set(stringArray(settings?.availableModels));
  return models.filter((model) =>
    availableModels.has(gatewayModelOptionAlias(model)) || availableModels.has(gatewayModelAlias(model))
  );
}

function normalizeSelectedGatewayModel(
  modelConfig: GatewaySettingsModels,
  availableModels: readonly string[]
): string {
  const selectedModel = modelConfig.selectedModel?.trim();
  if (
    !selectedModel ||
    selectedModel === "default" ||
    selectedModel === CCP_DEFAULT_MODEL_ALIAS ||
    decodeGatewayDefaultModelAlias(selectedModel)
  ) return "default";
  if (availableModels.includes(selectedModel)) return selectedModel;
  const explicitModel = decodeGatewayModelOptionAlias(selectedModel)
    ?? decodeGatewayLiveModelAlias(selectedModel, modelConfig.models);
  if (explicitModel && modelConfig.models.includes(explicitModel)) {
    return availableModels[modelConfig.models.indexOf(explicitModel)] ?? "default";
  }
  const legacyModel = decodeGatewayModelAlias(selectedModel);
  if (!legacyModel || !modelConfig.models.includes(legacyModel)) return "default";
  const legacyDefaultModel = modelConfig.legacyDefaultModel ?? modelConfig.defaultModel;
  if (legacyModel === legacyDefaultModel) return "default";
  return availableModels[modelConfig.models.indexOf(legacyModel)] ?? "default";
}
