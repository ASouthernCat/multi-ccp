import { TextDecoder } from "node:util";
import type {
  CanonicalFinishReason,
  CanonicalStreamEvent,
  CanonicalUsage,
  ToolNameMapping
} from "./canonical.js";
import { EMPTY_TOOL_NAME_MAPPING } from "./canonical.js";
import { asGatewayError, type GatewayError, type GatewayErrorType, upstreamProtocolError } from "./errors.js";
import { mapOpenAIFinishReason } from "./openai-chat-target.js";
import { normalizeToolCallId, toAnthropicMessageId } from "./utils.js";
import type { AnthropicStreamBridge } from "./openai-responses-streaming.js";


type JsonObject = Record<string, unknown>;

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class SseParser {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private eventName = "";
  private eventId: string | undefined;
  private dataLines: string[] = [];

  push(chunk: string | Uint8Array): SseEvent[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    return this.consumeLines(false);
  }

  finish(): SseEvent[] {
    this.buffer += this.decoder.decode();
    return this.consumeLines(true);
  }

  private consumeLines(flush: boolean): SseEvent[] {
    const events: SseEvent[] = [];
    while (this.buffer.length > 0) {
      let delimiterIndex = -1;
      let delimiterLength = 0;
      for (let index = 0; index < this.buffer.length; index += 1) {
        const char = this.buffer[index];
        if (char === "\n") {
          delimiterIndex = index;
          delimiterLength = 1;
          break;
        }
        if (char === "\r") {
          if (index === this.buffer.length - 1 && !flush) {
            return events;
          }
          delimiterIndex = index;
          delimiterLength = this.buffer[index + 1] === "\n" ? 2 : 1;
          break;
        }
      }

      if (delimiterIndex < 0) {
        if (!flush) {
          break;
        }
        const line = this.buffer;
        this.buffer = "";
        this.consumeLine(line, events);
        break;
      }

      const line = this.buffer.slice(0, delimiterIndex);
      this.buffer = this.buffer.slice(delimiterIndex + delimiterLength);
      this.consumeLine(line, events);
    }

    if (flush) {
      this.dispatch(events);
    }
    return events;
  }

  private consumeLine(line: string, events: SseEvent[]): void {
    if (line === "") {
      this.dispatch(events);
      return;
    }
    if (line.startsWith(":")) {
      return;
    }

    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (field === "event") {
      this.eventName = value;
    } else if (field === "data") {
      this.dataLines.push(value);
    } else if (field === "id" && !value.includes("\0")) {
      this.eventId = value;
    }
  }

  private dispatch(events: SseEvent[]): void {
    if (this.dataLines.length === 0) {
      this.eventName = "";
      return;
    }
    events.push({
      event: this.eventName || "message",
      data: this.dataLines.join("\n"),
      ...(this.eventId === undefined ? {} : { id: this.eventId })
    });
    this.eventName = "";
    this.dataLines = [];
  }
}

interface ToolStreamState {
  key: string;
  id: string;
  name: string;
  arguments: string;
  argumentsSeen: boolean;
  pendingArgumentDeltas: string[];
  started: boolean;
}

export interface OpenAIStreamConverterOptions {
  messageId: string;
  model: string;
  toolNames?: ToolNameMapping;
}

const GATEWAY_ERROR_TYPES = new Set<GatewayErrorType>([
  "invalid_request_error",
  "authentication_error",
  "not_found_error",
  "rate_limit_error",
  "api_error"
]);

function parseStreamUsage(value: unknown): CanonicalUsage | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const inputTokens = Number.isSafeInteger(value.prompt_tokens) && (value.prompt_tokens as number) >= 0
    ? value.prompt_tokens as number
    : 0;
  const outputTokens = Number.isSafeInteger(value.completion_tokens) && (value.completion_tokens as number) >= 0
    ? value.completion_tokens as number
    : 0;
  return { inputTokens, outputTokens };
}

