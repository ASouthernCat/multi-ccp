import path from "node:path";
import { CcpError } from "../core/errors.js";
import { getGatewayConfigPath, type PathContext } from "../core/paths.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/settings.js";
import type {
  GatewayChatCompatibility,
  GatewayCompatibility,
  GatewayProtocolCompatibility,
  GatewayProvider,
  GatewayResponsesCompatibility,
  GatewayUpstreamProtocol
} from "../core/types.js";

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

export const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

export const OPENAI_RESPONSES_COMPATIBILITY: GatewayResponsesCompatibility = {
  protocol: "openai_responses",
  instructions: "instructions",
  maxOutputTokens: "max_output_tokens",
  supportsStop: false,
  supportsSampling: false,
  parallelToolCalls: "supported",
  // Claude Code / Anthropic tools are not generally strict-schema compatible.
  toolStrict: "non_strict",
  reasoningEffort: "reasoning.effort",
  structuredOutput: "text.format",
  store: false
};

export const CUSTOM_RESPONSES_COMPATIBILITY: GatewayResponsesCompatibility = {
  ...OPENAI_RESPONSES_COMPATIBILITY,
  supportsSampling: true
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
  const defaults = defaultGatewayCompatibility(provider);
  return provider === "openai" ? defaults : { ...defaults, ...value };
}

export function defaultGatewayProtocolCompatibility(
  protocol: GatewayUpstreamProtocol,
  provider: GatewayProvider
): GatewayProtocolCompatibility {
  if (protocol === "openai_responses") {
    return {
      ...(provider === "openai" ? OPENAI_RESPONSES_COMPATIBILITY : CUSTOM_RESPONSES_COMPATIBILITY)
    };
  }
  return {
    protocol: "openai_chat_completions",
    ...defaultGatewayCompatibility(provider)
  };
}

export function mergeGatewayProtocolCompatibility(
  protocol: "openai_chat_completions",
  provider: GatewayProvider,
  value: Partial<GatewayCompatibility> | Partial<GatewayChatCompatibility> | undefined
): GatewayChatCompatibility;
export function mergeGatewayProtocolCompatibility(
  protocol: "openai_responses",
  provider: GatewayProvider,
  value: Partial<GatewayResponsesCompatibility> | undefined
): GatewayResponsesCompatibility;
export function mergeGatewayProtocolCompatibility(
  protocol: GatewayUpstreamProtocol,
  provider: GatewayProvider,
  value: Partial<GatewayProtocolCompatibility> | undefined
): GatewayProtocolCompatibility {
  const defaults = defaultGatewayProtocolCompatibility(protocol, provider);
  if (provider === "openai") return defaults;
  return { ...defaults, ...value, protocol } as GatewayProtocolCompatibility;
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

export function normalizeGatewayEndpoint(
  protocol: GatewayUpstreamProtocol,
  provider: GatewayProvider,
  value: string
): string {
  const officialEndpoint = protocol === "openai_responses"
    ? OPENAI_RESPONSES_URL
    : OPENAI_CHAT_COMPLETIONS_URL;
  const endpointLabel = protocol === "openai_responses" ? "Responses endpoint" : "Chat Completions endpoint";
  const raw = value.trim();
  if (provider === "openai" && !raw) return officialEndpoint;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CcpError(`${endpointLabel} must be a valid http or https URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CcpError(`${endpointLabel} must use http or https.`);
  }
  if (parsed.username || parsed.password) {
    throw new CcpError(`${endpointLabel} must not contain a username or password.`);
  }
  for (const key of parsed.searchParams.keys()) {
    if (/(?:key|token|secret|authorization)/i.test(key)) {
      throw new CcpError(`${endpointLabel} query parameter '${key}' may contain credentials. Store credentials in the gateway API key field instead.`);
    }
  }

  const normalizedPath = parsed.pathname.replace(/\/+$/, "");
  const expectedSuffix = protocol === "openai_responses" ? "/responses" : "/chat/completions";
  if (!normalizedPath.toLowerCase().endsWith(expectedSuffix)) {
    throw new CcpError(`${endpointLabel} must end with '${expectedSuffix}'.`);
  }
  parsed.pathname = normalizedPath;
  parsed.hash = "";
  return parsed.toString();
}

export function resolveGatewayBaseUrl(
  protocol: GatewayUpstreamProtocol,
  provider: GatewayProvider,
  value: string
): string {
  const officialEndpoint = protocol === "openai_responses"
    ? OPENAI_RESPONSES_URL
    : OPENAI_CHAT_COMPLETIONS_URL;
  if (provider === "openai" && !value.trim()) return officialEndpoint;

  const raw = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CcpError("Gateway base URL must be a valid http or https URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CcpError("Gateway base URL must use http or https.");
  }
  if (parsed.username || parsed.password) {
    throw new CcpError("Gateway base URL must not contain a username or password.");
  }
  for (const key of parsed.searchParams.keys()) {
    if (/(?:key|token|secret|authorization)/i.test(key)) {
      throw new CcpError(`Gateway base URL query parameter '${key}' may contain credentials. Store credentials in the gateway API key field instead.`);
    }
  }

  const suffix = protocol === "openai_responses" ? "responses" : "chat/completions";
  let pathname = parsed.pathname.replace(/\/+$/, "");
  const lowerPath = pathname.toLowerCase();
  const fullSuffix = `/${suffix}`;
  if (!lowerPath.endsWith(fullSuffix)) {
    pathname = lowerPath.endsWith("/v1")
      ? `${pathname}/${suffix}`
      : `${pathname}/v1/${suffix}`;
  }
  parsed.pathname = pathname.replace(/^\/{2,}/, "/");
  parsed.hash = "";
  return normalizeGatewayEndpoint(protocol, provider, parsed.toString());
}

export function resolveGatewayChatCompletionsUrl(provider: GatewayProvider, value: string): string {
  if (provider === "openai" && !value.trim()) return OPENAI_CHAT_COMPLETIONS_URL;
  return normalizeChatCompletionsUrl(value);
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
