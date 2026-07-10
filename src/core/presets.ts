import { ensureCcrProviderTemplate } from "./ccr.js";
import { CcpError } from "./errors.js";
import { createApiProfileFromEnv, createCcrProfile, createGatewayProfile } from "./profiles.js";
import type { GatewayCompatibility, GatewayProvider, ProfileSummary } from "./types.js";
import type { PathContext } from "./paths.js";

export type ProfilePresetType = "api" | "ccr" | "login" | "custom-api" | "manual-ccr" | "gateway" | "custom-gateway";

export interface BaseProfilePreset {
  id: string;
  label: string;
  type: ProfilePresetType;
  category: "api" | "ccr" | "custom" | "login" | "gateway";
  defaultProfileName: string;
  description: string;
  modelSummary?: string;
  tags?: string[];
  sortOrder?: number;
}

export interface ApiProfilePreset extends BaseProfilePreset {
  type: "api";
  env: Record<string, string>;
}

export interface CcrProviderTemplate {
  name: string;
  api_base_url: string;
  api_key?: string;
  models: string[];
}

export interface CcrProfilePreset extends BaseProfilePreset {
  type: "ccr";
  ccrPreset: string;
  ccrRoute: string;
  tokenDefault?: string;
  providerTemplate?: CcrProviderTemplate;
}


export interface CustomApiProfilePreset extends BaseProfilePreset {
  type: "custom-api";
}

export interface ManualCcrProfilePreset extends BaseProfilePreset {
  type: "manual-ccr";
}

export interface LoginProfilePreset extends BaseProfilePreset {
  type: "login";
}

export interface GatewayProfilePreset extends BaseProfilePreset {
  type: "gateway";
  provider: GatewayProvider;
  chatCompletionsUrl: string;
  compatibility: GatewayCompatibility;
}

export interface CustomGatewayProfilePreset extends BaseProfilePreset {
  type: "custom-gateway";
}

export type BuiltinProfilePreset = ApiProfilePreset | CcrProfilePreset | CustomApiProfilePreset | ManualCcrProfilePreset | LoginProfilePreset | GatewayProfilePreset | CustomGatewayProfilePreset;

export const PROFILE_PRESETS: BuiltinProfilePreset[] = [
  {
    id: "openai-gateway",
    label: "OpenAI via Built-in Gateway",
    type: "gateway",
    category: "gateway",
    defaultProfileName: "openai",
    description: "使用 multi-ccp 内置网关连接 OpenAI Chat Completions。",
    modelSummary: "OpenAI Chat Completions",
    tags: ["Gateway", "OpenAI"],
    sortOrder: 5,
    provider: "openai",
    chatCompletionsUrl: "https://api.openai.com/v1/chat/completions",
    compatibility: {
      instructionRole: "developer",
      maxTokensField: "max_completion_tokens",
      supportsStop: false,
      supportsSampling: false,
      parallelToolCalls: "supported",
      streamUsage: "include"
    }
  },
  {
    id: "custom-gateway",
    label: "Custom OpenAI-Compatible Gateway",
    type: "custom-gateway",
    category: "gateway",
    defaultProfileName: "openai-compatible",
    description: "输入 OpenAI-compatible Chat Completions URL、模型和兼容性参数。",
    modelSummary: "Custom Chat Completions",
    tags: ["Gateway", "Manual"],
    sortOrder: 6
  },
  {
    id: "aicodemirror",
    label: "AICodeMirror",
    type: "api",
    category: "api",
    defaultProfileName: "aicodemirror",
    description: "AICodeMirror 中转站 Anthropic 端点。",
    modelSummary: "Claude Code default",
    tags: ["API", "Default Model"],
    sortOrder: 10,
    env: {
      ANTHROPIC_BASE_URL: "https://api.aicodemirror.com/api/claudecode"
    }
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    type: "api",
    category: "api",
    defaultProfileName: "deepseek",
    description: "DeepSeek 端点，配备长上下文主模型和 Flash 子代理。",
    modelSummary: "deepseek-v4-pro",
    tags: ["API", "1M", "Flash"],
    sortOrder: 20,
    env: {
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro[1M]",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-pro[1M]",
      ANTHROPIC_MODEL: "deepseek-v4-pro",
      CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-v4-flash"
    }
  },
  {
    id: "mimo",
    label: "Mimo",
    type: "api",
    category: "api",
    defaultProfileName: "mimo",
    description: "Mimo token-plan 端点，提供 1M Opus/Sonnet 模型槽位。",
    modelSummary: "mimo-v2.5-pro",
    tags: ["API", "1M"],
    sortOrder: 30,
    env: {
      ANTHROPIC_BASE_URL: "https://token-plan-cn.xiaomimimo.com/anthropic",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "mimo-v2.5-pro",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "mimo-v2.5-pro[1M]",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "mimo-v2.5-pro[1M]",
      ANTHROPIC_MODEL: "mimo-v2.5-pro",
      CLAUDE_CODE_SUBAGENT_MODEL: "mimo-v2.5-pro"
    }
  },
  {
    id: "custom-api",
    label: "Custom API",
    type: "custom-api",
    category: "custom",
    defaultProfileName: "custom-api",
    description: "手动输入 Anthropic 兼容端点和可选模型。",
    modelSummary: "Custom",
    tags: ["API", "Manual"],
    sortOrder: 90
  },
  {
    id: "ccr-gpt",
    label: "CCR GPT",
    type: "ccr",
    category: "ccr",
    defaultProfileName: "ccr-gpt",
    description: "CCR 预设配置，自动配置 AICodeMirror GPT 路由。",
    modelSummary: "aicodemirror,gpt-5.5",
    tags: ["CCR", "GPT", "Router"],
    sortOrder: 40,
    ccrPreset: "ccr-gpt",
    ccrRoute: "aicodemirror,gpt-5.5",
    tokenDefault: "ccr-local-secret",
    providerTemplate: {
      name: "aicodemirror",
      api_base_url: "https://api.aicodemirror.com/api/codex/backend-api/codex/v1/chat/completions",
      models: ["gpt-5.5"]
    }
  },
  {
    id: "manual-ccr",
    label: "Manual CCR",
    type: "manual-ccr",
    category: "custom",
    defaultProfileName: "ccr-profile",
    description: "手动选择或输入 CCR 路由。",
    modelSummary: "Manual route",
    tags: ["CCR", "Manual"],
    sortOrder: 100
  },
  {
    id: "login",
    label: "Claude Login",
    type: "login",
    category: "login",
    defaultProfileName: "login",
    description: "创建隔离的 Claude Code 账号登录配置。",
    modelSummary: "Claude account",
    tags: ["Login"],
    sortOrder: 110
  }
];

