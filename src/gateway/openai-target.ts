import { createHash } from "node:crypto";
import type { GatewayCompatibility } from "../core/types.js";
import type {
  CanonicalFinishReason,
  CanonicalMessage,
  CanonicalOutputFormat,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalResponseContent,
  CanonicalToolChoice,
  ToolNameMapping
} from "./canonical.js";
import { MODERN_OPENAI_COMPATIBILITY } from "./config.js";
import { invalidRequest, upstreamProtocolError } from "./errors.js";

type JsonObject = Record<string, unknown>;

export type OpenAICompatibility = GatewayCompatibility;

export const DEFAULT_OPENAI_COMPATIBILITY: OpenAICompatibility = {
  ...MODERN_OPENAI_COMPATIBILITY
};

export interface OpenAIChatRequestOptions {
  model: string;
  compatibility?: Partial<OpenAICompatibility>;
}

export interface OpenAIChatRequestConversion {
  body: Record<string, unknown>;
  toolNames: ToolNameMapping;
}

export interface OpenAIChatResponseOptions {
  toolNames?: ToolNameMapping;
  modelFallback?: string;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function targetToolNameCandidate(sourceName: string): string {
  const hash = digest(sourceName);
  const replaced = sourceName.replace(/[^A-Za-z0-9_-]/g, "_") || "tool";
  if (replaced.length <= 64) {
    return replaced;
  }
  return `${replaced.slice(0, 55)}_${hash.slice(0, 8)}`;
}

function withCollisionSuffix(base: string, sourceName: string, used: ReadonlySet<string>): string {
  const hash = digest(sourceName);
  for (let hashLength = 8; hashLength <= 62; hashLength += 2) {
    const suffix = `_${hash.slice(0, hashLength)}`;
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
  throw invalidRequest(`tools: Unable to create a unique target name for '${sourceName}'.`);
}

export function createToolNameMapping(sourceNames: Iterable<string>): ToolNameMapping {
  const sourceToTarget = new Map<string, string>();
  const targetToSource = new Map<string, string>();

  for (const sourceName of sourceNames) {
    if (sourceToTarget.has(sourceName)) {
      continue;
    }
    let targetName = targetToolNameCandidate(sourceName);
    const existingSource = targetToSource.get(targetName);
    if (existingSource !== undefined && existingSource !== sourceName) {
      targetName = withCollisionSuffix(targetName, sourceName, new Set(targetToSource.keys()));
    }
    sourceToTarget.set(sourceName, targetName);
    targetToSource.set(targetName, sourceName);
  }

  return { sourceToTarget, targetToSource };
}

export function normalizeToolCallId(sourceId: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(sourceId)) {
    return sourceId;
  }
  const replaced = sourceId.replace(/[^A-Za-z0-9_-]/g, "_") || "call";
  return `${replaced}_${digest(sourceId).slice(0, 8)}`;
}

export function toAnthropicMessageId(sourceId: string): string {
  const base = sourceId.startsWith("msg_") ? sourceId : `msg_${sourceId}`;
  return normalizeToolCallId(base);
}

export function mapOpenAIFinishReason(value: unknown): CanonicalFinishReason {
  if (value === "stop" || value === "content_filter") {
    return "end_turn";
  }
  if (value === "tool_calls" || value === "function_call") {
    return "tool_use";
  }
  if (value === "length") {
    return "max_tokens";
  }
  throw upstreamProtocolError(`Upstream finish_reason '${String(value)}' is not supported.`);
}

function collectToolNames(request: CanonicalRequest): string[] {
  const names = request.tools?.map((tool) => tool.name) ?? [];
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type === "tool_use") {
        names.push(block.name);
      }
    }
  }
  return names;
}

function requireTargetToolName(mapping: ToolNameMapping, sourceName: string): string {
  const targetName = mapping.sourceToTarget.get(sourceName);
  if (!targetName) {
    throw invalidRequest(`Tool name '${sourceName}' has no request-local target mapping.`);
  }
  return targetName;
}

function serializeUserMessage(message: CanonicalMessage): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  const text: string[] = [];
  let textSeen = false;

  for (const block of message.content) {
    if (block.type === "tool_result") {
      if (textSeen) {
        throw invalidRequest("tool_result blocks must appear before text blocks.");
      }
      result.push({
        role: "tool",
        tool_call_id: block.toolUseId,
        content: block.isError ? `Tool execution failed:\n${block.content}` : block.content
      });
    } else if (block.type === "text") {
      textSeen = true;
      text.push(block.text);
    } else {
      throw invalidRequest("tool_use is only valid in assistant messages.");
    }
  }

  if (text.length > 0 || result.length === 0) {
    result.push({ role: "user", content: text.join("") });
  }
  return result;
}