function extractUpstreamError(value: unknown, fallback: string): GatewayError {
  const envelope = isObject(value) && isObject(value.error) ? value.error : value;
  const message = isObject(envelope) && typeof envelope.message === "string" && envelope.message.length > 0
    ? envelope.message
    : fallback;
  const candidateType = isObject(envelope) && typeof envelope.type === "string" ? envelope.type : "api_error";
  return {
    type: GATEWAY_ERROR_TYPES.has(candidateType as GatewayErrorType)
      ? candidateType as GatewayErrorType
      : "api_error",
    message
  };
}

export class OpenAIStreamConverter {
  private readonly options: Required<OpenAIStreamConverterOptions>;
  private messageStarted = false;
  private textStarted = false;
  private readonly tools = new Map<number, ToolStreamState>();
  private readonly blockOrder: string[] = [];
  private finishReason: CanonicalFinishReason | undefined;
  private usage: CanonicalUsage = { inputTokens: 0, outputTokens: 0 };
  private terminal = false;
  private terminalError: GatewayError | undefined;

  constructor(options: OpenAIStreamConverterOptions) {
    this.options = {
      ...options,
      toolNames: options.toolNames ?? EMPTY_TOOL_NAME_MAPPING
    };
  }

  get isTerminal(): boolean {
    return this.terminal;
  }

  get currentUsage(): CanonicalUsage {
    return { ...this.usage };
  }

  get error(): GatewayError | undefined {
    return this.terminalError ? { ...this.terminalError } : undefined;
  }

  processSseEvent(event: SseEvent): CanonicalStreamEvent[] {
    if (this.terminal) {
      return [];
    }
    if (event.event === "ping") {
      return [];
    }
    if (event.data.trim() === "[DONE]") {
      return this.finish("done");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return this.fail({ type: "api_error", message: "Upstream SSE data is not valid JSON." });
    }
    if (event.event === "error" || (isObject(payload) && "error" in payload)) {
      return this.fail(extractUpstreamError(payload, "The upstream stream returned an error."));
    }
    return this.processChunk(payload);
  }

  processChunk(input: unknown): CanonicalStreamEvent[] {
    if (this.terminal) {
      return [];
    }
    try {
      return this.processChunkOrThrow(input);
    } catch (error) {
      return this.fail(asGatewayError(error, "Invalid upstream streaming response."));
    }
  }

  finish(_kind: "done" | "eof" = "eof"): CanonicalStreamEvent[] {
    if (this.terminal) {
      return [];
    }
    if (!this.finishReason) {
      return this.fail({
        type: "api_error",
        message: "Upstream stream ended before a finish_reason was received."
      });
    }

    const result: CanonicalStreamEvent[] = [];
    try {
      for (const state of this.tools.values()) {
        if (!state.started) {
          this.startToolOrThrow(state, result, true);
          this.flushToolArguments(state, result);
        }
        let input: unknown;
        try {
          input = JSON.parse(state.arguments);
        } catch {
          throw upstreamProtocolError(`tool_calls[${state.key}].function.arguments: Invalid JSON object.`);
        }
        if (!isObject(input)) {
          throw upstreamProtocolError(`tool_calls[${state.key}].function.arguments: Expected a JSON object.`);
        }
      }
    } catch (error) {
      return this.fail(asGatewayError(error));
    }

    result.push(...this.blockOrder.map((blockKey) => ({
      type: "block_stop" as const,
      blockKey
    })));
    result.push({ type: "finish", reason: this.finishReason });
    this.terminal = true;
    return result;
  }

