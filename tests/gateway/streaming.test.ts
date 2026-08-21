import { describe, expect, it } from "vitest";
import { GeneratedImageStore } from "../../src/gateway/generated-image.js";
import { createToolNameMapping } from "../../src/gateway/utils.js";
import {
  OpenAIResponsesAnthropicStreamBridge,
  OpenAIResponsesStreamConverter
} from "../../src/gateway/openai-responses-streaming.js";
import {
  AnthropicSseEmitter,
  OpenAIAnthropicStreamBridge,
  OpenAIStreamConverter,
  SseParser
} from "../../src/gateway/streaming.js";

interface ParsedOutputEvent {
  event: string;
  data: Record<string, any>;
}

function parseOutput(output: string[]): ParsedOutputEvent[] {
  const parser = new SseParser();
  return parser.push(output.join("")).map((event) => ({
    event: event.event,
    data: JSON.parse(event.data)
  }));
}

function openAIEvent(payload: unknown, newline = "\n"): string {
  return `data: ${JSON.stringify(payload)}${newline}${newline}`;
}

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";

describe("SSE parser", () => {
  it("frames split CRLF events, multiple events, multiline data, comments, and DONE", () => {
    const parser = new SseParser();
    expect(parser.push(": keepalive\r")).toEqual([]);
    expect(parser.push("\ndata: {\"a\":\r\ndata: 1}\r\n\r\ndata: [DO")).toEqual([
      { event: "message", data: "{\"a\":\n1}" }
    ]);
    expect(parser.push("NE]\n\n")).toEqual([{ event: "message", data: "[DONE]" }]);
  });

  it("flushes a final event without a trailing blank line", () => {
    const parser = new SseParser();
    expect(parser.push("event: error\ndata: {\"message\":\"x\"}")).toEqual([]);
    expect(parser.finish()).toEqual([{ event: "error", data: "{\"message\":\"x\"}" }]);
  });
});

