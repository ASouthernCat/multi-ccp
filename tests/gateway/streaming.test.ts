import { describe, expect, it } from "vitest";
import { createToolNameMapping } from "../../src/gateway/openai-target.js";
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