  private processChunkOrThrow(input: unknown): CanonicalStreamEvent[] {
    if (!isObject(input)) {
      throw upstreamProtocolError("Upstream stream chunk must be a JSON object.");
    }
    const result: CanonicalStreamEvent[] = [];
    if (!this.messageStarted) {
      const upstreamId = typeof input.id === "string" && input.id.length > 0 ? input.id : this.options.messageId;
      const model = typeof input.model === "string" && input.model.length > 0 ? input.model : this.options.model;
      result.push({ type: "message_start", id: toAnthropicMessageId(upstreamId), model });
      this.messageStarted = true;
    }

    const choices = input.choices;
    if (choices !== undefined && !Array.isArray(choices)) {
      throw upstreamProtocolError("stream.choices: Expected an array.");
    }
    if (Array.isArray(choices) && choices.length > 0) {
      const choiceValue = choices.find((entry) => isObject(entry) && (entry.index === 0 || entry.index === undefined));
      if (!choiceValue || !isObject(choiceValue)) {
        throw upstreamProtocolError("stream.choices: Choice index 0 is missing.");
      }
      const delta = choiceValue.delta;
      if (delta !== undefined) {
        if (!isObject(delta)) {
          throw upstreamProtocolError("stream.choices[0].delta: Expected an object.");
        }
        this.processDelta(delta, result);
      }
      if (choiceValue.finish_reason !== undefined && choiceValue.finish_reason !== null) {
        const reason = mapOpenAIFinishReason(choiceValue.finish_reason);
        if (this.finishReason && this.finishReason !== reason) {
          throw upstreamProtocolError("Upstream stream returned conflicting finish_reason values.");
        }
        this.finishReason = reason;
      }
    } else if (Array.isArray(choices) && choices.length === 0 && input.usage === undefined) {
      throw upstreamProtocolError("stream.choices: Empty choices are only valid for a usage chunk.");
    } else if (choices === undefined && input.usage === undefined) {
      throw upstreamProtocolError("Upstream stream chunk contains neither choices nor usage.");
    }

    const usage = parseStreamUsage(input.usage);
    if (usage) {
      this.usage = usage;
      result.push({ type: "usage", usage });
    }
    return result;
  }

  private processDelta(delta: JsonObject, result: CanonicalStreamEvent[]): void {
    if (delta.content !== undefined && delta.content !== null) {
      if (typeof delta.content !== "string") {
        throw upstreamProtocolError("stream.choices[0].delta.content: Expected a string or null.");
      }
      if (delta.content.length > 0) {
        if (!this.textStarted) {
          this.textStarted = true;
          this.blockOrder.push("text");
        }
        result.push({ type: "text_delta", blockKey: "text", text: delta.content });
      }
    }

    if (delta.tool_calls === undefined || delta.tool_calls === null) {
      return;
    }
    if (!Array.isArray(delta.tool_calls)) {
      throw upstreamProtocolError("stream.choices[0].delta.tool_calls: Expected an array.");
    }
    for (const callValue of delta.tool_calls) {
      if (!isObject(callValue) || !Number.isSafeInteger(callValue.index) || (callValue.index as number) < 0) {
        throw upstreamProtocolError("stream.choices[0].delta.tool_calls[].index: Expected a non-negative integer.");
      }
      const index = callValue.index as number;
      let state = this.tools.get(index);
      if (!state) {
        state = {
          key: `tool:${index}`,
          id: "",
          name: "",
          arguments: "",
          argumentsSeen: false,
          pendingArgumentDeltas: [],
          started: false
        };
        this.tools.set(index, state);
      }
      let nameUpdated = false;
      if (callValue.id !== undefined && callValue.id !== null) {
        if (typeof callValue.id !== "string") {
          throw upstreamProtocolError(`stream.tool_calls[${index}].id: Expected a string.`);
        }
        if (state.started && callValue.id.length > 0) {
          throw upstreamProtocolError(`stream.tool_calls[${index}].id arrived after the tool block started.`);
        }
        state.id += callValue.id;
      }
      if (callValue.function !== undefined && callValue.function !== null) {
        if (!isObject(callValue.function)) {
          throw upstreamProtocolError(`stream.tool_calls[${index}].function: Expected an object.`);
        }
        if (callValue.function.name !== undefined && callValue.function.name !== null) {
          if (typeof callValue.function.name !== "string") {
            throw upstreamProtocolError(`stream.tool_calls[${index}].function.name: Expected a string.`);
          }
          if (state.started && callValue.function.name.length > 0) {
            throw upstreamProtocolError(`stream.tool_calls[${index}].function.name arrived after the tool block started.`);
          }
          state.name += callValue.function.name;
          nameUpdated = callValue.function.name.length > 0;
        }
        if (callValue.function.arguments !== undefined && callValue.function.arguments !== null) {
          if (typeof callValue.function.arguments !== "string") {
            throw upstreamProtocolError(`stream.tool_calls[${index}].function.arguments: Expected a string.`);
          }
          state.argumentsSeen = true;
          state.arguments += callValue.function.arguments;
          if (callValue.function.arguments.length > 0) {
            state.pendingArgumentDeltas.push(callValue.function.arguments);
          }
        }
      }
      // A name can itself be fragmented. Starting on a delta that also carries
      // a name fragment can expose an incomplete name, so wait for an
      // argument-only delta (or terminal validation) before opening the block.
      if (state.argumentsSeen && !nameUpdated) {
        this.startToolOrThrow(state, result);
        this.flushToolArguments(state, result);
      }
    }
  }