describe("OpenAI stream conversion", () => {
  it("treats nullable delta tool_calls as absent", () => {
    const bridge = new OpenAIAnthropicStreamBridge({ messageId: "request_mimo", model: "mimo-v2.5-pro" });
    const output = [
      ...bridge.push(openAIEvent({
        id: "chatcmpl_mimo",
        model: "mimo-v2.5-pro",
        choices: [{
          index: 0,
          delta: { content: "你好", tool_calls: null, reasoning_content: "reasoning" },
          finish_reason: "stop"
        }]
      })),
      ...bridge.push(openAIEvent({
        id: "chatcmpl_mimo",
        model: "mimo-v2.5-pro",
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 4 }
      })),
      ...bridge.push("data: [DONE]\n\n"),
      ...bridge.finish()
    ];
    const events = parseOutput(output);

    expect(events.some((event) => event.event === "error")).toBe(false);
    expect(events.find((event) => event.event === "content_block_delta")?.data.delta).toEqual({
      type: "text_delta",
      text: "你好"
    });
    expect(events.at(-1)?.event).toBe("message_stop");
  });

  it("emits a complete Anthropic text stream with delta before same-chunk finish and final usage", () => {
    const bridge = new OpenAIAnthropicStreamBridge({ messageId: "request_1", model: "fallback" });
    const first = openAIEvent({
      id: "chatcmpl_1",
      model: "gpt-5",
      choices: [{ index: 0, delta: { content: "hello" }, finish_reason: "stop" }]
    }, "\r\n");
    const usage = openAIEvent({
      id: "chatcmpl_1",
      model: "gpt-5",
      choices: [],
      usage: { prompt_tokens: 8, completion_tokens: 2 }
    });
    const wire = `${first}${usage}data: [DONE]\n\n`;
    const output = [
      ...bridge.push(wire.slice(0, 19)),
      ...bridge.push(wire.slice(19, 73)),
      ...bridge.push(wire.slice(73)),
      ...bridge.finish()
    ];
    const events = parseOutput(output);

    expect(events.map((event) => event.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop"
    ]);
    expect(events[0].data.message).toMatchObject({ id: "msg_chatcmpl_1", model: "gpt-5" });
    expect(events[2].data.delta).toEqual({ type: "text_delta", text: "hello" });
    expect(events[4].data).toMatchObject({
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { input_tokens: 8, output_tokens: 2 }
    });
  });

  it("parses DeepSeek prompt_cache_hit_tokens in OpenAI Chat terminal usage chunk", () => {
    const bridge = new OpenAIAnthropicStreamBridge({ messageId: "request_ds", model: "deepseek-chat" });
    const first = openAIEvent({
      id: "chatcmpl_ds",
      model: "deepseek-chat",
      choices: [{ index: 0, delta: { content: "streaming ds" }, finish_reason: "stop" }]
    });
    const usage = openAIEvent({
      id: "chatcmpl_ds",
      model: "deepseek-chat",
      choices: [],
      usage: {
        prompt_tokens: 50,
        completion_tokens: 10,
        prompt_cache_hit_tokens: 40,
        prompt_cache_miss_tokens: 10
      }
    });
    const wire = `${first}${usage}data: [DONE]\n\n`;
    const events = parseOutput([...bridge.push(wire), ...bridge.finish()]);

    expect(events.at(-2)?.data).toMatchObject({
      delta: { stop_reason: "end_turn" },
      usage: {
        input_tokens: 50,
        output_tokens: 10,
        cache_read_input_tokens: 40
      }
    });
    expect(bridge.usage).toEqual({
      inputTokens: 50,
      outputTokens: 10,
      cacheReadInputTokens: 40,
      cacheMissInputTokens: 10
    });
  });

  it("parses Gemini metadata in OpenAI Chat terminal usage chunk", () => {
    const bridge = new OpenAIAnthropicStreamBridge({ messageId: "request_gemini", model: "gemini-2.5-flash" });
    const first = openAIEvent({
      id: "chatcmpl_gemini",
      model: "gemini-2.5-flash",
      choices: [{ index: 0, delta: { content: "streaming gemini" }, finish_reason: "stop" }]
    });
    const usage = openAIEvent({
      id: "chatcmpl_gemini",
      model: "gemini-2.5-flash",
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 15,
        billing_usage: {
          gemini_usage_metadata: {
            cachedContentTokenCount: 80
          }
        }
      }
    });
    const wire = `${first}${usage}data: [DONE]\n\n`;
    const events = parseOutput([...bridge.push(wire), ...bridge.finish()]);

    expect(events.at(-2)?.data).toMatchObject({
      delta: { stop_reason: "end_turn" },
      usage: {
        input_tokens: 100,
        output_tokens: 15,
        cache_read_input_tokens: 80
      }
    });
    expect(bridge.usage).toEqual({
      inputTokens: 100,
      outputTokens: 15,
      cacheReadInputTokens: 80
    });
  });

  it("tracks multiple tool indexes, buffers arguments until fragmented names arrive, and restores names", () => {
    const toolNames = createToolNameMapping(["mcp.alpha", "mcp.beta"]);
    const converter = new OpenAIStreamConverter({ messageId: "req", model: "gpt", toolNames });
    const emitter = new AnthropicSseEmitter();
    const canonical = [
      ...converter.processChunk({
        id: "chatcmpl_tools",
        model: "gpt",
        choices: [{ index: 0, delta: { tool_calls: [
          { index: 0, id: "call:0", function: { name: "mcp_", arguments: "{\"a\":" } },
          { index: 1, id: "call_1", function: { name: "mcp_" } }
        ] }, finish_reason: null }]
      }),
      ...converter.processChunk({
        choices: [{ index: 0, delta: { tool_calls: [
          { index: 0, function: { name: "alpha" } },
          { index: 1, function: { name: "beta", arguments: "{\"b\":" } }
        ] }, finish_reason: null }]
      }),
      ...converter.processChunk({
        choices: [{ index: 0, delta: { tool_calls: [
          { index: 0, function: { arguments: "1}" } },
          { index: 1, function: { arguments: "2}" } }
        ] }, finish_reason: "tool_calls" }]
      }),
      ...converter.processChunk({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 6 } }),
      ...converter.finish("done")
    ];
    const events = parseOutput(canonical.flatMap((event) => emitter.emit(event)));
    const starts = events.filter((event) => event.event === "content_block_start");
    const deltas = events.filter((event) => event.event === "content_block_delta");

    expect(starts.map((event) => event.data.content_block)).toEqual([
      expect.objectContaining({ type: "tool_use", name: "mcp.alpha" }),
      expect.objectContaining({ type: "tool_use", name: "mcp.beta", id: "call_1" })
    ]);
    expect(starts[0].data.content_block.id).toMatch(/^call_0_[a-f0-9]{8}$/);
    expect(deltas.map((event) => event.data.delta.partial_json)).toEqual([
      "{\"a\":", "1}", "{\"b\":", "2}"
    ]);
    expect(events.at(-2)?.data).toMatchObject({
      delta: { stop_reason: "tool_use" },
      usage: { input_tokens: 12, output_tokens: 6 }
    });
  });

  it("treats nullable tool-call delta fields as absent", () => {
    const converter = new OpenAIStreamConverter({ messageId: "req", model: "mimo-v2.5-pro" });
    const events = [
      ...converter.processChunk({
        id: "chatcmpl_mimo_tool",
        model: "mimo-v2.5-pro",
        choices: [{ index: 0, delta: { tool_calls: [{
          index: 0,
          id: "call_mimo",
          type: "function",
          function: { name: "echo", arguments: "" }
        }] }, finish_reason: null }]
      }),
      ...converter.processChunk({
        choices: [{ index: 0, delta: { tool_calls: [{
          index: 0,
          id: null,
          type: "function",
          function: { name: null, arguments: "{\"text\":" }
        }] }, finish_reason: null }]
      }),
      ...converter.processChunk({
        choices: [{ index: 0, delta: { tool_calls: [{
          index: 0,
          id: null,
          type: "function",
          function: { name: null, arguments: "\"hello\"}" }
        }] }, finish_reason: "tool_calls" }]
      }),
      ...converter.finish("done")
    ];

    expect(events).toContainEqual({
      type: "tool_start",
      blockKey: "tool:0",
      id: "call_mimo",
      name: "echo"
    });
    expect(events.filter((event) => event.type === "tool_arguments_delta")).toEqual([
      { type: "tool_arguments_delta", blockKey: "tool:0", partialJson: "{\"text\":" },
      { type: "tool_arguments_delta", blockKey: "tool:0", partialJson: "\"hello\"}" }
    ]);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool_use" });
  });

  it("finishes successfully on EOF when finish_reason was received without DONE", () => {
    const bridge = new OpenAIAnthropicStreamBridge({ messageId: "req", model: "gpt" });
    const output = [
      ...bridge.push(openAIEvent({
        id: "x",
        model: "gpt",
        choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }]
      })),
      ...bridge.finish()
    ];
    expect(parseOutput(output).map((event) => event.event).at(-1)).toBe("message_stop");
  });

  it("does not mistake a complete tool-name prefix for the end of a fragmented longer name", () => {
    const toolNames = createToolNameMapping(["get", "get_weather"]);
    const converter = new OpenAIStreamConverter({ messageId: "req", model: "gpt", toolNames });
    const first = converter.processChunk({
      id: "x",
      choices: [{ index: 0, delta: { tool_calls: [{
        index: 0,
        id: "call_1",
        function: { name: "get", arguments: "{\"city\":" }
      }] }, finish_reason: null }]
    });
    const second = converter.processChunk({
      choices: [{ index: 0, delta: { tool_calls: [{
        index: 0,
        function: { name: "_weather" }
      }] }, finish_reason: null }]
    });
    const third = converter.processChunk({
      choices: [{ index: 0, delta: { tool_calls: [{
        index: 0,
        function: { arguments: "\"Paris\"}" }
      }] }, finish_reason: "tool_calls" }]
    });

    expect([...first, ...second].some((event) => event.type === "tool_start")).toBe(false);
    expect(third).toContainEqual(expect.objectContaining({ type: "tool_start", name: "get_weather" }));
    expect(converter.finish("done").at(-1)).toEqual({ type: "finish", reason: "tool_use" });
  });

  it("emits one error and no normal terminal sequence for incomplete streams", () => {
    const bridge = new OpenAIAnthropicStreamBridge({ messageId: "req", model: "gpt" });
    const output = [
      ...bridge.push(openAIEvent({
        id: "x",
        model: "gpt",
        choices: [{ index: 0, delta: { content: "payload says message_stop" }, finish_reason: null }]
      })),
      ...bridge.finish()
    ];
    const events = parseOutput(output);
    expect(events.at(-1)).toMatchObject({
      event: "error",
      data: { error: { type: "api_error" } }
    });
    expect(events.some((event) => event.event === "message_stop")).toBe(false);
  });

  it.each([
    ["invalid JSON SSE", "data: {bad}\n\n", "Upstream SSE data is not valid JSON."],
    ["explicit upstream error", "event: error\ndata: {\"error\":{\"message\":\"provider broke\"}}\n\n", "provider broke"]
  ])("converts %s to an Anthropic error event", (_name, wire, message) => {
    const bridge = new OpenAIAnthropicStreamBridge({ messageId: "req", model: "gpt" });
    const events = parseOutput([...bridge.push(wire), ...bridge.finish()]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: "error", data: { error: { message } } });
  });

  it("rejects invalid final tool argument JSON without message_stop", () => {
    const bridge = new OpenAIAnthropicStreamBridge({ messageId: "req", model: "gpt" });
    const output = [
      ...bridge.push(openAIEvent({
        id: "x",
        model: "gpt",
        choices: [{ index: 0, delta: { tool_calls: [{
          index: 0,
          id: "call_1",
          function: { name: "tool", arguments: "{" }
        }] }, finish_reason: "tool_calls" }]
      })),
      ...bridge.push("data: [DONE]\n\n"),
      ...bridge.finish()
    ];
    const events = parseOutput(output);
    expect(events.at(-1)?.event).toBe("error");
    expect(events.at(-1)?.data.error.message).toContain("Invalid JSON object");
    expect(events.some((event) => event.event === "message_stop")).toBe(false);
  });
});

