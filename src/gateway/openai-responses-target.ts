import type { GatewayResponsesCompatibility } from "../core/types.js";
import type {
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalResponseContent,
  CanonicalToolChoice,
  CanonicalToolResultContent,
  ToolNameMapping
} from "./canonical.js";
import { OPENAI_RESPONSES_COMPATIBILITY } from "./config.js";
import { invalidRequest, upstreamProtocolError } from "./errors.js";
import {
  canonicalResponseToAnthropic,
  createToolNameMapping,
  normalizeStrictJsonSchema,
  normalizeToolCallId,
  toAnthropicMessageId,
  isObject,
  requireObject,
  requireString,
  parseArguments,
  type JsonObject
} from "./utils.js";

export interface OpenAIResponsesRequestOptions {
  model: string;
  compatibility?: Partial<GatewayResponsesCompatibility>;
}

export interface OpenAIResponsesRequestConversion {
  body: Record<string, unknown>;
  toolNames: ToolNameMapping;
}

export interface OpenAIResponsesResponseOptions {
  toolNames?: ToolNameMapping;
  modelFallback?: string;
}

export interface OpenAIResponsesParsedResponse {
  response: CanonicalResponse;
  upstreamItemTypes: string[];
}

function collectToolNames(request: CanonicalRequest): string[] {
  const names = request.tools?.map((tool) => tool.name) ?? [];
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type === "tool_use") names.push(block.name);
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

function toolResultContentToText(content: CanonicalToolResultContent): string {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") return part.text;
    if (part.source.type === "base64") return `[Image: ${part.source.mediaType}]`;
    return `[Image: ${part.source.url}]`;
  }).join("");
}

function serializeMessage(message: CanonicalMessage, mapping: ToolNameMapping): Array<Record<string, unknown>> {
  const text: string[] = [];
  const result: Array<Record<string, unknown>> = [];

  for (const block of message.content) {
    if (block.type === "text") {
      text.push(block.text);
      continue;
    }
    if (block.type === "tool_result") {
      result.push({
        type: "function_call_output",
        call_id: normalizeToolCallId(block.toolUseId),
        output: block.isError
          ? `Tool execution failed:\n${toolResultContentToText(block.content)}`
          : toolResultContentToText(block.content)
      });
      continue;
    }
    if (block.type === "tool_use") {
      result.push({
        type: "function_call",
        call_id: normalizeToolCallId(block.id),
        name: requireTargetToolName(mapping, block.name),
        arguments: JSON.stringify(block.input)
      });
      continue;
    }
  }

  if (text.length > 0) {
    const textMessage = {
      type: "message",
      role: message.role,
      content: [{
        type: message.role === "user" ? "input_text" : "output_text",
        text: text.join("")
      }]
    };
    if (message.role === "assistant") result.unshift(textMessage);
    else result.push(textMessage);
  }
  return result;
}

function serializeInput(request: CanonicalRequest, mapping: ToolNameMapping): Array<Record<string, unknown>> {
  return request.messages.flatMap((message) => serializeMessage(message, mapping));
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
    name: requireTargetToolName(mapping, choice.name)
  };
}

function applyOutputConfig(
  body: Record<string, unknown>,
  request: CanonicalRequest,
  compatibility: GatewayResponsesCompatibility
): void {
  const outputConfig = request.outputConfig;
  if (!outputConfig) return;

  if (outputConfig.effort !== undefined) {
    if (compatibility.reasoningEffort === "reasoning.effort") {
      body.reasoning = { effort: outputConfig.effort };
    }
  }
  if (outputConfig.format !== undefined) {
    if (compatibility.structuredOutput !== "text.format") {
      throw invalidRequest("output_config.format: The selected upstream does not support structured outputs.");
    }
    body.text = {
      format: {
        type: "json_schema",
        name: "structured_output",
        schema: normalizeStrictJsonSchema(outputConfig.format.schema),
        strict: true
      }
    };
  }
}