function serializeAssistantMessage(message: CanonicalMessage, mapping: ToolNameMapping): Record<string, unknown> {
  const text: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  let toolUseSeen = false;

  for (const block of message.content) {
    if (block.type === "text") {
      if (toolUseSeen) {
        throw invalidRequest("text blocks after tool_use cannot be represented by OpenAI Chat Completions.");
      }
      text.push(block.text);
    } else if (block.type === "tool_use") {
      toolUseSeen = true;
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: requireTargetToolName(mapping, block.name),
          arguments: JSON.stringify(block.input)
        }
      });
    } else {
      throw invalidRequest("tool_result is only valid in user messages.");
    }
  }

  return {
    role: "assistant",
    content: text.length > 0 ? text.join("") : null,
    ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls })
  };
}

function serializeMessages(request: CanonicalRequest, mapping: ToolNameMapping, instructionRole: "system" | "developer") {
  const messages: Array<Record<string, unknown>> = [];
  if (request.system.length > 0) {
    messages.push({ role: instructionRole, content: request.system.join("\n") });
  }
  for (const message of request.messages) {
    if (message.role === "user") {
      messages.push(...serializeUserMessage(message));
    } else {
      messages.push(serializeAssistantMessage(message, mapping));
    }
  }
  return messages;
}

function serializeToolChoice(choice: CanonicalToolChoice, mapping: ToolNameMapping): unknown {
  if (choice.mode === "auto" || choice.mode === "required" || choice.mode === "none") {
    return choice.mode;
  }
  if (!choice.name) {
    throw invalidRequest("tool_choice.name: Field required when type is tool.");
  }
  return {
    type: "function",
    function: { name: requireTargetToolName(mapping, choice.name) }
  };
}

function normalizeStrictJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeStrictJsonSchema);
  }
  if (!isObject(value)) {
    return value;
  }

  const result: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = normalizeStrictJsonSchema(entry);
  }
  if (result.type === "object" && isObject(result.properties)) {
    result.additionalProperties = false;
    result.required = Object.keys(result.properties);
  }
  return result;
}

function toOpenAIResponseFormat(format: CanonicalOutputFormat): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: {
      name: "structured_output",
      schema: normalizeStrictJsonSchema(format.schema),
      strict: true
    }
  };
}

function applyOutputConfig(
  body: Record<string, unknown>,
  request: CanonicalRequest,
  compatibility: OpenAICompatibility
): void {
  const outputConfig = request.outputConfig;
  if (!outputConfig) {
    return;
  }

  const targetOutputConfig: Record<string, unknown> = {};
  if (outputConfig.effort !== undefined) {
    if (compatibility.reasoningEffort === "reasoning_effort") {
      body.reasoning_effort = outputConfig.effort;
    } else if (compatibility.reasoningEffort === "output_config") {
      targetOutputConfig.effort = outputConfig.effort;
    }
  }

  if (outputConfig.format !== undefined) {
    if (compatibility.structuredOutput === "response_format") {
      body.response_format = toOpenAIResponseFormat(outputConfig.format);
    } else if (compatibility.structuredOutput === "output_config") {
      targetOutputConfig.format = outputConfig.format;
    } else {
      throw invalidRequest(
        "output_config.format: The selected upstream does not support structured outputs."
      );
    }
  }

  if (Object.keys(targetOutputConfig).length > 0) {
    body.output_config = targetOutputConfig;
  }
}

export function serializeOpenAIChatRequest(
  request: CanonicalRequest,
  options: OpenAIChatRequestOptions
): OpenAIChatRequestConversion {
  if (!options.model) {
    throw invalidRequest("gateway.model: Expected a non-empty string.");
  }
  const compatibility: OpenAICompatibility = {
    ...DEFAULT_OPENAI_COMPATIBILITY,
    ...options.compatibility
  };
  const toolNames = createToolNameMapping(collectToolNames(request));
  const body: Record<string, unknown> = {
    model: options.model,
    messages: serializeMessages(request, toolNames, compatibility.instructionRole),
    n: 1,
    stream: request.stream,
    [compatibility.maxTokensField]: request.maxOutputTokens
  };

  if (compatibility.supportsSampling) {
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.topP !== undefined) body.top_p = request.topP;
  }
  if (compatibility.supportsStop && request.stop !== undefined) {
    body.stop = request.stop;
  }
  if (request.tools !== undefined && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: requireTargetToolName(toolNames, tool.name),
        ...(tool.description === undefined ? {} : { description: tool.description }),
        parameters: tool.inputSchema
      }
    }));
    if (request.toolChoice) {
      body.tool_choice = serializeToolChoice(request.toolChoice, toolNames);
    }
    if (compatibility.parallelToolCalls === "supported") {
      body.parallel_tool_calls = request.toolChoice?.disableParallelToolUse === true ? false : true;
    } else if (request.toolChoice?.disableParallelToolUse === true) {
      throw invalidRequest(
        "tool_choice.disable_parallel_tool_use: The selected upstream does not support parallel_tool_calls."
      );
    }
  }
  if (request.stream && compatibility.streamUsage === "include") {
    body.stream_options = { include_usage: true };
  }
  applyOutputConfig(body, request, compatibility);

  return { body, toolNames };
}