  private startToolOrThrow(state: ToolStreamState, result: CanonicalStreamEvent[], final = false): void {
    if (!state.id || !state.name) {
      if (final) {
        throw upstreamProtocolError(`stream.${state.key}: Tool id and name must arrive before arguments finish.`);
      }
      return;
    }
    if (state.started) {
      return;
    }
    state.started = true;
    this.blockOrder.push(state.key);
    result.push({
      type: "tool_start",
      blockKey: state.key,
      id: normalizeToolCallId(state.id),
      name: this.options.toolNames.targetToSource.get(state.name) ?? state.name
    });
  }

  private flushToolArguments(state: ToolStreamState, result: CanonicalStreamEvent[]): void {
    if (!state.started) {
      return;
    }
    for (const partialJson of state.pendingArgumentDeltas) {
      result.push({ type: "tool_arguments_delta", blockKey: state.key, partialJson });
    }
    state.pendingArgumentDeltas = [];
  }

  private fail(error: GatewayError): CanonicalStreamEvent[] {
    if (this.terminal) {
      return [];
    }
    this.terminalError = error;
    this.terminal = true;
    return [{ type: "error", error }];
  }
}

interface EmittedBlock {
  index: number;
  kind: "text" | "tool";
  stopped: boolean;
}

function formatSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class AnthropicSseEmitter {
  private messageStarted = false;
  private nextBlockIndex = 0;
  private readonly blocks = new Map<string, EmittedBlock>();
  private usage: CanonicalUsage = { inputTokens: 0, outputTokens: 0 };
  private terminal = false;

  emit(event: CanonicalStreamEvent): string[] {
    if (this.terminal) {
      return [];
    }
    if (event.type === "error") {
      this.terminal = true;
      return [formatSse("error", { type: "error", error: event.error })];
    }
    if (event.type === "message_start") {
      if (this.messageStarted) {
        throw new Error("Canonical stream emitted message_start more than once.");
      }
      this.messageStarted = true;
      return [formatSse("message_start", {
        type: "message_start",
        message: {
          id: event.id,
          type: "message",
          role: "assistant",
          model: event.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      })];
    }
    if (!this.messageStarted) {
      throw new Error(`Canonical stream emitted ${event.type} before message_start.`);
    }

    if (event.type === "text_start") {
      if (this.blocks.has(event.blockKey)) {
        throw new Error(`Canonical stream reused block key '${event.blockKey}'.`);
      }
      const block = { index: this.nextBlockIndex++, kind: "text" as const, stopped: false };
      this.blocks.set(event.blockKey, block);
      return [formatSse("content_block_start", {
        type: "content_block_start",
        index: block.index,
        content_block: { type: "text", text: "" }
      })];
    }
    if (event.type === "text_delta") {
      const output: string[] = [];
      let block = this.blocks.get(event.blockKey);
      if (!block) {
        block = { index: this.nextBlockIndex++, kind: "text", stopped: false };
        this.blocks.set(event.blockKey, block);
        output.push(formatSse("content_block_start", {
          type: "content_block_start",
          index: block.index,
          content_block: { type: "text", text: "" }
        }));
      }
      output.push(formatSse("content_block_delta", {
        type: "content_block_delta",
        index: block.index,
        delta: { type: "text_delta", text: event.text }
      }));
      return output;
    }
    if (event.type === "tool_start") {
      if (this.blocks.has(event.blockKey)) {
        throw new Error(`Canonical stream reused block key '${event.blockKey}'.`);
      }
      const block = { index: this.nextBlockIndex++, kind: "tool" as const, stopped: false };
      this.blocks.set(event.blockKey, block);
      return [formatSse("content_block_start", {
        type: "content_block_start",
        index: block.index,
        content_block: { type: "tool_use", id: event.id, name: event.name, input: {} }
      })];
    }
    if (event.type === "tool_arguments_delta") {
      const block = this.blocks.get(event.blockKey);
      if (!block || block.kind !== "tool" || block.stopped) {
        throw new Error(`Canonical tool arguments referenced inactive block '${event.blockKey}'.`);
      }
      return [formatSse("content_block_delta", {
        type: "content_block_delta",
        index: block.index,
        delta: { type: "input_json_delta", partial_json: event.partialJson }
      })];
    }
    if (event.type === "block_stop") {
      const block = this.blocks.get(event.blockKey);
      if (!block || block.stopped) {
        return [];
      }
      block.stopped = true;
      return [formatSse("content_block_stop", { type: "content_block_stop", index: block.index })];
    }
    if (event.type === "usage") {
      this.usage = event.usage;
      return [];
    }
    if (event.type === "generated_image") {
      if (this.blocks.has(event.blockKey)) {
        throw new Error(`Canonical stream reused block key '${event.blockKey}'.`);
      }
      const block = { index: this.nextBlockIndex++, kind: "text" as const, stopped: true };
      this.blocks.set(event.blockKey, block);
      const text = `Generated image saved to:\n${event.path}`;
      return [
        formatSse("content_block_start", {
          type: "content_block_start",
          index: block.index,
          content_block: { type: "text", text: "" }
        }),
        formatSse("content_block_delta", {
          type: "content_block_delta",
          index: block.index,
          delta: { type: "text_delta", text }
        }),
        formatSse("content_block_stop", { type: "content_block_stop", index: block.index })
      ];
    }

    this.terminal = true;
    return [
      formatSse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: event.reason, stop_sequence: null },
        usage: {
          input_tokens: this.usage.inputTokens,
          output_tokens: this.usage.outputTokens
        }
      }),
      formatSse("message_stop", { type: "message_stop" })
    ];
  }
}

