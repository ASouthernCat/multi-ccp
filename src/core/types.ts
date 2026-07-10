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
  apiKey: string;
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
  gateway?: GatewayProfileConfig;
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
  provider: GatewayProvider;
  chatCompletionsUrl: string;
  apiKey: string;
  model: string;
  compatibility?: Partial<GatewayCompatibility>;
  preset?: string;
}
