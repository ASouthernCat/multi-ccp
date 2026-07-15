import type {
  CanonicalFinishReason,
  CanonicalStreamEvent,
  CanonicalUsage,
  ToolNameMapping
} from "./canonical.js";
import { EMPTY_TOOL_NAME_MAPPING } from "./canonical.js";
import { asGatewayError, type GatewayError, type GatewayErrorType, upstreamProtocolError } from "./errors.js";
import type { GeneratedImageStore, PreparedGeneratedImage } from "./generated-image.js";
import { normalizeToolCallId, toAnthropicMessageId } from "./utils.js";
import { AnthropicSseEmitter, SseParser, type SseEvent } from "./streaming.js";

type JsonObject = Record<string, unknown>;

const MAX_METADATA_TYPES = 32;
const GATEWAY_ERROR_TYPES = new Set<GatewayErrorType>([
  "invalid_request_error",
  "authentication_error",
  "not_found_error",
  "rate_limit_error",
  "api_error"
]);

interface TextState {
  key: string;
  text: string;
  started: boolean;
  stopped: boolean;
}

interface ItemState {
  key: string;
  outputIndex: number;
  id?: string;
  type?: "message" | "function_call" | "reasoning" | "image_generation_call";
  textParts: Map<number, TextState>;
  callId?: string;
  name?: string;
  arguments: string;
  emittedArgumentsLength: number;
  started: boolean;
  stopped: boolean;
  imagePath?: string;
  imageEmitted?: boolean;
}

export interface OpenAIResponsesStreamConverterOptions {
  model: string;
  toolNames?: ToolNameMapping;
  imageStore?: GeneratedImageStore;
}

export interface OpenAIResponsesStreamMetadata {
  upstreamEventTypes: string[];
  upstreamItemTypes: string[];
  lastEventType?: string;
  terminalEventReceived: boolean;
}

export interface AnthropicStreamBridge {
  readonly isTerminal: boolean;
  readonly usage: CanonicalUsage;
  readonly error: GatewayError | undefined;
  readonly metadata?: OpenAIResponsesStreamMetadata;
  push(chunk: string | Uint8Array): string[];
  finish(): string[];
  takePreparedImages?(): PreparedGeneratedImage[];
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, path: string): JsonObject {
  if (!isObject(value)) {
    throw upstreamProtocolError(`${path}: Expected an object in the upstream stream.`);
  }
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw upstreamProtocolError(`${path}: Expected a non-empty string in the upstream stream.`);
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw upstreamProtocolError(`${path}: Expected a string in the upstream stream.`);
  }
  return value.length > 0 ? value : undefined;
}

function requireIndex(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw upstreamProtocolError(`${path}: Expected a non-negative safe integer.`);
  }
  return value as number;
}

function extractError(value: unknown, fallback: string): GatewayError {
  const outer = isObject(value) ? value : undefined;
  const response = outer && isObject(outer.response) ? outer.response : undefined;
  const envelope = response && isObject(response.error)
    ? response.error
    : outer && isObject(outer.error)
      ? outer.error
      : response ?? outer;
  const message = envelope && typeof envelope.message === "string" && envelope.message.length > 0
    ? envelope.message
    : fallback;
  const candidate = envelope && typeof envelope.type === "string" ? envelope.type : "api_error";
  return {
    type: GATEWAY_ERROR_TYPES.has(candidate as GatewayErrorType) ? candidate as GatewayErrorType : "api_error",
    message
  };
}

/** Transport heartbeats observed from OpenAI-compatible proxies (e.g. suoxie). */
function isHeartbeatSseEvent(eventName: string | undefined): boolean {
  if (!eventName) return false;
  return eventName === "ping" ||
    eventName === "keepalive" ||
    eventName === "heartbeat" ||
    eventName === "comment";
}

/**
 * Events that are safe to ignore for Anthropic text/tool translation.
 * Includes OpenAI reasoning summary stream events and proxy heartbeats.
 * Actionable unsupported output items still fail in processOutputItem.
 */