export class OpenAIAnthropicStreamBridge implements AnthropicStreamBridge {
  private readonly parser = new SseParser();
  private readonly converter: OpenAIStreamConverter;
  private readonly emitter = new AnthropicSseEmitter();

  constructor(options: OpenAIStreamConverterOptions) {
    this.converter = new OpenAIStreamConverter(options);
  }

  get isTerminal(): boolean {
    return this.converter.isTerminal;
  }

  get usage(): CanonicalUsage {
    return this.converter.currentUsage;
  }

  get error(): GatewayError | undefined {
    return this.converter.error;
  }

  get metadata(): undefined {
    return undefined;
  }


  push(chunk: string | Uint8Array): string[] {
    return this.convert(this.parser.push(chunk));
  }

  finish(): string[] {
    const output = this.convert(this.parser.finish());
    if (!this.converter.isTerminal) {
      output.push(...this.emitCanonical(this.converter.finish("eof")));
    }
    return output;
  }

  private convert(events: SseEvent[]): string[] {
    const output: string[] = [];
    for (const event of events) {
      output.push(...this.emitCanonical(this.converter.processSseEvent(event)));
    }
    return output;
  }

  private emitCanonical(events: CanonicalStreamEvent[]): string[] {
    return events.flatMap((event) => this.emitter.emit(event));
  }
}
