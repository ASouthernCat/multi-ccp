import { CcpError } from "./errors.js";
import type { GatewayCompatibility, GatewayProvider } from "./types.js";
import {
  MODERN_OPENAI_COMPATIBILITY,
  OPENAI_CHAT_COMPLETIONS_URL,
  OPENAI_GATEWAY_COMPATIBILITY
} from "../gateway/config.js";

export type GatewayUpstreamTemplateId =
  | "openai-official"
  | "xai-grok-4.5"
  | "aicodemirror"
  | "custom";

export interface GatewayUpstreamTemplate {
  id: GatewayUpstreamTemplateId;
  label: string;
  description: string;
  defaultUpstreamId: string;
  provider: GatewayProvider;
  chatCompletionsUrl: string;
  models: string[];
  compatibility: GatewayCompatibility;
  compatibilityMode: "openai" | "modern" | "advanced";
  sourceUrl?: string;
}

const XAI_GROK_45_COMPATIBILITY: GatewayCompatibility = {
  instructionRole: "system",
  maxTokensField: "max_completion_tokens",
  supportsStop: false,
  supportsSampling: true,
  parallelToolCalls: "supported",
  streamUsage: "include",
  reasoningEffort: "reasoning_effort",
  structuredOutput: "response_format"
};

const TEMPLATES: GatewayUpstreamTemplate[] = [
  {
    id: "openai-official",
    label: "OpenAI official",
    description: "Fixed official endpoint with the current GPT-5.6 model family.",
    defaultUpstreamId: "openai",
    provider: "openai",
    chatCompletionsUrl: OPENAI_CHAT_COMPLETIONS_URL,
    models: ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
    compatibility: OPENAI_GATEWAY_COMPATIBILITY,
    compatibilityMode: "openai",
    sourceUrl: "https://developers.openai.com/api/docs/guides/latest-model.md"
  },
  {
    id: "xai-grok-4.5",
    label: "xAI Grok 4.5",
    description: "xAI OpenAI-compatible Chat Completions endpoint for Grok 4.5.",
    defaultUpstreamId: "xai",
    provider: "openai-compatible",
    chatCompletionsUrl: "https://api.x.ai/v1/chat/completions",
    models: ["grok-4.5"],
    compatibility: XAI_GROK_45_COMPATIBILITY,
    compatibilityMode: "advanced",
    sourceUrl: "https://docs.x.ai/developers/model-capabilities/legacy/chat-completions"
  },
  {
    id: "aicodemirror",
    label: "AICodeMirror",
    description: "AICodeMirror Codex-compatible endpoint using the configured GPT model family.",
    defaultUpstreamId: "aicodemirror",
    provider: "openai-compatible",
    chatCompletionsUrl: "https://api.aicodemirror.com/api/codex/backend-api/codex/v1/chat/completions",
    models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5"],
    compatibility: MODERN_OPENAI_COMPATIBILITY,
    compatibilityMode: "modern"
  },
  {
    id: "custom",
    label: "Custom OpenAI-compatible",
    description: "Enter a custom OpenAI Chat Completions endpoint and model list.",
    defaultUpstreamId: "",
    provider: "openai-compatible",
    chatCompletionsUrl: "",
    models: [],
    compatibility: MODERN_OPENAI_COMPATIBILITY,
    compatibilityMode: "modern"
  }
];

function cloneTemplate(template: GatewayUpstreamTemplate): GatewayUpstreamTemplate {
  return {
    ...template,
    models: [...template.models],
    compatibility: { ...template.compatibility }
  };
}

export function listGatewayUpstreamTemplates(): GatewayUpstreamTemplate[] {
  return TEMPLATES.map(cloneTemplate);
}

export function getGatewayUpstreamTemplate(id: string): GatewayUpstreamTemplate {
  const template = TEMPLATES.find((item) => item.id === id);
  if (!template) throw new CcpError(`Unknown gateway upstream template '${id}'.`);
  return cloneTemplate(template);
}