function isIgnorableResponsesStreamEvent(type: string): boolean {
  if (
    type === "ping" ||
    type === "keepalive" ||
    type === "heartbeat" ||
    type === "message" ||
    type === "codex.rate_limits" ||
    type === "codex.response.metadata" ||
    type === "response.metadata"
  ) {
    return true;
  }
  // Official OpenAI/xAI reasoning stream events (summary/text/encrypted).
  if (type.startsWith("response.reasoning_")) return true;
  // Provider-specific noise that does not require client action.
  if (type.startsWith("response.audio_")) return true;
  if (type.startsWith("response.image_")) return true;
  return false;
}

export class OpenAIResponsesStreamConverter {
  private readonly model: string;
  private readonly toolNames: ToolNameMapping;
  private readonly imageStore: GeneratedImageStore | undefined;
  private readonly itemsByIndex = new Map<number, ItemState>();
  private readonly itemsById = new Map<string, ItemState>();
  private readonly blockOrder: string[] = [];
  private readonly eventTypes: string[] = [];
  private readonly eventTypeSet = new Set<string>();
  private readonly itemTypes: string[] = [];
  private readonly itemTypeSet = new Set<string>();
  private messageStarted = false;
  private usageValue: CanonicalUsage = { inputTokens: 0, outputTokens: 0 };
  private terminal = false;
  private lastEventTypeValue: string | undefined;
  private terminalEventReceivedValue = false;
  private terminalError: GatewayError | undefined;
  private functionCallsSeen = false;
  private preparedImages: PreparedGeneratedImage[] = [];
  private readonly preparedImagePaths = new Set<string>();

  constructor(options: OpenAIResponsesStreamConverterOptions) {
    this.model = options.model;
    this.toolNames = options.toolNames ?? EMPTY_TOOL_NAME_MAPPING;
    this.imageStore = options.imageStore;
  }

  get isTerminal(): boolean {
    return this.terminal;
  }

  get usage(): CanonicalUsage {
    return { ...this.usageValue };
  }

  get error(): GatewayError | undefined {
    return this.terminalError ? { ...this.terminalError } : undefined;
  }

  get metadata(): OpenAIResponsesStreamMetadata {
    return {
      upstreamEventTypes: [...this.eventTypes],
      upstreamItemTypes: [...this.itemTypes],
      ...(this.lastEventTypeValue ? { lastEventType: this.lastEventTypeValue } : {}),
      terminalEventReceived: this.terminalEventReceivedValue
    };
  }

  takePreparedImages(): PreparedGeneratedImage[] {
    const images = this.preparedImages;
    this.preparedImages = [];
    return images;
  }

  processSseEvent(event: SseEvent): CanonicalStreamEvent[] {
    if (this.terminal) return [];
    // Proxies and some providers inject transport heartbeats. These are not
    // part of the OpenAI Responses semantic event model but must not fail the stream.
    if (isHeartbeatSseEvent(event.event)) {
      this.recordType(event.event || "keepalive", this.eventTypeSet, this.eventTypes);
      return [];
    }
    if (!event.data || !event.data.trim()) {
      return [];
    }

    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return this.fail({
        type: "api_error",
        message: "Upstream Responses SSE data is not valid JSON.",
        code: "invalid_stream_data"
      });
    }
    if (!isObject(payload)) {
      return this.fail({
        type: "api_error",
        message: "Upstream Responses SSE payload must be an object.",
        code: "invalid_stream_data"
      });
    }

