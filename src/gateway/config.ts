import path from "node:path";
import { CcpError } from "../core/errors.js";
import { getGatewayConfigPath, type PathContext } from "../core/paths.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/settings.js";
import type { GatewayCompatibility, GatewayProvider } from "../core/types.js";

export interface GatewayRuntimeConfig {
  version: 1;
  host: "127.0.0.1";
  port: number;
}

export const DEFAULT_GATEWAY_RUNTIME_CONFIG: GatewayRuntimeConfig = {
  version: 1,
  host: "127.0.0.1",
  port: 3921
};

export const OPENAI_GATEWAY_COMPATIBILITY: GatewayCompatibility = {
  instructionRole: "developer",
  maxTokensField: "max_completion_tokens",
  supportsStop: false,
  supportsSampling: false,
  parallelToolCalls: "supported",
  streamUsage: "include",
  reasoningEffort: "reasoning_effort",
  structuredOutput: "response_format"
};

export const MODERN_OPENAI_COMPATIBILITY: GatewayCompatibility = {
  instructionRole: "developer",
  maxTokensField: "max_completion_tokens",
  supportsStop: true,
  supportsSampling: true,
  parallelToolCalls: "supported",
  streamUsage: "include",
  reasoningEffort: "reasoning_effort",
  structuredOutput: "response_format"
};

export const CUSTOM_GATEWAY_COMPATIBILITY: GatewayCompatibility = {
  instructionRole: "system",
  maxTokensField: "max_tokens",
  supportsStop: true,
  supportsSampling: true,
  parallelToolCalls: "unsupported",
  streamUsage: "omit",
  reasoningEffort: "omit",
  structuredOutput: "unsupported"
};

export function defaultGatewayCompatibility(provider: GatewayProvider): GatewayCompatibility {
  return {
    ...(provider === "openai" ? OPENAI_GATEWAY_COMPATIBILITY : CUSTOM_GATEWAY_COMPATIBILITY)
  };
}

export function mergeGatewayCompatibility(
  provider: GatewayProvider,
  value: Partial<GatewayCompatibility> | undefined
): GatewayCompatibility {
  return { ...defaultGatewayCompatibility(provider), ...value };
}

export function normalizeChatCompletionsUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new CcpError("Chat Completions URL must be a valid http or https URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CcpError("Chat Completions URL must use http or https.");
  }
  if (parsed.username || parsed.password) {
    throw new CcpError("Chat Completions URL must not contain a username or password.");
  }
  for (const key of parsed.searchParams.keys()) {
    if (/(?:key|token|secret|authorization)/i.test(key)) {
      throw new CcpError(`Chat Completions URL query parameter '${key}' may contain credentials. Store credentials in the gateway API key field instead.`);
    }
  }

  const normalizedPath = parsed.pathname.replace(/\/+$/, "");
  if (!normalizedPath.toLowerCase().endsWith("/chat/completions")) {
    parsed.pathname = path.posix.join(normalizedPath || "/", "chat/completions");
  } else {
    parsed.pathname = normalizedPath;
  }
  parsed.hash = "";
  return parsed.toString();
}

export function validateGatewayRuntimeConfig(value: unknown): GatewayRuntimeConfig {
  if (!value || typeof value !== "object") {
    throw new CcpError("Gateway runtime config must be a JSON object.");
  }
  const config = value as Partial<GatewayRuntimeConfig>;
  if (config.version !== 1 || config.host !== "127.0.0.1") {
    throw new CcpError("Gateway runtime config must use version 1 and host 127.0.0.1.");
  }
  if (!Number.isInteger(config.port) || (config.port ?? 0) < 1 || (config.port ?? 0) > 65535) {
    throw new CcpError("Gateway runtime port must be an integer from 1 to 65535.");
  }
  return { version: 1, host: "127.0.0.1", port: config.port as number };
}

export async function readGatewayRuntimeConfig(context: PathContext = {}): Promise<GatewayRuntimeConfig> {
  const value = await readJsonFile<unknown>(getGatewayConfigPath(context));
  return value === undefined ? { ...DEFAULT_GATEWAY_RUNTIME_CONFIG } : validateGatewayRuntimeConfig(value);
}

export async function writeGatewayRuntimeConfig(
  config: GatewayRuntimeConfig,
  context: PathContext = {}
): Promise<void> {
  await writeJsonFileAtomic(getGatewayConfigPath(context), validateGatewayRuntimeConfig(config));
}

export function getGatewayEndpoint(config: GatewayRuntimeConfig): string {
  return `http://${config.host}:${config.port}`;
}

export function getGatewayProfileBaseUrl(profileName: string, config: GatewayRuntimeConfig): string {
  return `${getGatewayEndpoint(config)}/p/${encodeURIComponent(profileName)}`;
}
