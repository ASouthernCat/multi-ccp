import type {
  CanonicalContent,
  CanonicalMessage,
  CanonicalOutputConfig,
  CanonicalOutputFormat,
  CanonicalReasoningEffort,
  CanonicalRequest,
  CanonicalTool,
  CanonicalToolChoice
} from "./canonical.js";
import { invalidRequest } from "./errors.js";

type JsonObject = Record<string, unknown>;

const TOP_LEVEL_FIELDS = new Set([
  "model",
  "system",
  "messages",
  "max_tokens",
  "temperature",
  "top_p",
  "stop_sequences",
  "stream",
  "tools",
  "tool_choice",
  "output_config",
  "metadata"
]);

const UNSUPPORTED_TOP_LEVEL_FIELDS = new Set([
  "context_management",
  "top_k",
  "container",
  "mcp_servers",
  "service_tier"
]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, path: string): JsonObject {
  if (!isObject(value)) {
    throw invalidRequest(`${path}: Expected an object.`);
  }
  return value;
}

function requireString(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw invalidRequest(`${path}: Expected ${allowEmpty ? "a string" : "a non-empty string"}.`);
  }
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw invalidRequest(`${path}: Expected a boolean.`);
  }
  return value;
}

function rejectExtraFields(value: JsonObject, allowed: ReadonlySet<string>, path = ""): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalidRequest(`${path}${key}: Extra inputs are not permitted`);
    }
  }
}

function validateCacheControl(value: unknown, path: string): void {
  if (!isObject(value)) {
    throw invalidRequest(`${path}: Expected an object.`);
  }
}

function parseSystem(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    return [value];
  }
  if (!Array.isArray(value)) {
    throw invalidRequest("system: Expected a string or an array of text blocks.");
  }

  return value.map((entry, index) => {
    const path = `system[${index}]`;
    const block = requireObject(entry, path);
    rejectExtraFields(block, new Set(["type", "text", "cache_control"]), `${path}.`);
    if (block.type !== "text") {
      throw invalidRequest(`${path}.type: Only text system blocks are supported.`);
    }
    if (block.cache_control !== undefined) {
      validateCacheControl(block.cache_control, `${path}.cache_control`);
    }
    return requireString(block.text, `${path}.text`, true);
  });
}

function parseTextBlock(block: JsonObject, path: string): CanonicalContent {
  rejectExtraFields(block, new Set(["type", "text", "cache_control"]), `${path}.`);
  if (block.cache_control !== undefined) {
    validateCacheControl(block.cache_control, `${path}.cache_control`);
  }
  return { type: "text", text: requireString(block.text, `${path}.text`, true) };
}

function parseToolUseBlock(block: JsonObject, path: string): CanonicalContent {
  rejectExtraFields(block, new Set(["type", "id", "name", "input", "cache_control"]), `${path}.`);
  if (block.cache_control !== undefined) {
    validateCacheControl(block.cache_control, `${path}.cache_control`);
  }
  return {
    type: "tool_use",
    id: requireString(block.id, `${path}.id`),
    name: requireString(block.name, `${path}.name`),
    input: requireObject(block.input, `${path}.input`)
  };
}

function parseToolResultContent(value: unknown, path: string): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    throw invalidRequest(`${path}: Expected a string or an array of text blocks.`);
  }

  return value.map((entry, index) => {
    const blockPath = `${path}[${index}]`;
    const block = requireObject(entry, blockPath);
    rejectExtraFields(block, new Set(["type", "text", "cache_control"]), `${blockPath}.`);
    if (block.type !== "text") {
      throw invalidRequest(`${blockPath}.type: Only text tool_result content is supported.`);
    }
    if (block.cache_control !== undefined) {
      validateCacheControl(block.cache_control, `${blockPath}.cache_control`);
    }
    return requireString(block.text, `${blockPath}.text`, true);
  }).join("");
}

function parseToolResultBlock(block: JsonObject, path: string): CanonicalContent {
  rejectExtraFields(
    block,
    new Set(["type", "tool_use_id", "content", "is_error", "cache_control"]),
    `${path}.`
  );
  if (block.cache_control !== undefined) {
    validateCacheControl(block.cache_control, `${path}.cache_control`);
  }
  if (!("content" in block)) {
    throw invalidRequest(`${path}.content: Field required.`);
  }
  return {
    type: "tool_result",
    toolUseId: requireString(block.tool_use_id, `${path}.tool_use_id`),
    content: parseToolResultContent(block.content, `${path}.content`),
    ...(block.is_error === undefined ? {} : { isError: requireBoolean(block.is_error, `${path}.is_error`) })
  };
}