    try {
      const payloadType = optionalString(payload.type, "stream.type");
      const sseType = event.event === "message" ? undefined : event.event;
      if (payloadType && sseType && payloadType !== sseType && sseType !== "error") {
        throw upstreamProtocolError(
          `Responses SSE event type '${sseType}' conflicts with payload type '${payloadType}'.`
        );
      }
      const type = payloadType ?? sseType;
      // Bare `message` / empty-object heartbeats are common on OpenAI-compatible proxies.
      if (!type) {
        this.recordType(event.event || "message", this.eventTypeSet, this.eventTypes);
        return [];
      }
      this.recordType(type, this.eventTypeSet, this.eventTypes);
      this.lastEventTypeValue = type;
      if (event.event === "error" || type === "error" || type === "response.error") {
        return this.fail(extractError(payload, "The upstream Responses stream returned an error."));
      }
      if (isIgnorableResponsesStreamEvent(type)) {
        return [];
      }
      return this.processEvent(type, payload);
    } catch (error) {
      return this.fail(asGatewayError(error, "Invalid upstream Responses streaming response."));
    }
  }

  finish(): CanonicalStreamEvent[] {
    if (this.terminal) return [];
    return this.fail({
      type: "api_error",
      message: "Upstream Responses stream ended before a terminal response event was received.",
      code: "missing_terminal_event"
    });
  }

  private processEvent(type: string, payload: JsonObject): CanonicalStreamEvent[] {
    const output: CanonicalStreamEvent[] = [];
    switch (type) {
      case "codex.rate_limits":
        return output;
      case "response.created":
      case "response.in_progress":
        this.startMessage(requireObject(payload.response, `${type}.response`), output);
        return output;
      case "response.output_item.added":
        this.ensureMessageStarted(type);
        this.processOutputItem(payload, false, output);
        return output;
      case "response.content_part.added":
        this.ensureMessageStarted(type);
        this.processContentPart(payload, false, output);
        return output;
      case "response.output_text.delta":
        this.ensureMessageStarted(type);
        this.processTextDelta(payload, output);
        return output;
      case "response.output_text.done":
        this.ensureMessageStarted(type);
        this.processTextDone(payload, output);
        return output;
      case "response.content_part.done":
        this.ensureMessageStarted(type);
        this.processContentPart(payload, true, output);
        return output;
      case "response.function_call_arguments.delta":
        this.ensureMessageStarted(type);
        this.processArgumentsDelta(payload, output);
        return output;
      case "response.function_call_arguments.done":
        this.ensureMessageStarted(type);
        this.processArgumentsDone(payload, output);
        return output;
      case "response.output_item.done":
        this.ensureMessageStarted(type);
        this.processOutputItem(payload, true, output);
        return output;
      case "response.metadata":
        this.ensureMessageStarted(type);
        return output;
      case "response.completed":
        return this.completeResponse(payload, "completed");
      case "response.incomplete":
        return this.completeResponse(payload, "incomplete");
      case "response.failed":
        this.terminalEventReceivedValue = true;
        return this.fail(extractError(payload, "The upstream Responses request failed."));
      default:
        // Unknown semantic events: ignore transport/noise; fail only if processOutputItem
        // sees an unsupported actionable output item type.
        if (isIgnorableResponsesStreamEvent(type)) {
          return output;
        }
        throw upstreamProtocolError(
          `Unsupported Responses stream event type '${type}'.`,
          undefined,
          "unsupported_stream_event"
        );
    }
  }

  private ensureMessageStarted(eventType: string): void {
    if (!this.messageStarted) {
      throw upstreamProtocolError(`${eventType} arrived before response.created or response.in_progress.`);
    }
  }

  private startMessage(response: JsonObject, output: CanonicalStreamEvent[]): void {
    if (this.messageStarted) return;
    const id = optionalString(response.id, "response.id");
    if (!id) return;
    const model = optionalString(response.model, "response.model") ?? this.model;
    output.push({ type: "message_start", id: toAnthropicMessageId(id), model });
    this.messageStarted = true;
  }

  private processOutputItem(payload: JsonObject, done: boolean, output: CanonicalStreamEvent[]): void {
    const index = requireIndex(payload.output_index, "stream.output_index");
    const item = requireObject(payload.item, "stream.item");
    const type = requireString(item.type, "stream.item.type");
    this.recordType(type, this.itemTypeSet, this.itemTypes);
    const state = this.resolveItem(index, optionalString(item.id, "stream.item.id"));
    this.setItemType(state, type);

    if (type === "reasoning") return;
    if (type === "image_generation_call") {
      this.processImage(state, item, done, output);
      return;
    }
    if (type === "message") {
      this.processFullMessage(state, item, done, output);
      if (done) this.stopAllTextParts(state, output);
      return;
    }
    if (type === "function_call") {
      this.functionCallsSeen = true;
      this.updateToolIdentity(state, item);
      if (item.arguments !== undefined) {
        if (typeof item.arguments !== "string") {
          throw upstreamProtocolError("stream.item.arguments: Expected a string.");
        }
        this.mergeFullArguments(state, item.arguments);
      }
      this.startTool(state, output, done);
      this.flushToolArguments(state, output);
      if (done) this.finishTool(state, output);
      return;
    }
    throw upstreamProtocolError(
      `stream.item.type: Unsupported output item type '${type}'.`,
      undefined,
      "unsupported_output_item"
    );
  }

  private processContentPart(payload: JsonObject, done: boolean, output: CanonicalStreamEvent[]): void {
    const state = this.requireMessageItem(payload);
    const contentIndex = requireIndex(payload.content_index, "stream.content_index");
    const part = requireObject(payload.part, "stream.part");
    if (part.type !== "output_text") {
      throw upstreamProtocolError(`stream.part.type: Unsupported message content type '${String(part.type)}'.`);
    }
    if (part.text !== undefined && typeof part.text !== "string") {
      throw upstreamProtocolError("stream.part.text: Expected a string.");
    }
    const textState = this.getTextState(state, contentIndex);
    this.startText(textState, output);
    this.mergeFullText(textState, typeof part.text === "string" ? part.text : "", output);
    if (done) this.stopText(textState, output);
  }

  private processTextDelta(payload: JsonObject, output: CanonicalStreamEvent[]): void {
    const state = this.requireMessageItem(payload);
    const contentIndex = requireIndex(payload.content_index, "stream.content_index");
    if (typeof payload.delta !== "string") throw upstreamProtocolError("stream.delta: Expected a string.");
    const textState = this.getTextState(state, contentIndex);
    this.startText(textState, output);
    if (payload.delta.length > 0) {
      textState.text += payload.delta;
      output.push({ type: "text_delta", blockKey: textState.key, text: payload.delta });
    }
  }

  private processTextDone(payload: JsonObject, output: CanonicalStreamEvent[]): void {
    const state = this.requireMessageItem(payload);
    const contentIndex = requireIndex(payload.content_index, "stream.content_index");
    const textState = this.getTextState(state, contentIndex);
    this.startText(textState, output);
    if (payload.text !== undefined) {
      if (typeof payload.text !== "string") throw upstreamProtocolError("stream.text: Expected a string.");
      this.mergeFullText(textState, payload.text, output);
    }
    this.stopText(textState, output);
  }

  private processArgumentsDelta(payload: JsonObject, output: CanonicalStreamEvent[]): void {
    const state = this.requireFunctionItem(payload);
    if (state.stopped) throw upstreamProtocolError(`${state.key}.arguments received data after the block stopped.`);
    if (typeof payload.delta !== "string") throw upstreamProtocolError("stream.delta: Expected a string.");
    state.arguments += payload.delta;
    this.startTool(state, output, false);
    this.flushToolArguments(state, output);
  }

  private processArgumentsDone(payload: JsonObject, output: CanonicalStreamEvent[]): void {
    const state = this.requireFunctionItem(payload);
    if (payload.arguments !== undefined) {
      if (typeof payload.arguments !== "string") throw upstreamProtocolError("stream.arguments: Expected a string.");
      this.mergeFullArguments(state, payload.arguments);
    }
    this.startTool(state, output, true);
    this.flushToolArguments(state, output);
    this.finishTool(state, output);
  }

  private completeResponse(payload: JsonObject, kind: "completed" | "incomplete"): CanonicalStreamEvent[] {
    this.terminalEventReceivedValue = true;
    const response = requireObject(payload.response, `${kind}.response`);
    const output: CanonicalStreamEvent[] = [];
    this.startMessage(response, output);
    if (!this.messageStarted) {
      throw upstreamProtocolError(`response.${kind} did not include a response id.`);
    }
    const status = optionalString(response.status, "response.status");
    if (status && status !== kind) {
      throw upstreamProtocolError(`response.status '${status}' conflicts with response.${kind}.`);
    }
    const usage = this.parseUsage(response.usage);
    if (usage) {
      this.usageValue = usage;
      output.push({ type: "usage", usage });
    }

    if (Array.isArray(response.output)) {
      response.output.forEach((item, outputIndex) => {
        if (isObject(item) && item.type === "image_generation_call") {
          this.processOutputItem({ output_index: outputIndex, item }, true, output);
        }
      });
    }

    if (kind === "incomplete") {
      const details = response.incomplete_details === undefined
        ? undefined
        : requireObject(response.incomplete_details, "response.incomplete_details");
      if (details?.reason !== "max_output_tokens") {
        return this.fail(extractError(
          response,
          `Upstream Responses response is incomplete${details?.reason ? ` (${String(details.reason)})` : ""}.`
        ));
      }
      return this.finishSuccess(output, "max_tokens");
    }
    return this.finishSuccess(output, this.functionCallsSeen ? "tool_use" : "end_turn");
  }

  private finishSuccess(output: CanonicalStreamEvent[], reason: CanonicalFinishReason): CanonicalStreamEvent[] {
    for (const state of this.itemsByIndex.values()) {
      if (state.type === "function_call") {
        this.startTool(state, output, true);
        this.flushToolArguments(state, output);
        this.validateArguments(state);
      }
    }
    for (const blockKey of this.blockOrder) {
      const block = this.findBlock(blockKey);
      if (block && !block.stopped) {
        block.stopped = true;
        output.push({ type: "block_stop", blockKey });
      }
    }
    output.push({ type: "finish", reason });
    this.terminal = true;
    return output;
  }

  private processFullMessage(
    state: ItemState,
    item: JsonObject,
    done: boolean,
    output: CanonicalStreamEvent[]
  ): void {
    if (item.content === undefined) return;
    if (!Array.isArray(item.content)) throw upstreamProtocolError("stream.item.content: Expected an array.");
    item.content.forEach((partValue, contentIndex) => {
      const part = requireObject(partValue, `stream.item.content[${contentIndex}]`);
      if (part.type !== "output_text") {
        throw upstreamProtocolError(
          `stream.item.content[${contentIndex}].type: Unsupported message content type '${String(part.type)}'.`
        );
      }
      if (typeof part.text !== "string") {
        throw upstreamProtocolError(`stream.item.content[${contentIndex}].text: Expected a string.`);
      }
      const textState = this.getTextState(state, contentIndex);
      if (part.text.length > 0 || done) this.startText(textState, output);
      this.mergeFullText(textState, part.text, output);
    });
  }

  private processImage(
    state: ItemState,
    item: JsonObject,
    done: boolean,
    output: CanonicalStreamEvent[]
  ): void {
    const status = optionalString(item.status, "stream.item.status");
    const result = optionalString(item.result, "stream.item.result");
    if (!done && !result) return;
    if (!result) {
      throw upstreamProtocolError("stream.item.result: Expected a non-empty string in the upstream stream.");
    }
    // Some Responses-compatible proxies emit a final result from a done/terminal
    // event but leave the item status at "generating". The enclosing event is
    // authoritative once a complete image payload is present and validates.
    if (status !== "completed" && !(done && status === "generating")) {
      throw upstreamProtocolError("stream.item.status: Expected 'completed' for an image generation result.");
    }
    if (!this.imageStore) {
      throw upstreamProtocolError("Image generation output cannot be handled without an image store.");
    }
    const image = this.imageStore.prepare(result, state.id ?? `output-${state.outputIndex}`);
    if (state.imagePath && state.imagePath !== image.path) {
      throw upstreamProtocolError(`${state.key}.result changed during the stream.`);
    }
    state.imagePath = image.path;
    if (!this.preparedImagePaths.has(image.path)) {
      this.preparedImagePaths.add(image.path);
      this.preparedImages.push(image);
    }
    if (!state.imageEmitted) {
      state.imageEmitted = true;
      output.push({ type: "generated_image", blockKey: `${state.key}:image`, path: image.path });
    }
  }

  private resolveItem(index: number, id?: string): ItemState {
    const indexed = this.itemsByIndex.get(index);
    const identified = id ? this.itemsById.get(id) : undefined;
    if (indexed && identified && indexed !== identified) {
      throw upstreamProtocolError(`Output item '${id}' conflicts with output_index ${index}.`);
    }
    const state = indexed ?? identified ?? {
      key: id ? `item:${id}` : `output:${index}`,
      outputIndex: index,
      ...(id ? { id } : {}),
      textParts: new Map(),
      arguments: "",
      emittedArgumentsLength: 0,
      started: false,
      stopped: false
    };
    if (state.outputIndex !== index) throw upstreamProtocolError(`Output item '${id ?? state.key}' changed output_index.`);
    if (id && state.id && state.id !== id) throw upstreamProtocolError(`output_index ${index} changed item id.`);
    if (id && !state.id) state.id = id;
    this.itemsByIndex.set(index, state);
    if (id) this.itemsById.set(id, state);
    return state;
  }

  private resolvePayloadItem(payload: JsonObject): ItemState {
    const index = requireIndex(payload.output_index, "stream.output_index");
    const itemId = optionalString(payload.item_id, "stream.item_id");
    const state = this.itemsByIndex.get(index) ?? (itemId ? this.itemsById.get(itemId) : undefined);
    if (!state) throw upstreamProtocolError(`No output item was added for output_index ${index}.`);
    if (itemId && state.id && itemId !== state.id) {
      throw upstreamProtocolError(`stream.item_id '${itemId}' does not match output_index ${index}.`);
    }
    return state;
  }

  private requireMessageItem(payload: JsonObject): ItemState {
    const state = this.resolvePayloadItem(payload);
    if (state.type !== "message") throw upstreamProtocolError(`output_index ${state.outputIndex} is not a message item.`);
    return state;
  }

  private requireFunctionItem(payload: JsonObject): ItemState {
    const state = this.resolvePayloadItem(payload);
    if (state.type !== "function_call") {
      throw upstreamProtocolError(`output_index ${state.outputIndex} is not a function_call item.`);
    }
    return state;
  }

  private setItemType(state: ItemState, type: string): void {
    if (type !== "message" && type !== "function_call" && type !== "reasoning" && type !== "image_generation_call") {
      throw upstreamProtocolError(
        `Unsupported output item type '${type}'.`,
        undefined,
        "unsupported_output_item"
      );
    }
    if (state.type && state.type !== type) {
      throw upstreamProtocolError(`Output item ${state.key} changed type from '${state.type}' to '${type}'.`);
    }
    state.type = type;
  }

  private updateToolIdentity(state: ItemState, item: JsonObject): void {
    const callId = optionalString(item.call_id, "stream.item.call_id");
    const name = optionalString(item.name, "stream.item.name");
    if (callId && state.callId && callId !== state.callId) {
      throw upstreamProtocolError(`${state.key}.call_id changed during the stream.`);
    }
    if (name && state.name && name !== state.name) {
      throw upstreamProtocolError(`${state.key}.name changed during the stream.`);
    }
    if (callId) state.callId = callId;
    if (name) state.name = name;
  }

  private getTextState(item: ItemState, contentIndex: number): TextState {
    let state = item.textParts.get(contentIndex);
    if (!state) {
      state = { key: `${item.key}:text:${contentIndex}`, text: "", started: false, stopped: false };
      item.textParts.set(contentIndex, state);
    }
    return state;
  }

  private startText(state: TextState, output: CanonicalStreamEvent[]): void {
    if (state.stopped) return;
    if (state.started) return;
    state.started = true;
    this.blockOrder.push(state.key);
    output.push({ type: "text_start", blockKey: state.key });
  }

  private mergeFullText(state: TextState, fullText: string, output: CanonicalStreamEvent[]): void {
    if (state.stopped) {
      if (fullText === state.text) return;
      throw upstreamProtocolError(`Final text for stopped block '${state.key}' does not match streamed deltas.`);
    }
    if (!fullText.startsWith(state.text)) {
      throw upstreamProtocolError(`Final text for block '${state.key}' does not match streamed deltas.`);
    }
    const suffix = fullText.slice(state.text.length);
    if (suffix.length > 0) {
      this.startText(state, output);
      state.text = fullText;
      output.push({ type: "text_delta", blockKey: state.key, text: suffix });
    }
  }

  private stopText(state: TextState, output: CanonicalStreamEvent[]): void {
    if (!state.started || state.stopped) return;
    state.stopped = true;
    output.push({ type: "block_stop", blockKey: state.key });
  }

  private stopAllTextParts(state: ItemState, output: CanonicalStreamEvent[]): void {
    for (const textState of state.textParts.values()) this.stopText(textState, output);
  }

  private startTool(state: ItemState, output: CanonicalStreamEvent[], required: boolean): void {
    if (state.stopped) return;
    if (state.started) return;
    if (!state.callId || !state.name) {
      if (required) throw upstreamProtocolError(`${state.key}: Function call id and name are required.`);
      return;
    }
    state.started = true;
    this.blockOrder.push(state.key);
    output.push({
      type: "tool_start",
      blockKey: state.key,
      id: normalizeToolCallId(state.callId),
      name: this.toolNames.targetToSource.get(state.name) ?? state.name
    });
  }

  private mergeFullArguments(state: ItemState, fullArguments: string): void {
    if (!fullArguments.startsWith(state.arguments)) {
      throw upstreamProtocolError(`${state.key}.arguments: Final value does not match streamed deltas.`);
    }
    state.arguments = fullArguments;
  }

  private flushToolArguments(state: ItemState, output: CanonicalStreamEvent[]): void {
    if (!state.started || state.stopped || state.emittedArgumentsLength >= state.arguments.length) return;
    const partialJson = state.arguments.slice(state.emittedArgumentsLength);
    state.emittedArgumentsLength = state.arguments.length;
    output.push({ type: "tool_arguments_delta", blockKey: state.key, partialJson });
  }

  private finishTool(state: ItemState, output: CanonicalStreamEvent[]): void {
    this.validateArguments(state);
    if (state.started && !state.stopped) {
      state.stopped = true;
      output.push({ type: "block_stop", blockKey: state.key });
    }
  }

  private validateArguments(state: ItemState): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(state.arguments);
    } catch (error) {
      throw upstreamProtocolError(`${state.key}.arguments: Invalid JSON object.`, { cause: error });
    }
    if (!isObject(parsed)) throw upstreamProtocolError(`${state.key}.arguments: Expected a JSON object.`);
  }

  private findBlock(key: string): TextState | ItemState | undefined {
    for (const item of this.itemsByIndex.values()) {
      if (item.key === key) return item;
      for (const text of item.textParts.values()) if (text.key === key) return text;
    }
    return undefined;
  }

  private parseUsage(value: unknown): CanonicalUsage | undefined {
    if (value === undefined) return undefined;
    const usage = requireObject(value, "response.usage");
    const parse = (field: "input_tokens" | "output_tokens"): number => {
      if (usage[field] === undefined) return 0;
      if (!Number.isSafeInteger(usage[field]) || (usage[field] as number) < 0) {
        throw upstreamProtocolError(`response.usage.${field}: Expected a non-negative safe integer.`);
      }
      return usage[field] as number;
    };
    return { inputTokens: parse("input_tokens"), outputTokens: parse("output_tokens") };
  }

  private recordType(type: string, seen: Set<string>, values: string[]): void {
    if (seen.has(type) || values.length >= MAX_METADATA_TYPES) return;
    seen.add(type);
    values.push(type);
  }

  private fail(error: GatewayError): CanonicalStreamEvent[] {
    if (this.terminal) return [];
    this.terminalError = error;
    this.terminal = true;
    return [{ type: "error", error }];
  }
}