function requireObject(value: unknown, path: string): JsonObject {
  if (!isObject(value)) {
    throw upstreamProtocolError(`${path}: Expected an object in the upstream response.`);
  }
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw upstreamProtocolError(`${path}: Expected a non-empty string in the upstream response.`);
  }
  return value;
}

function parseArguments(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "string") {
    throw upstreamProtocolError(`${path}: Expected a JSON string.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw upstreamProtocolError(`${path}: Invalid JSON object.`, { cause: error });
  }
  if (!isObject(parsed)) {
    throw upstreamProtocolError(`${path}: Expected a JSON object.`);
  }
  return parsed;
}

function parseUsage(value: unknown) {
  if (!isObject(value)) {
    return { inputTokens: 0, outputTokens: 0 };
  }
  const inputTokens = Number.isSafeInteger(value.prompt_tokens) && (value.prompt_tokens as number) >= 0
    ? value.prompt_tokens as number
    : 0;
  const outputTokens = Number.isSafeInteger(value.completion_tokens) && (value.completion_tokens as number) >= 0
    ? value.completion_tokens as number
    : 0;
  return { inputTokens, outputTokens };
}

function parseToolCall(
  value: unknown,
  path: string,
  mapping: ToolNameMapping
): CanonicalResponseContent {
  const call = requireObject(value, path);
  if (call.type !== undefined && call.type !== "function") {
    throw upstreamProtocolError(`${path}.type: Only function tool calls are supported.`);
  }
  const fn = requireObject(call.function, `${path}.function`);
  const targetName = requireString(fn.name, `${path}.function.name`);
  return {
    type: "tool_use",
    id: normalizeToolCallId(requireString(call.id, `${path}.id`)),
    name: mapping.targetToSource.get(targetName) ?? targetName,
    input: parseArguments(fn.arguments, `${path}.function.arguments`)
  };
}

export function parseOpenAIChatResponse(input: unknown, options: OpenAIChatResponseOptions = {}): CanonicalResponse {
  const response = requireObject(input, "response");
  if (!Array.isArray(response.choices) || response.choices.length === 0) {
    throw upstreamProtocolError("response.choices: Expected a non-empty array.");
  }
  const choice = requireObject(response.choices[0], "response.choices[0]");
  const message = requireObject(choice.message, "response.choices[0].message");
  const content: CanonicalResponseContent[] = [];

  if (message.content !== null && message.content !== undefined) {
    if (typeof message.content !== "string") {
      throw upstreamProtocolError("response.choices[0].message.content: Expected a string or null.");
    }
    if (message.content.length > 0) {
      content.push({ type: "text", text: message.content });
    }
  }
  if (typeof message.refusal === "string" && message.refusal.length > 0) {
    content.push({ type: "text", text: message.refusal });
  }

  const mapping = options.toolNames ?? { sourceToTarget: new Map(), targetToSource: new Map() };
  if (message.tool_calls !== undefined && message.tool_calls !== null) {
    if (!Array.isArray(message.tool_calls)) {
      throw upstreamProtocolError("response.choices[0].message.tool_calls: Expected an array.");
    }
    message.tool_calls.forEach((call, index) => {
      content.push(parseToolCall(call, `response.choices[0].message.tool_calls[${index}]`, mapping));
    });
  } else if (message.function_call !== undefined && message.function_call !== null) {
    content.push(parseToolCall(
      { id: `call_${String(response.id ?? "legacy")}`, type: "function", function: message.function_call },
      "response.choices[0].message.function_call",
      mapping
    ));
  }

  const responseId = requireString(response.id, "response.id");
  const responseModel = typeof response.model === "string" && response.model.length > 0
    ? response.model
    : options.modelFallback;
  if (!responseModel) {
    throw upstreamProtocolError("response.model: Expected a non-empty string.");
  }

  return {
    id: toAnthropicMessageId(responseId),
    model: responseModel,
    content,
    finishReason: mapOpenAIFinishReason(choice.finish_reason),
    usage: parseUsage(response.usage)
  };
}

export function canonicalResponseToAnthropic(response: CanonicalResponse): Record<string, unknown> {
  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model: response.model,
    content: response.content.map((block) => block.type === "text"
      ? { type: "text", text: block.text }
      : { type: "tool_use", id: block.id, name: block.name, input: block.input }),
    stop_reason: response.finishReason,
    stop_sequence: null,
    usage: {
      input_tokens: response.usage.inputTokens,
      output_tokens: response.usage.outputTokens
    }
  };
}
