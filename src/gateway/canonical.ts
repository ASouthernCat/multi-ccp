import type { GatewayError } from "./errors.js";

export type CanonicalImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export type CanonicalImageSource =
  | { type: "base64"; mediaType: CanonicalImageMediaType; data: string }
  | { type: "url"; url: string };

export type CanonicalInputPart =
  | { type: "text"; text: string }
  | { type: "image"; source: CanonicalImageSource };

export type CanonicalToolResultContent = string | CanonicalInputPart[];

export type CanonicalContent =
  | CanonicalInputPart
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; content: CanonicalToolResultContent; isError?: boolean };

export interface CanonicalTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface CanonicalUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CanonicalMessage {
  role: "user" | "assistant";
  content: CanonicalContent[];
}

export interface CanonicalToolChoice {
  mode: "auto" | "required" | "none" | "tool";
  name?: string;
  disableParallelToolUse?: boolean;
}

export type CanonicalReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface CanonicalOutputFormat {
  type: "json_schema";
  schema: Record<string, unknown>;
}

export interface CanonicalOutputConfig {
  effort?: CanonicalReasoningEffort;
  format?: CanonicalOutputFormat;
}

export interface CanonicalRequest {
  clientModel: string;
  system: string[];
  messages: CanonicalMessage[];
  maxOutputTokens: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  tools?: CanonicalTool[];
  toolChoice?: CanonicalToolChoice;
  outputConfig?: CanonicalOutputConfig;
  stream: boolean;
}

export type CanonicalResponseContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

export type CanonicalFinishReason = "end_turn" | "tool_use" | "max_tokens";

export interface CanonicalResponse {
  id: string;
  model: string;
  content: CanonicalResponseContent[];
  finishReason: CanonicalFinishReason;
  usage: CanonicalUsage;
}

export interface ToolNameMapping {
  sourceToTarget: ReadonlyMap<string, string>;
  targetToSource: ReadonlyMap<string, string>;
}

export type CanonicalStreamEvent =
  | { type: "message_start"; id: string; model: string }
  | { type: "text_start"; blockKey: string }
  | { type: "text_delta"; blockKey: string; text: string }
  | { type: "tool_start"; blockKey: string; id: string; name: string }
  | { type: "tool_arguments_delta"; blockKey: string; partialJson: string }
  | { type: "block_stop"; blockKey: string }
  | { type: "usage"; usage: CanonicalUsage }
  | { type: "generated_image"; blockKey: string; path: string }
  | { type: "finish"; reason: CanonicalFinishReason }
  | { type: "error"; error: GatewayError };

export const EMPTY_TOOL_NAME_MAPPING: ToolNameMapping = {
  sourceToTarget: new Map(),
  targetToSource: new Map()
};