export class OpenAIResponsesAnthropicStreamBridge implements AnthropicStreamBridge {
  private readonly parser = new SseParser();
  private readonly converter: OpenAIResponsesStreamConverter;
  private readonly emitter = new AnthropicSseEmitter();

  constructor(options: OpenAIResponsesStreamConverterOptions) {
    this.converter = new OpenAIResponsesStreamConverter(options);
  }

  get isTerminal(): boolean {
    return this.converter.isTerminal;
  }

  get usage(): CanonicalUsage {
    return this.converter.usage;
  }

  get error(): GatewayError | undefined {
    return this.converter.error;
  }

  get metadata(): OpenAIResponsesStreamMetadata {
    return this.converter.metadata;
  }

  push(chunk: string | Uint8Array): string[] {
    return this.convert(this.parser.push(chunk));
  }

  finish(): string[] {
    const output = this.convert(this.parser.finish());
    if (!this.converter.isTerminal) output.push(...this.emit(this.converter.finish()));
    return output;
  }

  takePreparedImages(): PreparedGeneratedImage[] {
    return this.converter.takePreparedImages();
  }

  private convert(events: SseEvent[]): string[] {
    const output: string[] = [];
    for (const event of events) output.push(...this.emit(this.converter.processSseEvent(event)));
    return output;
  }

  private emit(events: CanonicalStreamEvent[]): string[] {
    return events.flatMap((event) => this.emitter.emit(event));
  }
}