export function listProfilePresets(): BuiltinProfilePreset[] {
  return PROFILE_PRESETS.map((preset) => ({
    ...preset,
    ...(preset.type === "api" ? { env: { ...(preset as ApiProfilePreset).env } } : {}),
    ...(preset.type === "ccr" && preset.providerTemplate ? { providerTemplate: { ...preset.providerTemplate, models: [...preset.providerTemplate.models] } } : {}),
    ...(preset.type === "gateway" ? { compatibility: { ...preset.compatibility } } : {})
  }));
}

export function getProfilePreset(id: string): BuiltinProfilePreset {
  const preset = PROFILE_PRESETS.find((item) => item.id === id);
  if (!preset) {
    throw new CcpError(`Unknown profile preset '${id}'.`);
  }
  return preset;
}

export async function createApiProfileFromPreset(
  input: { presetId: string; name?: string; token: string },
  context: PathContext = {}
): Promise<ProfileSummary> {
  const preset = getProfilePreset(input.presetId);
  if (preset.type !== "api") {
    throw new CcpError(`Preset '${input.presetId}' is not an API preset.`);
  }

  const name = input.name?.trim() || preset.defaultProfileName;
  return createApiProfileFromEnv({
    name,
    preset: preset.id,
    env: {
      ...preset.env,
      ANTHROPIC_AUTH_TOKEN: input.token.trim() || "REPLACE_WITH_FULL_TOKEN"
    }
  }, context);
}

export async function createCcrProfileFromPreset(
  input: { presetId: string; name?: string; token?: string; providerApiKey?: string },
  context: PathContext = {}
): Promise<ProfileSummary> {
  const preset = getProfilePreset(input.presetId);
  if (preset.type !== "ccr") {
    throw new CcpError(`Preset '${input.presetId}' is not a CCR preset.`);
  }

  if (preset.providerTemplate) {
    await ensureCcrProviderTemplate(preset.providerTemplate, { apiKey: input.providerApiKey }, context);
  }

  return createCcrProfile({
    name: input.name?.trim() || preset.defaultProfileName,
    presetName: preset.ccrPreset,
    presetId: preset.id,
    route: preset.ccrRoute,
    token: input.token?.trim() || preset.tokenDefault || "ccr-local-secret"
  }, context);
}

export async function createGatewayProfileFromPreset(
  input: { presetId: string; name?: string; apiKey: string; model: string },
  context: PathContext = {}
): Promise<ProfileSummary> {
  const preset = getProfilePreset(input.presetId);
  if (preset.type !== "gateway") {
    throw new CcpError(`Preset '${input.presetId}' is not a gateway preset.`);
  }
  return createGatewayProfile({
    name: input.name?.trim() || preset.defaultProfileName,
    provider: preset.provider,
    chatCompletionsUrl: preset.chatCompletionsUrl,
    apiKey: input.apiKey,
    model: input.model,
    compatibility: preset.compatibility,
    preset: preset.id
  }, context);
}