export function serializeOpenAIResponsesRequest(
  request: CanonicalRequest,
  options: OpenAIResponsesRequestOptions
): OpenAIResponsesRequestConversion {
  if (!options.model) {
    throw invalidRequest("gateway.model: Expected a non-empty string.");
  }
  const compatibility: GatewayResponsesCompatibility = {
    ...OPENAI_RESPONSES_COMPATIBILITY,
    ...options.compatibility,
    protocol: "openai_responses"
  };
  const toolNames = createToolNameMapping(collectToolNames(request));
  const instructions = request.system.join("\n");
  const body: Record<string, unknown> = {
    model: options.model,
    ...(instructions.length === 0 ? {} : { [compatibility.instructions]: instructions }),
    input: serializeInput(request, toolNames),
    [compatibility.maxOutputTokens]: request.maxOutputTokens,
    stream: request.stream,
    store: false
  };

  if (compatibility.supportsSampling) {
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.topP !== undefined) body.top_p = request.topP;
  }
  if (request.tools !== undefined && request.tools.length > 0) {
    // OpenAI docs: strict:true requires every object property to be required and
    // additionalProperties:false, otherwise the request is rejected. Claude Code
    // tools routinely leave optional fields out of required[], so non-strict is
    // the safe default for Anthropic→Responses translation.
    const useStrictTools = compatibility.toolStrict === "strict";
    body.tools = request.tools.map((tool) => ({
      type: "function",
      name: requireTargetToolName(toolNames, tool.name),
      ...(tool.description === undefined ? {} : { description: tool.description }),
      parameters: useStrictTools
        ? normalizeStrictJsonSchema(tool.inputSchema)
        : tool.inputSchema,
      strict: useStrictTools
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
  applyOutputConfig(body, request, compatibility);
  return { body, toolNames };
}

function parseUsage(value: unknown): { inputTokens: number; outputTokens: number } {
  if (value === undefined) return { inputTokens: 0, outputTokens: 0 };
  const usage = requireObject(value, "response.usage");
  const parse = (field: string): number => {
    if (usage[field] === undefined) return 0;
    if (!Number.isSafeInteger(usage[field]) || (usage[field] as number) < 0) {
      throw upstreamProtocolError(`response.usage.${field}: Expected a non-negative safe integer.`);
    }
    return usage[field] as number;
  };
  return { inputTokens: parse("input_tokens"), outputTokens: parse("output_tokens") };
}

function parseMessageContent(
  item: JsonObject,
  path: string,
  content: CanonicalResponseContent[]
): void {
  if (!Array.isArray(item.content)) {
    throw upstreamProtocolError(`${path}.content: Expected an array.`);
  }
  item.content.forEach((part, index) => {
    const partPath = `${path}.content[${index}]`;
    const value = requireObject(part, partPath);
    if (value.type === "output_text") {
      if (typeof value.text !== "string") {
        throw upstreamProtocolError(`${partPath}.text: Expected a string in the upstream response.`);
      }
      if (value.text.length > 0) content.push({ type: "text", text: value.text });
      return;
    }
    if (value.type === "refusal") {
      if (typeof value.refusal !== "string") {
        throw upstreamProtocolError(`${partPath}.refusal: Expected a string in the upstream response.`);
      }
      if (value.refusal.length > 0) content.push({ type: "text", text: value.refusal });
      return;
    }
    throw upstreamProtocolError(`${partPath}.type: Unsupported message content type '${String(value.type)}'.`);
  });
}

function parseResponseInternal(
  input: unknown,
  options: OpenAIResponsesResponseOptions
): OpenAIResponsesParsedResponse {
  const response = requireObject(input, "response");
  if (!Array.isArray(response.output)) {
    throw upstreamProtocolError("response.output: Expected an array.");
  }
  const content: CanonicalResponseContent[] = [];
  const upstreamItemTypes: string[] = [];
  const seenTypes = new Set<string>();
  const mapping = options.toolNames ?? { sourceToTarget: new Map(), targetToSource: new Map() };

  response.output.forEach((value, index) => {
    const path = `response.output[${index}]`;
    const item = requireObject(value, path);
    const type = requireString(item.type, `${path}.type`);
    if (!seenTypes.has(type)) {
      seenTypes.add(type);
      upstreamItemTypes.push(type);
    }
    if (type === "message") {
      parseMessageContent(item, path, content);
      return;
    }
    if (type === "function_call") {
      const targetName = requireString(item.name, `${path}.name`);
      content.push({
        type: "tool_use",
        id: normalizeToolCallId(requireString(item.call_id, `${path}.call_id`)),
        name: mapping.targetToSource.get(targetName) ?? targetName,
        input: parseArguments(item.arguments, `${path}.arguments`)
      });
      return;
    }
    if (type === "reasoning") return;
    throw upstreamProtocolError(`${path}.type: Unsupported output item type '${type}'.`);
  });

  const status = requireString(response.status, "response.status");
  let finishReason: CanonicalResponse["finishReason"];
  if (status === "failed" || status === "cancelled") {
    const error = isObject(response.error) && typeof response.error.message === "string"
      ? response.error.message
      : `Upstream Responses response ${status}.`;
    throw upstreamProtocolError(error);
  }
  if (status === "incomplete") {
    const details = isObject(response.incomplete_details) ? response.incomplete_details : undefined;
    if (details?.reason === "max_output_tokens") {
      finishReason = "max_tokens";
    } else {
      throw upstreamProtocolError(
        `Upstream Responses response is incomplete${details?.reason ? ` (${String(details.reason)})` : ""}.`
      );
    }
  } else if (status === "completed") {
    finishReason = content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn";
  } else {
    throw upstreamProtocolError(`response.status: Unsupported status '${status}'.`);
  }

  if (content.length === 0) {
    throw upstreamProtocolError("response.output: No representable output content was returned.");
  }
  const responseId = requireString(response.id, "response.id");
  const model = typeof response.model === "string" && response.model.length > 0
    ? response.model
    : options.modelFallback;
  if (!model) throw upstreamProtocolError("response.model: Expected a non-empty string.");

  return {
    response: {
      id: toAnthropicMessageId(responseId),
      model,
      content,
      finishReason,
      usage: parseUsage(response.usage)
    },
    upstreamItemTypes
  };
}

export function parseOpenAIResponsesResponseWithMetadata(
  input: unknown,
  options: OpenAIResponsesResponseOptions = {}
): OpenAIResponsesParsedResponse {
  return parseResponseInternal(input, options);
}

export function parseOpenAIResponsesResponse(
  input: unknown,
  options: OpenAIResponsesResponseOptions = {}
): CanonicalResponse {
  return parseResponseInternal(input, options).response;
}

export { canonicalResponseToAnthropic };