function responsesEvent(type: string, payload: Record<string, unknown>, includePayloadType = true): string {
  return `event: ${type}\ndata: ${JSON.stringify(includePayloadType ? { type, ...payload } : payload)}\n\n`;
}

function responseEnvelope(overrides: Record<string, unknown> = {}) {
  return { id: "resp_1", model: "gpt-5", status: "in_progress", ...overrides };
}

describe("OpenAI Responses stream conversion", () => {
  it("converts fragmented text SSE using payload types and event-name fallback", () => {
    const bridge = new OpenAIResponsesAnthropicStreamBridge({ model: "fallback" });
    const wire = [
      responsesEvent("response.created", { response: responseEnvelope() }),
      responsesEvent("response.output_item.added", {
        output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", content: [] }
      }),
      responsesEvent("response.content_part.added", {
        item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "" }
      }, false),
      responsesEvent("response.output_text.delta", {
        item_id: "msg_1", output_index: 0, content_index: 0, delta: "hel"
      }),
      responsesEvent("response.output_text.delta", {
        item_id: "msg_1", output_index: 0, content_index: 0, delta: "lo"
      }),
      responsesEvent("response.output_text.done", {
        item_id: "msg_1", output_index: 0, content_index: 0, text: "hello"
      }),
      responsesEvent("response.output_item.done", {
        output_index: 0,
        item: { id: "msg_1", type: "message", content: [{ type: "output_text", text: "hello" }] }
      }),
      responsesEvent("response.completed", {
        response: responseEnvelope({
          status: "completed",
          usage: {
            input_tokens: 7,
            output_tokens: 2,
            input_tokens_details: { cached_tokens: 5, cache_write_tokens: 1 }
          }
        })
      })
    ].join("");
    const bytes = new TextEncoder().encode(wire);
    const output = [
      ...bridge.push(bytes.slice(0, 17)),
      ...bridge.push(bytes.slice(17, 103)),
      ...bridge.push(bytes.slice(103)),
      ...bridge.finish()
    ];
    const events = parseOutput(output);

    expect(events.map((event) => event.event)).toEqual([
      "message_start", "content_block_start", "content_block_delta", "content_block_delta",
      "content_block_stop", "message_delta", "message_stop"
    ]);
    expect(events.filter((event) => event.event === "content_block_delta").map((event) => event.data.delta.text))
      .toEqual(["hel", "lo"]);
    expect(events.at(-2)?.data).toMatchObject({
      delta: { stop_reason: "end_turn" },
      usage: {
        input_tokens: 7,
        output_tokens: 2,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 1
      }
    });
    expect(bridge.metadata.upstreamItemTypes).toEqual(["message"]);
    expect(bridge.metadata.upstreamEventTypes).toContain("response.completed");
  });

  it("keeps interleaved text and parallel function calls independent and restores names", () => {
    const toolNames = createToolNameMapping(["mcp.alpha", "mcp.beta"]);
    const bridge = new OpenAIResponsesAnthropicStreamBridge({ model: "gpt", toolNames });
    const wire = [
      responsesEvent("response.in_progress", { response: responseEnvelope() }),
      responsesEvent("response.output_item.added", {
        output_index: 0, item: { id: "msg", type: "message", content: [] }
      }),
      responsesEvent("response.content_part.added", {
        item_id: "msg", output_index: 0, content_index: 0, part: { type: "output_text", text: "" }
      }),
      responsesEvent("response.output_text.delta", {
        item_id: "msg", output_index: 0, content_index: 0, delta: "Checking "
      }),
      responsesEvent("response.output_item.added", {
        output_index: 1, item: { id: "fc_1", type: "function_call", call_id: "call:one", name: "mcp_alpha", arguments: "" }
      }),
      responsesEvent("response.output_item.added", {
        output_index: 2, item: { id: "fc_2", type: "function_call", call_id: "call_two", name: "mcp_beta", arguments: "" }
      }),
      responsesEvent("response.function_call_arguments.delta", {
        item_id: "fc_1", output_index: 1, delta: "{\"a\":"
      }),
      responsesEvent("response.output_text.delta", {
        item_id: "msg", output_index: 0, content_index: 0, delta: "tools"
      }),
      responsesEvent("response.function_call_arguments.delta", {
        item_id: "fc_2", output_index: 2, delta: "{\"b\":"
      }),
      responsesEvent("response.function_call_arguments.delta", {
        item_id: "fc_1", output_index: 1, delta: "1}"
      }),
      responsesEvent("response.function_call_arguments.done", {
        item_id: "fc_1", output_index: 1, arguments: "{\"a\":1}"
      }),
      responsesEvent("response.output_item.done", {
        output_index: 2,
        item: { id: "fc_2", type: "function_call", call_id: "call_two", name: "mcp_beta", arguments: "{\"b\":2}" }
      }),
      responsesEvent("response.completed", {
        response: responseEnvelope({ status: "completed", usage: { input_tokens: 11, output_tokens: 5 } })
      })
    ].join("");
    const events = parseOutput([...bridge.push(wire), ...bridge.finish()]);
    const starts = events.filter((event) => event.event === "content_block_start");
    const argumentDeltas = events
      .filter((event) => event.data.delta?.type === "input_json_delta")
      .map((event) => event.data.delta.partial_json);

    expect(starts.map((event) => event.data.content_block.type)).toEqual(["text", "tool_use", "tool_use"]);
    expect(starts[1].data.content_block).toMatchObject({ name: "mcp.alpha" });
    expect(starts[1].data.content_block.id).toMatch(/^call_one_[a-f0-9]{8}$/);
    expect(starts[2].data.content_block).toMatchObject({ name: "mcp.beta", id: "call_two" });
    expect(argumentDeltas).toEqual(["{\"a\":", "{\"b\":", "1}", "2}"]);
    expect(events.at(-2)?.data.delta.stop_reason).toBe("tool_use");
    expect(events.filter((event) => event.event === "content_block_stop")).toHaveLength(3);
    expect(bridge.metadata.upstreamItemTypes).toEqual(["message", "function_call"]);
  });

  it("accepts a complete function call supplied only by output_item.done", () => {
    const bridge = new OpenAIResponsesAnthropicStreamBridge({ model: "gpt" });
    const output = bridge.push([
      responsesEvent("response.created", { response: responseEnvelope() }),
      responsesEvent("response.output_item.added", {
        output_index: 0, item: { id: "fc", type: "function_call", call_id: "call_1", name: "tool" }
      }),
      responsesEvent("response.output_item.done", {
        output_index: 0,
        item: { id: "fc", type: "function_call", call_id: "call_1", name: "tool", arguments: "{}" }
      }),
      responsesEvent("response.completed", { response: responseEnvelope({ status: "completed" }) })
    ].join(""));
    const events = parseOutput(output);
    expect(events.some((event) => event.data.delta?.partial_json === "{}")).toBe(true);
    expect(events.at(-2)?.data.delta.stop_reason).toBe("tool_use");
  });

  it("records and ignores web search output items while streaming the final message", () => {
    const bridge = new OpenAIResponsesAnthropicStreamBridge({ model: "gpt" });
    const output = bridge.push([
      responsesEvent("response.created", { response: responseEnvelope() }),
      responsesEvent("response.output_item.added", {
        output_index: 0,
        item: { id: "ws_1", type: "web_search_call", status: "in_progress" }
      }),
      responsesEvent("response.output_item.done", {
        output_index: 0,
        item: { id: "ws_1", type: "web_search_call", status: "completed" }
      }),
      responsesEvent("response.output_item.added", {
        output_index: 1, item: { id: "msg", type: "message", content: [] }
      }),
      responsesEvent("response.content_part.added", {
        item_id: "msg", output_index: 1, content_index: 0, part: { type: "output_text", text: "" }
      }),
      responsesEvent("response.output_text.delta", {
        item_id: "msg", output_index: 1, content_index: 0, delta: "Found it"
      }),
      responsesEvent("response.completed", {
        response: responseEnvelope({ status: "completed", usage: { input_tokens: 9, output_tokens: 3 } })
      })
    ].join(""));
    const events = parseOutput(output);

    expect(events.some((event) => event.event === "error")).toBe(false);
    expect(events.some((event) => event.event === "message_stop")).toBe(true);
    expect(events.find((event) => event.event === "content_block_delta")?.data.delta.text).toBe("Found it");
    expect(bridge.metadata.upstreamItemTypes).toEqual(["web_search_call", "message"]);
  });

  it("parses DeepSeek and Gemini usage in Responses stream completed event", () => {
    const dsBridge = new OpenAIResponsesAnthropicStreamBridge({ model: "deepseek-reasoner" });
    const dsWire = [
      responsesEvent("response.created", { response: responseEnvelope() }),
      responsesEvent("response.output_item.added", {
        output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", content: [] }
      }),
      responsesEvent("response.content_part.added", {
        item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "ds text" }
      }),
      responsesEvent("response.output_item.done", {
        output_index: 0,
        item: { id: "msg_1", type: "message", content: [{ type: "output_text", text: "ds text" }] }
      }),
      responsesEvent("response.completed", {
        response: responseEnvelope({
          status: "completed",
          usage: {
            input_tokens: 150,
            output_tokens: 25,
            prompt_cache_hit_tokens: 120,
            prompt_cache_miss_tokens: 30
          }
        })
      })
    ].join("");
    const dsEvents = parseOutput([...dsBridge.push(dsWire), ...dsBridge.finish()]);
    expect(dsEvents.at(-2)?.data).toMatchObject({
      usage: {
        input_tokens: 150,
        output_tokens: 25,
        cache_read_input_tokens: 120
      }
    });
    expect(dsBridge.usage).toEqual({
      inputTokens: 150,
      outputTokens: 25,
      cacheReadInputTokens: 120,
      cacheMissInputTokens: 30
    });

    const geminiBridge = new OpenAIResponsesAnthropicStreamBridge({ model: "gemini-2.5-flash" });
    const geminiWire = [
      responsesEvent("response.created", { response: responseEnvelope() }),
      responsesEvent("response.output_item.added", {
        output_index: 0, item: { id: "msg_2", type: "message", role: "assistant", content: [] }
      }),
      responsesEvent("response.content_part.added", {
        item_id: "msg_2", output_index: 0, content_index: 0, part: { type: "output_text", text: "gemini text" }
      }),
      responsesEvent("response.output_item.done", {
        output_index: 0,
        item: { id: "msg_2", type: "message", content: [{ type: "output_text", text: "gemini text" }] }
      }),
      responsesEvent("response.completed", {
        response: responseEnvelope({
          status: "completed",
          usage: {
            input_tokens: 250,
            output_tokens: 35,
            usageMetadata: {
              cachedContentTokenCount: 200
            }
          }
        })
      })
    ].join("");
    const geminiEvents = parseOutput([...geminiBridge.push(geminiWire), ...geminiBridge.finish()]);
    expect(geminiEvents.at(-2)?.data).toMatchObject({
      usage: {
        input_tokens: 250,
        output_tokens: 35,
        cache_read_input_tokens: 200
      }
    });
    expect(geminiBridge.usage).toEqual({
      inputTokens: 250,
      outputTokens: 35,
      cacheReadInputTokens: 200
    });
  });

  it.each([
    ["incomplete max tokens", "response.incomplete", {
      response: responseEnvelope({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } })
    }, "max_tokens", false],
    ["other incomplete", "response.incomplete", {
      response: responseEnvelope({ status: "incomplete", incomplete_details: { reason: "content_filter" } })
    }, undefined, true],
    ["failed response", "response.failed", {
      response: responseEnvelope({ status: "failed", error: { message: "provider failed" } })
    }, undefined, true],
    ["response error", "response.error", { error: { message: "response errored" } }, undefined, true],
    ["bare error", "error", { message: "bare provider error" }, undefined, true]
  ])("handles %s terminal events", (_name, type, payload, stopReason, isError) => {
    const bridge = new OpenAIResponsesAnthropicStreamBridge({ model: "gpt" });
    const wire = `${responsesEvent("response.created", { response: responseEnvelope() })}${responsesEvent(type, payload)}`;
    const events = parseOutput([...bridge.push(wire), ...bridge.finish()]);
    expect(events.some((event) => event.event === "error")).toBe(isError);
    expect(events.some((event) => event.event === "message_stop")).toBe(!isError);
    if (stopReason) expect(events.at(-2)?.data.delta.stop_reason).toBe(stopReason);
  });

  it.each([
    ["malformed arguments", [
      responsesEvent("response.created", { response: responseEnvelope() }),
      responsesEvent("response.output_item.added", {
        output_index: 0, item: { id: "fc", type: "function_call", call_id: "call", name: "tool" }
      }),
      responsesEvent("response.function_call_arguments.done", {
        item_id: "fc", output_index: 0, arguments: "{"
      })
    ].join(""), "Invalid JSON object"],
    ["non-object arguments", [
      responsesEvent("response.created", { response: responseEnvelope() }),
      responsesEvent("response.output_item.added", {
        output_index: 0, item: { id: "fc", type: "function_call", call_id: "call", name: "tool" }
      }),
      responsesEvent("response.function_call_arguments.done", {
        item_id: "fc", output_index: 0, arguments: "[]"
      })
    ].join(""), "Expected a JSON object"],
    ["invalid usage", [
      responsesEvent("response.created", { response: responseEnvelope() }),
      responsesEvent("response.completed", {
        response: responseEnvelope({ status: "completed", usage: { input_tokens: -1, output_tokens: 0 } })
      })
    ].join(""), "non-negative safe integer"],
    ["unknown actionable item", [
      responsesEvent("response.created", { response: responseEnvelope() }),
      responsesEvent("response.output_item.added", {
        output_index: 0, item: { id: "computer", type: "computer_call" }
      })
    ].join(""), "Unsupported output item type"]
  ])("fails closed for %s", (_name, wire, message) => {
    const bridge = new OpenAIResponsesAnthropicStreamBridge({ model: "gpt" });
    const events = parseOutput([...bridge.push(wire), ...bridge.finish()]);
    expect(events.at(-1)).toMatchObject({ event: "error", data: { error: { message: expect.stringContaining(message) } } });
    expect(events.some((event) => event.event === "message_stop")).toBe(false);
  });

  it("ignores duplicate stop and terminal events", () => {
    const bridge = new OpenAIResponsesAnthropicStreamBridge({ model: "gpt" });
    const terminal = responsesEvent("response.completed", { response: responseEnvelope({ status: "completed" }) });
    const output = bridge.push([
      responsesEvent("response.created", { response: responseEnvelope() }),
      responsesEvent("response.output_item.added", {
        output_index: 0, item: { id: "msg", type: "message", content: [] }
      }),
      responsesEvent("response.content_part.added", {
        item_id: "msg", output_index: 0, content_index: 0, part: { type: "output_text", text: "ok" }
      }),
      responsesEvent("response.output_text.done", {
        item_id: "msg", output_index: 0, content_index: 0, text: "ok"
      }),
      responsesEvent("response.content_part.done", {
        item_id: "msg", output_index: 0, content_index: 0, part: { type: "output_text", text: "ok" }
      }),
      terminal,
      terminal
    ].join(""));
    const events = parseOutput([...output, ...bridge.finish()]);
    expect(events.filter((event) => event.event === "content_block_stop")).toHaveLength(1);
    expect(events.filter((event) => event.event === "message_stop")).toHaveLength(1);
  });

  it("errors on EOF without a terminal event", () => {
    const bridge = new OpenAIResponsesAnthropicStreamBridge({ model: "gpt" });
    const events = parseOutput([
      ...bridge.push(responsesEvent("response.created", { response: responseEnvelope() })),
      ...bridge.finish()
    ]);
    expect(events.at(-1)).toMatchObject({ event: "error", data: { error: { message: expect.stringContaining("terminal") } } });
    expect(events.some((event) => event.event === "message_stop")).toBe(false);
    expect(bridge.error?.code).toBe("missing_terminal_event");
    expect(bridge.metadata).toMatchObject({
      lastEventType: "response.created",
      terminalEventReceived: false
    });
  });

  it("records and ignores provider metadata events", () => {
    const converter = new OpenAIResponsesStreamConverter({ model: "gpt" });
    expect(converter.processSseEvent({
      event: "codex.rate_limits",
      data: JSON.stringify({ type: "codex.rate_limits", remaining: 42 })
    })).toEqual([]);
    converter.processSseEvent({ event: "response.created", data: JSON.stringify({
      type: "response.created", response: responseEnvelope()
    }) });
    expect(converter.processSseEvent({
      event: "codex.response.metadata",
      data: JSON.stringify({ type: "codex.response.metadata", provider: "aicodemirror" })
    })).toEqual([]);
    expect(converter.metadata.upstreamEventTypes).toEqual([
      "codex.rate_limits", "response.created", "codex.response.metadata"
    ]);
    expect(converter.metadata.lastEventType).toBe("codex.response.metadata");
  });

  it("converts a completed image generation item to one saved-image path", () => {
    const imageStore = new GeneratedImageStore({
      context: { homeDir: "C:\\ccp-test-home" }, requestId: "request-1", sessionId: "session-1"
    });
    const bridge = new OpenAIResponsesAnthropicStreamBridge({ model: "gpt", imageStore });
    const output = bridge.push([
      responsesEvent("response.created", { response: responseEnvelope() }),
      responsesEvent("response.output_item.added", {
        output_index: 0,
        item: { id: "image_1", type: "image_generation_call", status: "in_progress" }
      }),
      responsesEvent("response.image_generation_call.partial_image", {
        output_index: 0, item_id: "image_1", partial_image_index: 0, partial_image_b64: ONE_PIXEL_PNG
      }),
      responsesEvent("response.output_item.done", {
        output_index: 0,
        item: { id: "image_1", type: "image_generation_call", status: "completed", result: ONE_PIXEL_PNG }
      }),
      responsesEvent("response.completed", {
        response: responseEnvelope({
          status: "completed",
          output: [{ id: "image_1", type: "image_generation_call", status: "completed", result: ONE_PIXEL_PNG }]
        })
      })
    ].join(""));

    expect(bridge.error).toBeUndefined();
    expect(bridge.isTerminal).toBe(true);
    const images = bridge.takePreparedImages?.() ?? [];
    expect(images).toHaveLength(1);
    const text = parseOutput(output)
      .filter((event) => event.event === "content_block_delta")
      .map((event) => event.data.delta?.text ?? "")
      .join("");
    expect(text).toBe(`Generated image saved to:\n\`${images[0].path}\``);
    expect(output.join("").match(/Generated image saved to:/g)).toHaveLength(1);
    expect(output.join("")).not.toContain(ONE_PIXEL_PNG);
    expect(bridge.metadata).toMatchObject({
      upstreamItemTypes: ["image_generation_call"],
      lastEventType: "response.completed",
      terminalEventReceived: true
    });
  });

  it("accepts a done image result when a compatible proxy leaves status at generating", () => {
    const imageStore = new GeneratedImageStore({
      context: { homeDir: "C:\\ccp-test-home" }, requestId: "request-stale-status"
    });
    const bridge = new OpenAIResponsesAnthropicStreamBridge({ model: "gpt", imageStore });
    const output = bridge.push([
      responsesEvent("response.created", { response: responseEnvelope() }),
      responsesEvent("response.output_item.added", {
        output_index: 0,
        item: { id: "image_stale", type: "image_generation_call", status: "in_progress" }
      }),
      responsesEvent("response.image_generation_call.partial_image", {
        output_index: 0, item_id: "image_stale", partial_image_index: 0, partial_image_b64: ONE_PIXEL_PNG
      }),
      responsesEvent("response.output_item.done", {
        output_index: 0,
        item: { id: "image_stale", type: "image_generation_call", status: "generating", result: ONE_PIXEL_PNG }
      }),
      responsesEvent("response.completed", {
        response: responseEnvelope({
          status: "completed",
          output: [{
            id: "image_stale", type: "image_generation_call", status: "generating", result: ONE_PIXEL_PNG
          }]
        })
      })
    ].join(""));

    expect(bridge.error).toBeUndefined();
    expect(bridge.isTerminal).toBe(true);
    expect(bridge.takePreparedImages?.()).toHaveLength(1);
    expect(output.join("").match(/Generated image saved to:/g)).toHaveLength(1);
  });

  it("still rejects a done generating image item without a final result", () => {
    const imageStore = new GeneratedImageStore({
      context: { homeDir: "C:\\ccp-test-home" }, requestId: "request-missing-result"
    });
    const bridge = new OpenAIResponsesAnthropicStreamBridge({ model: "gpt", imageStore });
    bridge.push([
      responsesEvent("response.created", { response: responseEnvelope() }),
      responsesEvent("response.output_item.added", {
        output_index: 0,
        item: { id: "image_missing", type: "image_generation_call", status: "in_progress" }
      }),
      responsesEvent("response.output_item.done", {
        output_index: 0,
        item: { id: "image_missing", type: "image_generation_call", status: "generating" }
      })
    ].join(""));

    expect(bridge.error?.message).toContain("Expected a non-empty string");
  });

  it("recovers a final image carried only by response.completed output", () => {
    const imageStore = new GeneratedImageStore({
      context: { homeDir: "C:\\ccp-test-home" }, requestId: "request-completed-only"
    });
    const bridge = new OpenAIResponsesAnthropicStreamBridge({ model: "gpt", imageStore });
    const output = bridge.push([
      responsesEvent("response.created", { response: responseEnvelope() }),
      responsesEvent("response.completed", {
        response: responseEnvelope({
          status: "completed",
          output: [{
            id: "image_completed_only",
            type: "image_generation_call",
            status: "completed",
            result: ONE_PIXEL_PNG
          }]
        })
      })
    ].join(""));

    expect(bridge.error).toBeUndefined();
    expect(bridge.takePreparedImages?.()).toHaveLength(1);
    expect(output.join("")).toContain("Generated image saved to:");
    expect(output.join("")).not.toContain(ONE_PIXEL_PNG);
  });

  it("does not replay completed function calls from response.completed output", () => {
    const bridge = new OpenAIResponsesAnthropicStreamBridge({ model: "gpt" });
    const call = {
      id: "fc_1",
      type: "function_call",
      call_id: "call_1",
      name: "image_generation",
      arguments: "{\"prompt\":\"space\"}"
    };
    const output = bridge.push([
      responsesEvent("response.created", { response: responseEnvelope() }),
      responsesEvent("response.output_item.added", { output_index: 0, item: call }),
      responsesEvent("response.output_item.done", { output_index: 0, item: call }),
      responsesEvent("response.completed", {
        response: responseEnvelope({ status: "completed", output: [call] })
      })
    ].join(""));

    expect(bridge.error).toBeUndefined();
    expect(bridge.isTerminal).toBe(true);
    expect(parseOutput(output).filter((event) => event.event === "content_block_start")).toHaveLength(1);
    expect(output.join("")).toContain('"stop_reason":"tool_use"');
  });

  it("tolerates keepalive/heartbeat and reasoning stream noise without failing", () => {
    const bridge = new OpenAIResponsesAnthropicStreamBridge({ model: "gpt" });
    const wire = [
      responsesEvent("response.created", { response: responseEnvelope() }),
      "event: keepalive\ndata: {}\n\n",
      'data: {"type":"keepalive"}\n\n',
      "event: ping\ndata: {}\n\n",
      responsesEvent("response.output_item.added", {
        output_index: 0,
        item: { id: "rs_1", type: "reasoning", summary: [] }
      }),
      responsesEvent("response.reasoning_summary_text.delta", {
        item_id: "rs_1", output_index: 0, summary_index: 0, delta: "thinking "
      }),
      responsesEvent("response.output_item.done", {
        output_index: 0,
        item: { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "thinking" }] }
      }),
      responsesEvent("response.output_item.added", {
        output_index: 1,
        item: { id: "msg", type: "message", role: "assistant", content: [] }
      }),
      responsesEvent("response.content_part.added", {
        item_id: "msg", output_index: 1, content_index: 0, part: { type: "output_text", text: "" }
      }),
      responsesEvent("response.output_text.delta", {
        item_id: "msg", output_index: 1, content_index: 0, delta: "OK"
      }),
      responsesEvent("response.output_text.done", {
        item_id: "msg", output_index: 1, content_index: 0, text: "OK"
      }),
      responsesEvent("response.completed", {
        response: responseEnvelope({
          status: "completed",
          usage: { input_tokens: 3, output_tokens: 1 }
        })
      })
    ].join("");

    const events = parseOutput([...bridge.push(wire), ...bridge.finish()]);
    expect(events.some((event) => event.event === "error")).toBe(false);
    expect(events.some((event) => event.event === "message_stop")).toBe(true);
    expect(events.map((event) => event.event)).toContain("content_block_delta");
    const text = events
      .filter((event) => event.event === "content_block_delta")
      .map((event) => (event.data as { delta?: { text?: string } }).delta?.text ?? "")
      .join("");
    expect(text).toBe("OK");
  });
});
