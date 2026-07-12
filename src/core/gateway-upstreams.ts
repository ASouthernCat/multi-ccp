import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { assertProfileName, CcpError } from "./errors.js";
import {
  getGatewayUpstreamsDir,
  getGatewayUpstreamSecretsDir,
  getProfilesRoot,
  type PathContext
} from "./paths.js";
import { readJsonFile, readMeta, writeJsonFileAtomic } from "./settings.js";
import type {
  CreateGatewayUpstreamInput,
  GatewayChatCompatibility,
  GatewayCompatibility,
  GatewayProtocolCompatibility,
  GatewayProvider,
  GatewayResponsesCompatibility,
  GatewayUpstreamConfig,
  GatewayUpstreamProtocol,
  GatewayUpstreamSecret,
  GatewayUpstreamSummary,
  UpdateGatewayUpstreamInput
} from "./types.js";
import {
  mergeGatewayCompatibility,
  mergeGatewayProtocolCompatibility,
  normalizeGatewayEndpoint,
  resolveGatewayChatCompletionsUrl
} from "../gateway/config.js";

export function assertGatewayUpstreamId(id: string): void {
  assertProfileName(id);
}

export function getGatewayUpstreamPath(id: string, context: PathContext = {}): string {
  assertGatewayUpstreamId(id);
  return path.join(getGatewayUpstreamsDir(context), `${id}.json`);
}

export function getGatewayUpstreamSecretPath(id: string, context: PathContext = {}): string {
  assertGatewayUpstreamId(id);
  return path.join(getGatewayUpstreamSecretsDir(context), `${id}.json`);
}

function gatewayUpstreamIdKey(id: string): string {
  return id.toLowerCase();
}

async function findCaseInsensitiveGatewayUpstreamId(
  id: string,
  context: PathContext
): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(getGatewayUpstreamsDir(context), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const targetKey = gatewayUpstreamIdKey(id);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.startsWith(".")) continue;
    const existingId = entry.name.slice(0, -5);
    if (gatewayUpstreamIdKey(existingId) === targetKey) return existingId;
  }
  return undefined;
}

export function validateGatewayCompatibility(
  provider: GatewayProvider,
  value: Partial<GatewayCompatibility> | undefined
): GatewayCompatibility {
  const compatibility = mergeGatewayCompatibility(provider, value);
  validateChatCompatibilityFields(compatibility);
  return { ...compatibility };
}

export function validateGatewayProtocolCompatibility(
  protocol: "openai_chat_completions",
  provider: GatewayProvider,
  value: Partial<GatewayCompatibility> | Partial<GatewayChatCompatibility> | undefined
): GatewayChatCompatibility;
export function validateGatewayProtocolCompatibility(
  protocol: "openai_responses",
  provider: GatewayProvider,
  value: Partial<GatewayResponsesCompatibility> | undefined
): GatewayResponsesCompatibility;
export function validateGatewayProtocolCompatibility(
  protocol: GatewayUpstreamProtocol,
  provider: GatewayProvider,
  value: Partial<GatewayProtocolCompatibility> | undefined
): GatewayProtocolCompatibility {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
    throw new CcpError("Gateway compatibility config must be an object.");
  }
  if (value?.protocol !== undefined && value.protocol !== protocol) {
    throw new CcpError("Gateway compatibility protocol must match the upstream protocol.");
  }
  if (protocol === "openai_responses") {
    if (hasAnyGatewayCompatibilityField(value, ["instructionRole", "maxTokensField", "streamUsage"])) {
      throw new CcpError("Gateway Responses compatibility config contains Chat-only fields.");
    }
    const compatibility = mergeGatewayProtocolCompatibility(protocol, provider, value as Partial<GatewayResponsesCompatibility>);
    if (
      !["instructions", "system_input"].includes(compatibility.instructions) ||
      compatibility.maxOutputTokens !== "max_output_tokens" ||
      compatibility.supportsStop !== false ||
      typeof compatibility.supportsSampling !== "boolean" ||
      !["supported", "unsupported"].includes(compatibility.parallelToolCalls) ||
      !["strict", "non_strict"].includes(compatibility.toolStrict) ||
      !["reasoning.effort", "omit"].includes(compatibility.reasoningEffort) ||
      !["text.format", "unsupported"].includes(compatibility.structuredOutput) ||
      compatibility.store !== false
    ) {
      throw new CcpError("Gateway Responses compatibility config is invalid.");
    }
    return { ...compatibility };
  }

  if (hasAnyGatewayCompatibilityField(value, ["instructions", "maxOutputTokens", "store"])) {
    throw new CcpError("Gateway Chat compatibility config contains Responses-only fields.");
  }
  const compatibility = mergeGatewayProtocolCompatibility(
    protocol,
    provider,
    value as Partial<GatewayCompatibility> | Partial<GatewayChatCompatibility>
  );
  validateChatCompatibilityFields(compatibility);
  return { ...compatibility };
}

