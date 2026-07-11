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
  GatewayCompatibility,
  GatewayProvider,
  GatewayUpstreamConfig,
  GatewayUpstreamSecret,
  GatewayUpstreamSummary,
  UpdateGatewayUpstreamInput
} from "./types.js";
import { mergeGatewayCompatibility, resolveGatewayChatCompletionsUrl } from "../gateway/config.js";

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
  return { ...compatibility };
}

export function normalizeGatewayModels(value: unknown): string[] {
  if (!Array.isArray(value)) throw new CcpError("Gateway upstream models must be an array.");
  const models = [...new Set(value.map((model) => String(model).trim()).filter(Boolean))];
  if (!models.length) throw new CcpError("Gateway upstream requires at least one model.");
  return models;
}

export function validateGatewayUpstreamConfig(value: unknown): GatewayUpstreamConfig {
  if (!value || typeof value !== "object") throw new CcpError("Gateway upstream config is missing.");
  const config = value as Partial<GatewayUpstreamConfig>;
  const id = String(config.id ?? "").trim();
  assertGatewayUpstreamId(id);
  if (config.version !== 1) throw new CcpError("Gateway upstream config version must be 1.");
  if (config.provider !== "openai" && config.provider !== "openai-compatible") {
    throw new CcpError("Gateway upstream provider must use the OpenAI Chat Completions format.");
  }
  if (config.protocol !== "openai_chat_completions") {
    throw new CcpError("Gateway upstream protocol must be openai_chat_completions.");
  }
  return {
    version: 1,
    id,
    provider: config.provider,
    protocol: "openai_chat_completions",
    chatCompletionsUrl: resolveGatewayChatCompletionsUrl(
      config.provider,
      String(config.chatCompletionsUrl ?? "")
    ),
    models: normalizeGatewayModels(config.models),
    compatibility: validateGatewayCompatibility(config.provider, config.compatibility)
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
    summaries.push({ ...config, apiKeyStatus });
  }
  return summaries.sort((left, right) => left.id.localeCompare(right.id));
}

export async function createGatewayUpstream(
  input: CreateGatewayUpstreamInput,
  context: PathContext = {}
): Promise<GatewayUpstreamSummary> {
  const config = validateGatewayUpstreamConfig({
    version: 1,
    id: input.id,
    provider: input.provider,
    protocol: "openai_chat_completions",
    chatCompletionsUrl: input.chatCompletionsUrl,
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
  return { ...config, apiKeyStatus: "set" };
}

export async function updateGatewayUpstream(
  id: string,
  input: UpdateGatewayUpstreamInput,
  context: PathContext = {}
): Promise<GatewayUpstreamSummary> {
  const current = await readGatewayUpstream(id, context);
  const config = validateGatewayUpstreamConfig({
    version: 1,
    id,
    provider: input.provider,
    protocol: "openai_chat_completions",
    chatCompletionsUrl: input.chatCompletionsUrl,
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
  return { ...config, apiKeyStatus: "set" };
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