function parseMessageContent(value: unknown, role: CanonicalMessage["role"], path: string): CanonicalContent[] {
  if (typeof value === "string") {
    return [{ type: "text", text: value }];
  }
  if (!Array.isArray(value)) {
    throw invalidRequest(`${path}: Expected a string or an array of content blocks.`);
  }

  const result: CanonicalContent[] = [];
  let textSeen = false;
  let toolUseSeen = false;

  for (let index = 0; index < value.length; index += 1) {
    const blockPath = `${path}[${index}]`;
    const block = requireObject(value[index], blockPath);
    const type = requireString(block.type, `${blockPath}.type`);

    if (type === "text") {
      if (role === "assistant" && toolUseSeen) {
        throw invalidRequest(`${blockPath}: text blocks after tool_use cannot be represented by OpenAI Chat Completions.`);
      }
      textSeen = true;
      result.push(parseTextBlock(block, blockPath));
      continue;
    }

    if (type === "tool_use") {
      if (role !== "assistant") {
        throw invalidRequest(`${blockPath}.type: tool_use is only valid in assistant messages.`);
      }
      toolUseSeen = true;
      result.push(parseToolUseBlock(block, blockPath));
      continue;
    }

    if (type === "tool_result") {
      if (role !== "user") {
        throw invalidRequest(`${blockPath}.type: tool_result is only valid in user messages.`);
      }
      if (textSeen) {
        throw invalidRequest(`${blockPath}: tool_result blocks must appear before text blocks.`);
      }
      result.push(parseToolResultBlock(block, blockPath));
      continue;
    }

    throw invalidRequest(`${blockPath}.type: ${type} content blocks are not supported by this gateway profile.`);
  }

  return result;
}

function parseMessages(value: unknown): { messages: CanonicalMessage[]; instructions: string[] } {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidRequest("messages: Expected a non-empty array.");
  }

  const messages: CanonicalMessage[] = [];
  const instructions: string[] = [];
  value.forEach((entry, index) => {
    const path = `messages[${index}]`;
    const message = requireObject(entry, path);
    rejectExtraFields(message, new Set(["role", "content"]), `${path}.`);
    if (message.role === "system" || message.role === "developer") {
      if (!("content" in message)) {
        throw invalidRequest(`${path}.content: Field required.`);
      }
      instructions.push(...parseSystem(message.content));
      return;
    }
    if (message.role !== "user" && message.role !== "assistant") {
      throw invalidRequest(`${path}.role: Expected user or assistant, received '${String(message.role)}'.`);
    }
    if (!("content" in message)) {
      throw invalidRequest(`${path}.content: Field required.`);
    }
    messages.push({
      role: message.role,
      content: parseMessageContent(message.content, message.role, `${path}.content`)
    });
  });
  return { messages, instructions };
}

function parseTools(value: unknown): CanonicalTool[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw invalidRequest("tools: Expected an array.");
  }

  const names = new Set<string>();
  return value.map((entry, index) => {
    const path = `tools[${index}]`;
    const tool = requireObject(entry, path);
    rejectExtraFields(tool, new Set(["name", "description", "input_schema", "cache_control"]), `${path}.`);
    if (tool.cache_control !== undefined) {
      validateCacheControl(tool.cache_control, `${path}.cache_control`);
    }
    const name = requireString(tool.name, `${path}.name`);
    if (names.has(name)) {
      throw invalidRequest(`${path}.name: Duplicate tool name '${name}'.`);
    }
    names.add(name);
    const description = tool.description === undefined
      ? undefined
      : requireString(tool.description, `${path}.description`, true);
    return {
      name,
      ...(description === undefined ? {} : { description }),
      inputSchema: requireObject(tool.input_schema, `${path}.input_schema`)
    };
  });
}

function parseToolChoice(value: unknown): CanonicalToolChoice | undefined {
  if (value === undefined) {
    return undefined;
  }
  const choice = requireObject(value, "tool_choice");
  rejectExtraFields(choice, new Set(["type", "name", "disable_parallel_tool_use"]), "tool_choice.");
  const type = requireString(choice.type, "tool_choice.type");
  const disableParallelToolUse = choice.disable_parallel_tool_use === undefined
    ? undefined
    : requireBoolean(choice.disable_parallel_tool_use, "tool_choice.disable_parallel_tool_use");

  if (type === "auto" || type === "none") {
    if (choice.name !== undefined) {
      throw invalidRequest("tool_choice.name: Extra inputs are not permitted");
    }
    return { mode: type, ...(disableParallelToolUse === undefined ? {} : { disableParallelToolUse }) };
  }
  if (type === "any") {
    if (choice.name !== undefined) {
      throw invalidRequest("tool_choice.name: Extra inputs are not permitted");
    }
    return { mode: "required", ...(disableParallelToolUse === undefined ? {} : { disableParallelToolUse }) };
  }
  if (type === "tool") {
    return {
      mode: "tool",
      name: requireString(choice.name, "tool_choice.name"),
      ...(disableParallelToolUse === undefined ? {} : { disableParallelToolUse })
    };
  }

  throw invalidRequest(`tool_choice.type: Unsupported value '${type}'.`);
}

function parseOptionalSamplingNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw invalidRequest(`${path}: Expected a finite number between 0 and 1.`);
  }
  return value;
}

function parseStopSequences(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw invalidRequest("stop_sequences: Expected an array of strings.");
  }
  return [...value] as string[];
}

const REASONING_EFFORTS = new Set<CanonicalReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);

function parseOutputFormat(value: unknown): CanonicalOutputFormat {
  const format = requireObject(value, "output_config.format");
  rejectExtraFields(format, new Set(["type", "schema"]), "output_config.format.");
  if (format.type !== "json_schema") {
    throw invalidRequest(`output_config.format.type: Unsupported value '${String(format.type)}'.`);
  }
  return {
    type: "json_schema",
    schema: requireObject(format.schema, "output_config.format.schema")
  };
}

function parseOutputConfig(value: unknown): CanonicalOutputConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  const outputConfig = requireObject(value, "output_config");
  rejectExtraFields(outputConfig, new Set(["effort", "format"]), "output_config.");

  let effort: CanonicalReasoningEffort | undefined;
  if (outputConfig.effort !== undefined) {
    const parsed = requireString(outputConfig.effort, "output_config.effort") as CanonicalReasoningEffort;
    if (!REASONING_EFFORTS.has(parsed)) {
      throw invalidRequest(`output_config.effort: Unsupported value '${parsed}'.`);
    }
    effort = parsed;
  }
  const format = outputConfig.format === undefined ? undefined : parseOutputFormat(outputConfig.format);
  return {
    ...(effort === undefined ? {} : { effort }),
    ...(format === undefined ? {} : { format })
  };
}

export function parseAnthropicMessagesRequest(input: unknown): CanonicalRequest {
  const request = requireObject(input, "request");

  if ("thinking" in request) {
    const thinking = request.thinking;
    const type = isObject(thinking) && typeof thinking.type === "string" ? thinking.type : "unknown";
    throw invalidRequest(
      `thinking.type: ${type === "adaptive" ? "adaptive thinking" : "thinking"} is not supported by this gateway profile; Extra inputs are not permitted`
    );
  }
  for (const field of UNSUPPORTED_TOP_LEVEL_FIELDS) {
    if (field in request) {
      throw invalidRequest(`${field}: is not supported by this gateway profile; Extra inputs are not permitted`);
    }
  }
  rejectExtraFields(request, TOP_LEVEL_FIELDS);

  const maxTokens = request.max_tokens;
  if (!Number.isSafeInteger(maxTokens) || (maxTokens as number) <= 0) {
    throw invalidRequest("max_tokens: Expected a positive integer.");
  }
  if (request.metadata !== undefined && !isObject(request.metadata)) {
    throw invalidRequest("metadata: Expected an object.");
  }

  const tools = parseTools(request.tools);
  const toolChoice = parseToolChoice(request.tool_choice);
  if (toolChoice && (!tools || tools.length === 0)) {
    throw invalidRequest("tool_choice: Cannot be used without tools.");
  }
  if (toolChoice?.mode === "tool" && !tools?.some((tool) => tool.name === toolChoice.name)) {
    throw invalidRequest(`tool_choice.name: Unknown tool '${toolChoice.name}'.`);
  }

  const temperature = parseOptionalSamplingNumber(request.temperature, "temperature");
  const topP = parseOptionalSamplingNumber(request.top_p, "top_p");
  const stop = parseStopSequences(request.stop_sequences);
  const outputConfig = parseOutputConfig(request.output_config);
  const parsedMessages = parseMessages(request.messages);

  return {
    clientModel: requireString(request.model, "model"),
    system: [...parseSystem(request.system), ...parsedMessages.instructions],
    messages: parsedMessages.messages,
    maxOutputTokens: maxTokens as number,
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { topP }),
    ...(stop === undefined ? {} : { stop }),
    ...(tools === undefined ? {} : { tools }),
    ...(toolChoice === undefined ? {} : { toolChoice }),
    ...(outputConfig === undefined ? {} : { outputConfig }),
    stream: request.stream === undefined ? false : requireBoolean(request.stream, "stream")
  };
}