function hasAnyGatewayCompatibilityField(
  value: Partial<GatewayProtocolCompatibility> | undefined,
  fields: string[]
): boolean {
  return value !== undefined && fields.some((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function validateChatCompatibilityFields(compatibility: GatewayCompatibility): void {
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
}

export function normalizeGatewayModels(value: unknown): string[] {
  if (!Array.isArray(value)) throw new CcpError("Gateway upstream models must be an array.");
  const models = [...new Set(value.map((model) => String(model).trim()).filter(Boolean))];
  if (!models.length) throw new CcpError("Gateway upstream requires at least one model.");
  return models;
}

export function validateGatewayUpstreamConfig(value: unknown): GatewayUpstreamConfig {
  if (!value || typeof value !== "object") throw new CcpError("Gateway upstream config is missing.");
  const config = value as Record<string, unknown>;
  const id = String(config.id ?? "").trim();
  assertGatewayUpstreamId(id);
  if (config.provider !== "openai" && config.provider !== "openai-compatible") {
    throw new CcpError("Gateway upstream provider must be openai or openai-compatible.");
  }
  const provider: GatewayProvider = config.provider;
  if (config.version === 1) {
    if (config.protocol !== "openai_chat_completions") {
      throw new CcpError("Gateway upstream version 1 protocol must be openai_chat_completions.");
    }
    return {
      version: 2,
      id,
      provider,
      protocol: "openai_chat_completions",
      endpointUrl: resolveGatewayChatCompletionsUrl(provider, String(config.chatCompletionsUrl ?? "")),
      models: normalizeGatewayModels(config.models),
      compatibility: {
        protocol: "openai_chat_completions",
        ...validateGatewayCompatibility(provider, config.compatibility as Partial<GatewayCompatibility> | undefined)
      }
    };
  }
  if (config.version !== 2) throw new CcpError("Gateway upstream config version must be 1 or 2.");
  if (config.protocol !== "openai_chat_completions" && config.protocol !== "openai_responses") {
    throw new CcpError("Gateway upstream protocol is invalid.");
  }
  const protocol = config.protocol;
  const common = {
    version: 2 as const,
    id,
    provider,
    endpointUrl: normalizeGatewayEndpoint(protocol, provider, String(config.endpointUrl ?? "")),
    models: normalizeGatewayModels(config.models)
  };
  if (protocol === "openai_responses") {
    return {
      ...common,
      protocol,
      compatibility: validateGatewayProtocolCompatibility(
        protocol,
        provider,
        config.compatibility as Partial<GatewayResponsesCompatibility> | undefined
      )
    };
  }
  return {
    ...common,
    protocol,
    compatibility: validateGatewayProtocolCompatibility(
      protocol,
      provider,
      config.compatibility as Partial<GatewayCompatibility> | Partial<GatewayChatCompatibility> | undefined
    )
  };
}

export function validateGatewayUpstreamSecret(value: unknown): GatewayUpstreamSecret {
  if (!value || typeof value !== "object") throw new CcpError("Gateway upstream secret is missing.");
  const secret = value as Partial<GatewayUpstreamSecret>;
  if (secret.version !== 1 || !secret.apiKey?.trim()) {
    throw new CcpError("Gateway upstream secret must contain version and apiKey.");
  }
  return { version: 1, apiKey: secret.apiKey.trim() };
}

export async function readGatewayUpstreamConfig(
  id: string,
  context: PathContext = {}
): Promise<GatewayUpstreamConfig> {
  const value = await readJsonFile<unknown>(getGatewayUpstreamPath(id, context));
  if (value === undefined) throw new CcpError(`Gateway upstream '${id}' does not exist.`);
  const config = validateGatewayUpstreamConfig(value);
  if (config.id !== id) throw new CcpError(`Gateway upstream file '${id}' contains mismatched id '${config.id}'.`);
  return config;
}

export async function readGatewayUpstreamSecret(
  id: string,
  context: PathContext = {}
): Promise<GatewayUpstreamSecret> {
  const value = await readJsonFile<unknown>(getGatewayUpstreamSecretPath(id, context));
  if (value === undefined) throw new CcpError(`Gateway upstream '${id}' is missing its API key.`);
  return validateGatewayUpstreamSecret(value);
}

export async function readGatewayUpstream(
  id: string,
  context: PathContext = {}
): Promise<{ config: GatewayUpstreamConfig; secret: GatewayUpstreamSecret }> {
  const [config, secret] = await Promise.all([
    readGatewayUpstreamConfig(id, context),
    readGatewayUpstreamSecret(id, context)
  ]);
  return { config, secret };
}

export async function listGatewayUpstreams(context: PathContext = {}): Promise<GatewayUpstreamSummary[]> {
  let entries;
  try {
    entries = await readdir(getGatewayUpstreamsDir(context), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const summaries: GatewayUpstreamSummary[] = [];
  const idsByKey = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.startsWith(".")) continue;
    const id = entry.name.slice(0, -5);
    const idKey = gatewayUpstreamIdKey(id);
    const conflictingId = idsByKey.get(idKey);
    if (conflictingId) {
      throw new CcpError(
        `Gateway upstream IDs '${conflictingId}' and '${id}' differ only by letter case. Rename one before using this configuration on another operating system.`
      );
    }
    idsByKey.set(idKey, id);
    const config = await readGatewayUpstreamConfig(id, context);
    let apiKeyStatus: GatewayUpstreamSummary["apiKeyStatus"] = "missing";
    try {
      await readGatewayUpstreamSecret(id, context);
      apiKeyStatus = "set";
    } catch (error) {
      if (!(error instanceof CcpError) || !error.message.includes("missing its API key")) throw error;
    }
    summaries.push({
      ...config,
      ...(config.protocol === "openai_chat_completions" ? { chatCompletionsUrl: config.endpointUrl } : {}),
      apiKeyStatus
    });
  }
  return summaries.sort((left, right) => left.id.localeCompare(right.id));
}

export async function createGatewayUpstream(
  input: CreateGatewayUpstreamInput,
  context: PathContext = {}
): Promise<GatewayUpstreamSummary> {
  const protocol = input.protocol ?? "openai_chat_completions";
  const endpointUrl = input.endpointUrl ?? (
    protocol === "openai_chat_completions"
      ? resolveGatewayChatCompletionsUrl(input.provider, input.chatCompletionsUrl ?? "")
      : ""
  );
  const config = validateGatewayUpstreamConfig({
    version: 2,
    id: input.id,
    provider: input.provider,
    protocol,
    endpointUrl,
    models: input.models,
    compatibility: input.compatibility
  });
  const secret = validateGatewayUpstreamSecret({ version: 1, apiKey: input.apiKey });
  const existingId = await findCaseInsensitiveGatewayUpstreamId(config.id, context);
  if (existingId) {
    if (existingId === config.id) {
      throw new CcpError(`Gateway upstream '${config.id}' already exists.`);
    }
    throw new CcpError(
      `Gateway upstream '${config.id}' conflicts with existing upstream '${existingId}'. Upstream IDs preserve letter case but must be unique ignoring letter case.`
    );
  }
  try {
    await stat(getGatewayUpstreamPath(config.id, context));
    throw new CcpError(`Gateway upstream '${config.id}' already exists.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeJsonFileAtomic(getGatewayUpstreamSecretPath(config.id, context), secret, 0o600);
  try {
    await writeJsonFileAtomic(getGatewayUpstreamPath(config.id, context), config, 0o600);
  } catch (error) {
    await rm(getGatewayUpstreamSecretPath(config.id, context), { force: true }).catch(() => undefined);
    throw error;
  }
  return {
    ...config,
    ...(config.protocol === "openai_chat_completions" ? { chatCompletionsUrl: config.endpointUrl } : {}),
    apiKeyStatus: "set"
  };
}

export async function updateGatewayUpstream(
  id: string,
  input: UpdateGatewayUpstreamInput,
  context: PathContext = {}
): Promise<GatewayUpstreamSummary> {
  const current = await readGatewayUpstream(id, context);
  const protocol = input.protocol ?? current.config.protocol;
  const endpointUrl = input.endpointUrl ?? (
    input.chatCompletionsUrl !== undefined && protocol === "openai_chat_completions"
      ? resolveGatewayChatCompletionsUrl(input.provider, input.chatCompletionsUrl)
      : current.config.endpointUrl
  );
  const config = validateGatewayUpstreamConfig({
    version: 2,
    id,
    provider: input.provider,
    protocol,
    endpointUrl,
    models: input.models,
    compatibility: input.compatibility
  });
  const invalidBindings = (await findGatewayUpstreamBindings(id, context))
    .filter((binding) => !config.models.includes(binding.model));
  if (invalidBindings.length) {
    throw new CcpError(
      `Gateway upstream '${id}' cannot remove models used by profiles: ${invalidBindings.map((binding) => `${binding.profileName}/${binding.model}`).join(", ")}.`
    );
  }
  const secret = validateGatewayUpstreamSecret({
    version: 1,
    apiKey: input.apiKey?.trim() || current.secret.apiKey
  });
  try {
    await writeJsonFileAtomic(getGatewayUpstreamSecretPath(id, context), secret, 0o600);
    await writeJsonFileAtomic(getGatewayUpstreamPath(id, context), config, 0o600);
  } catch (error) {
    await Promise.allSettled([
      writeJsonFileAtomic(getGatewayUpstreamSecretPath(id, context), current.secret, 0o600),
      writeJsonFileAtomic(getGatewayUpstreamPath(id, context), current.config, 0o600)
    ]);
    throw error;
  }
  return {
    ...config,
    ...(config.protocol === "openai_chat_completions" ? { chatCompletionsUrl: config.endpointUrl } : {}),
    apiKeyStatus: "set"
  };
}

export async function removeGatewayUpstream(id: string, context: PathContext = {}): Promise<void> {
  await readGatewayUpstreamConfig(id, context);
  const references = await findGatewayUpstreamReferences(id, context);
  if (references.length) {
    throw new CcpError(
      `Gateway upstream '${id}' is used by profile${references.length === 1 ? "" : "s"}: ${references.join(", ")}. Rebind or remove those profiles first.`
    );
  }
  await Promise.all([
    rm(getGatewayUpstreamPath(id, context), { force: true }),
    rm(getGatewayUpstreamSecretPath(id, context), { force: true })
  ]);
}

export async function findGatewayUpstreamReferences(
  id: string,
  context: PathContext = {}
): Promise<string[]> {
  return (await findGatewayUpstreamBindings(id, context)).map((binding) => binding.profileName);
}

async function findGatewayUpstreamBindings(
  id: string,
  context: PathContext
): Promise<Array<{ profileName: string; model: string }>> {
  let entries;
  try {
    entries = await readdir(getProfilesRoot(context), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const references: Array<{ profileName: string; model: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const meta = await readMeta(path.join(getProfilesRoot(context), entry.name));
    if (meta?.type === "gateway" && meta.gateway?.upstreamId === id) {
      references.push({ profileName: entry.name, model: meta.gateway.model });
    }
  }
  return references.sort((left, right) => left.profileName.localeCompare(right.profileName));
}

export async function getGatewayUpstreamFingerprint(id: string, context: PathContext = {}): Promise<string> {
  try {
    const [config, secret] = await Promise.all([
      stat(getGatewayUpstreamPath(id, context)),
      stat(getGatewayUpstreamSecretPath(id, context))
    ]);
    return `${config.mtimeMs}:${config.size}:${secret.mtimeMs}:${secret.size}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CcpError(`Gateway upstream '${id}' is missing configuration or secret files.`);
    }
    throw error;
  }
}
