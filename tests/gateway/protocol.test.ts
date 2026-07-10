import { describe, expect, it } from "vitest";
import { parseAnthropicMessagesRequest } from "../../src/gateway/anthropic-source.js";
import { GatewayProtocolError } from "../../src/gateway/errors.js";
import {
  canonicalResponseToAnthropic,
  createToolNameMapping,
  normalizeToolCallId,
  parseOpenAIChatResponse,
  serializeOpenAIChatRequest
} from "../../src/gateway/openai-target.js";

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    model: "claude-sonnet-test",
    max_tokens: 2048,
    messages: [{ role: "user", content: "Hello" }],
    ...overrides
  };
}

describe("Anthropic Messages source parser", () => {
  it("parses supported fields into canonical IR without forwarding cache metadata", () => {
    const request = parseAnthropicMessagesRequest(baseRequest({
      system: [
        { type: "text", text: "One", cache_control: { type: "ephemeral" } },
        { type: "text", text: "Two" }
      ],
      messages: [
        {
          role: "system",
          content: [{ type: "text", text: "Embedded" }]
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Calling " },
            { type: "tool_use", id: "toolu_1", name: "mcp.tool", input: { value: 1 } }
          ]
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "ok" }] },
            { type: "text", text: "Continue" }
          ]
        }
      ],
      temperature: 0,
      top_p: 0.9,
      stop_sequences: ["STOP"],
      stream: true,
      metadata: { user_id: "diagnostic-only" },
      output_config: { effort: "xhigh" },
      tools: [{
        name: "mcp.tool",
        description: "A tool",
        input_schema: { type: "object", properties: { value: { type: "number" } } },
        cache_control: { type: "ephemeral" }
      }],
      tool_choice: { type: "tool", name: "mcp.tool", disable_parallel_tool_use: true }
    }));

    expect(request).toMatchObject({
      clientModel: "claude-sonnet-test",
      system: ["One", "Two", "Embedded"],
      maxOutputTokens: 2048,
      temperature: 0,
      topP: 0.9,
      stop: ["STOP"],
      stream: true,
      outputConfig: { effort: "xhigh" },
      toolChoice: { mode: "tool", name: "mcp.tool", disableParallelToolUse: true }
    });
    expect(request.messages[1].content).toEqual([
      { type: "tool_result", toolUseId: "toolu_1", content: "ok" },
      { type: "text", text: "Continue" }
    ]);
    expect(request.tools?.[0]).toEqual({
      name: "mcp.tool",
      description: "A tool",
      inputSchema: { type: "object", properties: { value: { type: "number" } } }
    });
  });

  it.each([
    ["tool_result after text", baseRequest({ messages: [{ role: "user", content: [
      { type: "text", text: "before" },
      { type: "tool_result", tool_use_id: "toolu_1", content: "result" }
    ] }] }), "tool_result blocks must appear before text"],
    ["text after tool_use", baseRequest({ messages: [{ role: "assistant", content: [
      { type: "tool_use", id: "toolu_1", name: "Bash", input: {} },
      { type: "text", text: "after" }
    ] }] }), "text blocks after tool_use"],
    ["unsupported content", baseRequest({ messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", data: "x" } }
    ] }] }), "image content blocks are not supported"],
    ["unknown top field", baseRequest({ surprise: true }), "surprise: Extra inputs are not permitted"],
    ["tool schema extension", baseRequest({ tools: [{ name: "x", input_schema: {}, strict: true }] }), "tools[0].strict"],
    ["unknown named tool", baseRequest({
      tools: [{ name: "x", input_schema: {} }],
      tool_choice: { type: "tool", name: "y" }
    }), "Unknown tool 'y'"],
    ["duplicate tool", baseRequest({
      tools: [{ name: "x", input_schema: {} }, { name: "x", input_schema: {} }]
    }), "Duplicate tool name 'x'"],
    ["invalid max tokens", baseRequest({ max_tokens: 0 }), "max_tokens: Expected a positive integer"]
  ])("rejects %s", (_name, request, message) => {
    expect(() => parseAnthropicMessagesRequest(request)).toThrow(message as string);
  });

  it("keeps Claude Code adaptive-thinking retry semantics in the error", () => {
    try {
      parseAnthropicMessagesRequest(baseRequest({ thinking: { type: "adaptive" } }));
      throw new Error("Expected parser to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayProtocolError);
      expect((error as GatewayProtocolError).status).toBe(400);
      expect((error as GatewayProtocolError).error).toEqual({
        type: "invalid_request_error",
        message: "thinking.type: adaptive thinking is not supported by this gateway profile; Extra inputs are not permitted"
      });
    }
  });
});

