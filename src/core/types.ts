export type ProfileType = "api" | "login" | "ccr" | "gateway" | "unknown";

export type GatewayProvider = "openai" | "openai-compatible";

export interface GatewayCompatibility {
  instructionRole: "system" | "developer";
  maxTokensField: "max_tokens" | "max_completion_tokens";
  supportsStop: boolean;
  supportsSampling: boolean;
  parallelToolCalls: "supported" | "unsupported";
  streamUsage: "include" | "omit";
  reasoningEffort: "reasoning_effort" | "output_config" | "omit";
  structuredOutput: "response_format" | "output_config" | "unsupported";
}

export interface GatewayProfileConfig {
  provider: GatewayProvider;
  protocol: "openai_chat_completions";
  chatCompletionsUrl: string;
  model: string;
  compatibility: GatewayCompatibility;
}

export interface GatewayProfileSecret {
  version: 1;
  localToken: string;
}

export interface GatewayResolvedSecret {
  localToken: string;
  apiKey: string;
}

export interface GatewayProfileBinding {
  upstreamId: string;
  model: string;
}

export interface GatewayUpstreamConfig {
  version: 1;
  id: string;
  provider: GatewayProvider;
  protocol: "openai_chat_completions";
  chatCompletionsUrl: string;
  models: string[];
  compatibility: GatewayCompatibility;
}

export interface GatewayUpstreamSecret {
  version: 1;
  apiKey: string;
}

export interface GatewayUpstreamSummary extends GatewayUpstreamConfig {
  apiKeyStatus: "set" | "missing";
}

export interface ClaudeSettings {
  theme?: string;
  env?: Record<string, string>;
  [key: string]: unknown;
}

export interface ProfileMeta {
  version: number;
  type: Exclude<ProfileType, "unknown">;
  createdAt?: string;
  preset?: string;
  endpoint?: string;
  autoStart?: boolean;
  ccrPreset?: string;
  ccrRoute?: string;
  gateway?: GatewayProfileBinding;
}

export interface ProfileSummary {
  name: string;
  dir: string;
  type: ProfileType;
  baseUrl: string;
  model: string;
  tokenStatus: "set" | "missing";
  settingsPath: string;
  meta?: ProfileMeta;
}

export interface CreateApiProfileInput {
  name: string;
  baseUrl: string;
  token: string;
  model: string;
}

export interface CreateApiProfileFromEnvInput {
  name: string;
  env: Record<string, string>;
  preset?: string;
}

export interface CreateLoginProfileInput {
  name: string;
}

export interface CreateCcrProfileInput {
  name: string;
  route: string;
  token: string;
  presetName?: string;
  presetId?: string;
}

export interface CreateGatewayProfileInput {
  name: string;
  upstreamId: string;
  model: string;
  preset?: string;
}

export interface UpdateGatewayProfileInput {
  upstreamId: string;
  model: string;
}

export interface CreateGatewayUpstreamInput {
  id: string;
  provider: GatewayProvider;
  chatCompletionsUrl: string;
  apiKey: string;
  models: string[];
  compatibility?: Partial<GatewayCompatibility>;
}

export interface UpdateGatewayUpstreamInput {
  provider: GatewayProvider;
  chatCompletionsUrl: string;
  apiKey?: string;
  models: string[];
  compatibility: Partial<GatewayCompatibility>;
}
