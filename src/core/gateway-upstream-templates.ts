import { CcpError } from "./errors.js";
import type {
  GatewayProtocolCompatibility,
  GatewayProvider,
  GatewayUpstreamProtocol
} from "./types.js";
import {
  CUSTOM_RESPONSES_COMPATIBILITY,
  OPENAI_RESPONSES_COMPATIBILITY,
  OPENAI_RESPONSES_URL
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
  protocol: GatewayUpstreamProtocol;
  endpointUrl: string;
  models: string[];
  compatibility: GatewayProtocolCompatibility;
  compatibilityMode: "openai" | "responses" | "advanced";
  sourceUrl?: string;
}

const TEMPLATES: GatewayUpstreamTemplate[] = [
  {
    id: "openai-official",
    label: "OpenAI official",
    description: "Fixed official Responses endpoint with the current GPT-5.6 model family.",
    defaultUpstreamId: "openai",
    provider: "openai",
    protocol: "openai_responses",
    endpointUrl: OPENAI_RESPONSES_URL,
    models: ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
    compatibility: OPENAI_RESPONSES_COMPATIBILITY,
    compatibilityMode: "openai",
    sourceUrl: "https://developers.openai.com/api/docs/guides/latest-model.md"
  },
  {
    id: "xai-grok-4.5",
    label: "xAI Grok 4.5",
    description: "xAI OpenAI-compatible Responses endpoint for Grok 4.5.",
    defaultUpstreamId: "xai",
    provider: "openai-compatible",
    protocol: "openai_responses",
    endpointUrl: "https://api.x.ai/v1/responses",
    models: ["grok-4.5"],
    compatibility: CUSTOM_RESPONSES_COMPATIBILITY,
    compatibilityMode: "responses",
    sourceUrl: "https://docs.x.ai/developers/model-capabilities/text/generate-text"
  },
  {
    id: "aicodemirror",
    label: "AICodeMirror",
    description: "AICodeMirror Codex-compatible Responses endpoint using the configured GPT model family.",
    defaultUpstreamId: "aicodemirror",
    provider: "openai-compatible",
    protocol: "openai_responses",
    endpointUrl: "https://api.aicodemirror.com/api/codex/backend-api/codex/v1/responses",
    models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5"],
    compatibility: CUSTOM_RESPONSES_COMPATIBILITY,
    compatibilityMode: "responses"
  },
  {
    id: "custom",
    label: "Custom OpenAI-compatible",
    description: "Choose an OpenAI protocol, then enter a custom endpoint and model list.",
    defaultUpstreamId: "",
    provider: "openai-compatible",
    protocol: "openai_responses",
    endpointUrl: "",
    models: [],
    compatibility: CUSTOM_RESPONSES_COMPATIBILITY,
    compatibilityMode: "responses"
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