describe("OpenAI Chat target serializer", () => {
  it("expands tool messages and maps tool choice, parallel intent, and compatibility fields", () => {
    const canonical = parseAnthropicMessagesRequest(baseRequest({
      system: "System",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "I will call it." },
            { type: "tool_use", id: "toolu_1", name: "mcp.tool", input: { a: true } }
          ]
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "failed", is_error: true },
            { type: "text", text: "Try again" }
          ]
        }
      ],
      tools: [{ name: "mcp.tool", input_schema: { type: "object" } }],
      tool_choice: { type: "any", disable_parallel_tool_use: true },
      stream: true,
      temperature: 0.2,
      top_p: 0.8,
      stop_sequences: ["done"]
    }));
    const converted = serializeOpenAIChatRequest(canonical, {
      model: "gpt-5",
      compatibility: {
        instructionRole: "system",
        maxTokensField: "max_tokens",
        streamUsage: "include"
      }
    });

    expect(converted.body).toMatchObject({
      model: "gpt-5",
      n: 1,
      stream: true,
      max_tokens: 2048,
      temperature: 0.2,
      top_p: 0.8,
      stop: ["done"],
      tool_choice: "required",
      parallel_tool_calls: false,
      stream_options: { include_usage: true }
    });
    expect(converted.body.messages).toEqual([
      { role: "system", content: "System" },
      {
        role: "assistant",
        content: "I will call it.",
        tool_calls: [{
          id: "toolu_1",
          type: "function",
          function: { name: "mcp_tool", arguments: "{\"a\":true}" }
        }]
      },
      { role: "tool", tool_call_id: "toolu_1", content: "Tool execution failed:\nfailed" },
      { role: "user", content: "Try again" }
    ]);
    expect(converted.body.tools).toEqual([{ type: "function", function: {
      name: "mcp_tool",
      parameters: { type: "object" }
    } }]);
    expect(converted.toolNames.targetToSource.get("mcp_tool")).toBe("mcp.tool");
  });

  it("omits optional sampling/stop/stream usage fields for incompatible providers", () => {
    const canonical = parseAnthropicMessagesRequest(baseRequest({
      temperature: 0.5,
      top_p: 0.8,
      stop_sequences: ["stop"],
      stream: true
    }));
    const { body } = serializeOpenAIChatRequest(canonical, {
      model: "provider-model",
      compatibility: { supportsSampling: false, supportsStop: false, streamUsage: "omit" }
    });
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.stop).toBeUndefined();
    expect(body.stream_options).toBeUndefined();
  });

  it("maps Anthropic effort and structured output to OpenAI fields", () => {
    const canonical = parseAnthropicMessagesRequest(baseRequest({
      output_config: {
        effort: "xhigh",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              result: { type: "string" },
              nested: {
                type: "object",
                properties: { count: { type: "number" } }
              }
            }
          }
        }
      }
    }));

    const { body } = serializeOpenAIChatRequest(canonical, {
      model: "gpt-reasoning",
      compatibility: {
        reasoningEffort: "reasoning_effort",
        structuredOutput: "response_format"
      }
    });

    expect(body.reasoning_effort).toBe("xhigh");
    expect(body.output_config).toBeUndefined();
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "structured_output",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["result", "nested"],
          properties: {
            result: { type: "string" },
            nested: {
              type: "object",
              additionalProperties: false,
              required: ["count"],
              properties: { count: { type: "number" } }
            }
          }
        }
      }
    });
  });

  it("supports provider-specific output_config and rejects unsupported structured output", () => {
    const effortOnly = parseAnthropicMessagesRequest(baseRequest({ output_config: { effort: "high" } }));
    const passthrough = serializeOpenAIChatRequest(effortOnly, {
      model: "provider-model",
      compatibility: { reasoningEffort: "output_config" }
    });
    expect(passthrough.body.output_config).toEqual({ effort: "high" });
    expect(passthrough.body.reasoning_effort).toBeUndefined();

    const structured = parseAnthropicMessagesRequest(baseRequest({
      output_config: { format: { type: "json_schema", schema: { type: "object", properties: {} } } }
    }));
    expect(() => serializeOpenAIChatRequest(structured, {
      model: "provider-model",
      compatibility: { structuredOutput: "unsupported" }
    })).toThrow("does not support structured outputs");
  });

  it("rejects a disable-parallel request when the provider cannot express it", () => {
    const canonical = parseAnthropicMessagesRequest(baseRequest({
      tools: [{ name: "x", input_schema: {} }],
      tool_choice: { type: "auto", disable_parallel_tool_use: true }
    }));
    expect(() => serializeOpenAIChatRequest(canonical, {
      model: "model",
      compatibility: { parallelToolCalls: "unsupported" }
    })).toThrow("does not support parallel_tool_calls");
  });

  it("normalizes tool names deterministically, resolves collisions, and stays within 64 chars", () => {
    const longName = `namespace.${"very-long-".repeat(8)}tool`;
    const mapping = createToolNameMapping(["mcp.a:b", "mcp.a.b", longName]);
    const values = [...mapping.sourceToTarget.values()];
    expect(new Set(values).size).toBe(3);
    expect(values.every((name) => /^[A-Za-z0-9_-]{1,64}$/.test(name))).toBe(true);
    for (const [source, target] of mapping.sourceToTarget) {
      expect(mapping.targetToSource.get(target)).toBe(source);
    }
  });
});

