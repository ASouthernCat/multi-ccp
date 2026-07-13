export type ProfileType = "api" | "login" | "ccr" | "gateway" | "unknown";

export type GatewayProvider = "openai" | "openai-compatible";

export type GatewayUpstreamProtocol = "openai_chat_completions" | "openai_responses";

// Temporary Chat compatibility alias for existing management and converter callers.
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

export interface GatewayChatCompatibility extends GatewayCompatibility {
  protocol: "openai_chat_completions";
}

export interface GatewayResponsesCompatibility {
  protocol: "openai_responses";
  instructions: "instructions" | "system_input";
  maxOutputTokens: "max_output_tokens";
  supportsStop: false;
  supportsSampling: boolean;
  parallelToolCalls: "supported" | "unsupported";
  /**
   * OpenAI Responses tools accept `strict: true` only when every object sets
   * `additionalProperties: false` and lists all properties in `required`.
   * Claude Code tools commonly leave optional fields out of `required`, so the
   * gateway defaults to non-strict translation (`strict: false` + original schema).
   */
  toolStrict: "strict" | "non_strict";
  reasoningEffort: "reasoning.effort" | "omit";
  structuredOutput: "text.format" | "unsupported";
  store: false;
}

export type GatewayProtocolCompatibility =
  | GatewayChatCompatibility
  | GatewayResponsesCompatibility;

interface GatewayProfileConfigBase {
  provider: GatewayProvider;
  endpointUrl: string;
  model: string;
}

export type GatewayProfileConfig =
  | (GatewayProfileConfigBase & {
      protocol: "openai_chat_completions";
      compatibility: GatewayChatCompatibility;
    })
  | (GatewayProfileConfigBase & {
      protocol: "openai_responses";
      compatibility: GatewayResponsesCompatibility;
    });

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

interface GatewayUpstreamConfigBase {
  version: 2;
  id: string;
  provider: GatewayProvider;
  endpointUrl: string;
  models: string[];
}

export type GatewayUpstreamConfig =
  | (GatewayUpstreamConfigBase & {
      protocol: "openai_chat_completions";
      compatibility: GatewayChatCompatibility;
    })
  | (GatewayUpstreamConfigBase & {
      protocol: "openai_responses";
      compatibility: GatewayResponsesCompatibility;
    });

export interface GatewayUpstreamSecret {
  version: 1;
  apiKey: string;
}

export type GatewayUpstreamSummary = GatewayUpstreamConfig & {
  apiKeyStatus: "set" | "missing";
  chatCompletionsUrl?: string;
};

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
  protocol?: GatewayUpstreamProtocol;
  endpointUrl?: string;
  chatCompletionsUrl?: string;
  apiKey: string;
  models: string[];
  compatibility?: Partial<GatewayCompatibility> | Partial<GatewayResponsesCompatibility>;
}

export interface UpdateGatewayUpstreamInput {
  id?: string;
  provider: GatewayProvider;
  protocol?: GatewayUpstreamProtocol;
  endpointUrl?: string;
  chatCompletionsUrl?: string;
  apiKey?: string;
  models: string[];
  compatibility: Partial<GatewayCompatibility> | Partial<GatewayResponsesCompatibility>;
}
