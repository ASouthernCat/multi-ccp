import type { GatewayCompatibility } from "../core/types.js";
import type {
  CanonicalFinishReason,
  CanonicalImageSource,
  CanonicalInputPart,
  CanonicalMessage,
  CanonicalOutputFormat,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalResponseContent,
  CanonicalToolChoice,
  CanonicalToolResultContent,
  ToolNameMapping
} from "./canonical.js";
import { MODERN_OPENAI_COMPATIBILITY } from "./config.js";
import { invalidRequest, upstreamProtocolError } from "./errors.js";
import {
  isObject,
  requireObject,
  requireString,
  parseArguments,
  normalizeToolCallId,
  toAnthropicMessageId,
  normalizeStrictJsonSchema,
  createToolNameMapping,
  canonicalResponseToAnthropic,
  type JsonObject
} from "./utils.js";

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

function imageSourceToUrl(source: CanonicalImageSource): string {
  return source.type === "base64"
    ? `data:${source.mediaType};base64,${source.data}`
    : source.url;
}

function inputPartToChatContent(part: CanonicalInputPart): Record<string, unknown> {
  if (part.type === "text") {
    return { type: "text", text: part.text };
  }
  return {
    type: "image_url",
    image_url: {
      url: imageSourceToUrl(part.source),
      detail: "auto"
    }
  };
}

function toolResultContentToText(content: CanonicalToolResultContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is Extract<CanonicalInputPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function toolImageAttribution(toolUseId: string): Record<string, unknown> {
  return { type: "text", text: `Tool result ${toolUseId}:` };
}

function serializeUserMessage(message: CanonicalMessage): Array<Record<string, unknown>> {
  const toolMessages: Array<Record<string, unknown>> = [];
  const toolImageContent: Array<Record<string, unknown>> = [];
  const ordinaryContent: CanonicalInputPart[] = [];

  for (const block of message.content) {
    if (block.type === "tool_result") {
      const text = toolResultContentToText(block.content);
      toolMessages.push({
        role: "tool",
        tool_call_id: block.toolUseId,
        content: block.isError ? `Tool execution failed:\n${text}` : text
      });
      if (Array.isArray(block.content)) {
        const images = block.content.filter(
          (part): part is Extract<CanonicalInputPart, { type: "image" }> => part.type === "image"
        );
        if (images.length > 0) {
          toolImageContent.push(toolImageAttribution(block.toolUseId));
          toolImageContent.push(...images.map(inputPartToChatContent));
        }
      }
    } else if (block.type === "text" || block.type === "image") {
      ordinaryContent.push(block);
    } else {
      throw invalidRequest("tool_use is only valid in assistant messages.");
    }
  }

  if (toolImageContent.length > 0) {
    return [
      ...toolMessages,
      {
        role: "user",
        content: [...toolImageContent, ...ordinaryContent.map(inputPartToChatContent)]
      }
    ];
  }
  if (ordinaryContent.some((part) => part.type === "image")) {
    return [
      ...toolMessages,
      { role: "user", content: ordinaryContent.map(inputPartToChatContent) }
    ];
  }
  if (ordinaryContent.length > 0 || toolMessages.length === 0) {
    return [
      ...toolMessages,
      {
        role: "user",
        content: ordinaryContent
          .filter((part): part is Extract<CanonicalInputPart, { type: "text" }> => part.type === "text")
          .map((part) => part.text)
          .join("")
      }
    ];
  }
  return toolMessages;
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

export { canonicalResponseToAnthropic };