describe("OpenAI Chat non-streaming response", () => {
  it("treats nullable optional tool-call fields as absent", () => {
    const response = parseOpenAIChatResponse({
      id: "chatcmpl_nullable_tools",
      model: "mimo-v2.5-pro",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "你好",
          tool_calls: null,
          function_call: null,
          reasoning_content: "provider-specific reasoning"
        },
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 10, completion_tokens: 4 }
    });

    expect(response).toMatchObject({
      model: "mimo-v2.5-pro",
      content: [{ type: "text", text: "你好" }],
      finishReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 4 }
    });
  });

  it("restores tool names, normalizes ids, parses object arguments, and emits Anthropic format", () => {
    const toolNames = createToolNameMapping(["mcp.tool"]);
    const response = parseOpenAIChatResponse({
      id: "chatcmpl_123",
      model: "gpt-5",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "Working. ",
          refusal: "Refused remainder.",
          tool_calls: [{
            id: "call:1 bad",
            type: "function",
            function: { name: "mcp_tool", arguments: "{\"path\":\"C:\\\\tmp\"}" }
          }]
        },
        finish_reason: "tool_calls"
      }],
      usage: { prompt_tokens: 10, completion_tokens: 4 }
    }, { toolNames });

    expect(response).toEqual({
      id: "msg_chatcmpl_123",
      model: "gpt-5",
      content: [
        { type: "text", text: "Working. " },
        { type: "text", text: "Refused remainder." },
        {
          type: "tool_use",
          id: normalizeToolCallId("call:1 bad"),
          name: "mcp.tool",
          input: { path: "C:\\tmp" }
        }
      ],
      finishReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 4 }
    });
    expect(canonicalResponseToAnthropic(response)).toMatchObject({
      type: "message",
      role: "assistant",
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 4 }
    });
  });

  it.each([
    [{ id: "x", model: "m", choices: [] }, "response.choices"],
    [{ id: "x", model: "m", choices: [{ message: {}, finish_reason: null }] }, "finish_reason"],
    [{
      id: "x", model: "m", choices: [{
        message: { tool_calls: [{ id: "c", function: { name: "x", arguments: "[]" } }] },
        finish_reason: "tool_calls"
      }]
    }, "Expected a JSON object"],
    [{
      id: "x", model: "m", choices: [{
        message: { tool_calls: [{ id: "c", function: { name: "x", arguments: "{" } }] },
        finish_reason: "tool_calls"
      }]
    }, "Invalid JSON object"]
  ])("fails closed for malformed upstream responses", (response, message) => {
    expect(() => parseOpenAIChatResponse(response)).toThrow(message);
  });
});
