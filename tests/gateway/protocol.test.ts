import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseAnthropicMessagesRequest } from "../../src/gateway/anthropic-source.js";
import { GatewayProtocolError } from "../../src/gateway/errors.js";
import { GeneratedImageStore } from "../../src/gateway/generated-image.js";
import {
  parseOpenAIResponsesResponse,
  parseOpenAIResponsesResponseWithMetadata,
  serializeOpenAIResponsesRequest
} from "../../src/gateway/openai-responses-target.js";
import {
  canonicalResponseToAnthropic,
  createToolNameMapping,
  normalizeToolCallId
} from "../../src/gateway/utils.js";
import {
  parseOpenAIChatResponse,
  serializeOpenAIChatRequest
} from "../../src/gateway/openai-chat-target.js";


function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    model: "claude-sonnet-test",
    max_tokens: 2048,
    messages: [{ role: "user", content: "Hello" }],
    ...overrides
  };
}

function claudeCodeFixture(name: string): { request: Record<string, unknown> } {
  return JSON.parse(readFileSync(
    path.resolve(`tests/fixtures/claude-code/2.1.209/${name}.request.json`),
    "utf8"
  )) as { request: Record<string, unknown> };
}

describe("Claude Code request contract fixtures", () => {
  it("preserves ordinary image structure across Responses and Chat targets", () => {
    const source = claudeCodeFixture("ordinary-image").request;
    const canonical = parseAnthropicMessagesRequest(source);
    const responses = serializeOpenAIResponsesRequest(canonical, { model: "responses-model" }).body;
    const chat = serializeOpenAIChatRequest(canonical, { model: "chat-model" }).body;
    const responsesText = JSON.stringify(responses);
    const chatText = JSON.stringify(chat);

    expect(responsesText).toContain("input_image");
    expect(responsesText).toContain("data:image/png;base64,");
    expect(chatText).toContain("image_url");
    expect(chatText).toContain("data:image/png;base64,");
    expect(responsesText).not.toContain("[Image:");
    expect(chatText).not.toContain("[Image:");
  });

  it("preserves parallel image tool results without placeholder degradation", () => {
    const source = claudeCodeFixture("image-tool-result").request;
    const canonical = parseAnthropicMessagesRequest(source);
    const responses = serializeOpenAIResponsesRequest(canonical, { model: "responses-model" }).body;
    const chat = serializeOpenAIChatRequest(canonical, { model: "chat-model" }).body;

    expect(JSON.stringify(responses)).toContain("function_call_output");
    expect(JSON.stringify(responses)).toContain("input_image");
    expect(JSON.stringify(chat)).toContain("Tool result toolu_image:");
    expect(JSON.stringify(chat)).toContain("image_url");
    expect(JSON.stringify({ responses, chat })).not.toContain("[Image:");
  });
});

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
        cache_control: { type: "ephemeral" },
        max_uses: 1
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
    expect(JSON.stringify(request)).not.toContain("max_uses");
  });

  it("parses Anthropic web search server tools without treating them as custom functions", () => {
    const request = parseAnthropicMessagesRequest(baseRequest({
      tools: [{
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 3,
        allowed_domains: ["threejs.org"],
        blocked_domains: ["example.test"],
        user_location: { type: "approximate", country: "US" }
      }],
      tool_choice: { type: "tool", name: "web_search" }
    }));

    expect(request.tools?.[0]).toEqual({
      kind: "web_search",
      name: "web_search",
      filters: {
        allowedDomains: ["threejs.org"],
        blockedDomains: ["example.test"]
      },
      userLocation: { type: "approximate", country: "US" }
    });
    expect(request.toolChoice).toEqual({ mode: "tool", name: "web_search" });
    expect(JSON.stringify(request)).not.toContain("max_uses");
  });

  it("parses ordinary and tool-result images into shared canonical input parts", () => {
    const request = parseAnthropicMessagesRequest(baseRequest({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_image", name: "Read", input: { file_path: "asset.png" } }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_image",
              content: [
                { type: "text", text: "Preview:" },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "iVBORw0KGgo="
                  }
                }
              ]
            },
            { type: "text", text: "Compare " },
            {
              type: "image",
              source: { type: "url", url: "https://example.com/original.webp" }
            },
            { type: "text", text: " carefully." }
          ]
        }
      ],
      tools: [{
        type: "custom",
        name: "Read",
        description: "Read a file",
        input_schema: { type: "object", properties: { file_path: { type: "string" } } }
      }]
    }));

    expect(request.tools?.[0]).toEqual({
      name: "Read",
      description: "Read a file",
      inputSchema: { type: "object", properties: { file_path: { type: "string" } } }
    });
    expect(request.messages[1].content).toEqual([
      {
        type: "tool_result",
        toolUseId: "toolu_image",
        content: [
          { type: "text", text: "Preview:" },
          {
            type: "image",
            source: {
              type: "base64",
              mediaType: "image/png",
              data: "iVBORw0KGgo="
            }
          }
        ]
      },
      { type: "text", text: "Compare " },
      {
        type: "image",
        source: { type: "url", url: "https://example.com/original.webp" }
      },
      { type: "text", text: " carefully." }
    ]);
  });

  it("drops historical assistant thinking blocks while preserving visible content", () => {
    const request = parseAnthropicMessagesRequest(baseRequest({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hidden reasoning", signature: "sig_1" },
            { type: "redacted_thinking", data: "redacted" },
            { type: "text", text: "Visible answer." },
            { type: "tool_use", id: "toolu_1", name: "mcp.tool", input: { value: 1 } }
          ]
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "thinking-only history", signature: "sig_2" }
          ]
        },
        { role: "user", content: "Continue" }
      ],
      tools: [{ name: "mcp.tool", input_schema: { type: "object" } }]
    }));

    expect(request.messages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Visible answer." },
          { type: "tool_use", id: "toolu_1", name: "mcp.tool", input: { value: 1 } }
        ]
      },
      { role: "user", content: [{ type: "text", text: "Continue" }] }
    ]);
    expect(JSON.stringify(request)).not.toContain("hidden reasoning");
    expect(JSON.stringify(request)).not.toContain("thinking-only history");
  });

  it.each([
    ["tool_result after ordinary text", baseRequest({ messages: [{ role: "user", content: [
      { type: "text", text: "before" },
      { type: "tool_result", tool_use_id: "toolu_1", content: "result" }
    ] }] }), "tool_result blocks must appear before ordinary content"],
    ["tool_result after ordinary image", baseRequest({ messages: [{ role: "user", content: [
      { type: "image", source: { type: "url", url: "https://example.com/before.png" } },
      { type: "tool_result", tool_use_id: "toolu_1", content: "result" }
    ] }] }), "tool_result blocks must appear before ordinary content"],
    ["text after tool_use", baseRequest({ messages: [{ role: "assistant", content: [
      { type: "tool_use", id: "toolu_1", name: "Bash", input: {} },
      { type: "text", text: "after" }
    ] }] }), "text blocks after tool_use"],
    ["image in assistant message", baseRequest({ messages: [{ role: "assistant", content: [
      { type: "image", source: { type: "url", url: "https://example.com/image.png" } }
    ] }] }), "image is only valid in user messages"],
    ["base64 source with url field", baseRequest({ messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "x", url: "https://example.com/x" } }
    ] }] }), "source.url: Extra inputs are not permitted"],
    ["url source with base64 field", baseRequest({ messages: [{ role: "user", content: [
      { type: "image", source: { type: "url", url: "https://example.com/x", data: "x" } }
    ] }] }), "source.data: Extra inputs are not permitted"],
    ["unsupported image media type", baseRequest({ messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/svg+xml", data: "x" } }
    ] }] }), "Unsupported image media type 'image/svg+xml'"],
    ["non-http image url", baseRequest({ messages: [{ role: "user", content: [
      { type: "image", source: { type: "url", url: "data:image/png;base64,x" } }
    ] }] }), "Expected a valid HTTP(S) URL"],
    ["unsupported tool result image source", baseRequest({ messages: [{ role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_1", content: [
        { type: "image", source: { type: "file", file_id: "file_1" } }
      ] }
    ] }] }), "Unsupported image source 'file'"],
    ["thinking in user message", baseRequest({ messages: [{ role: "user", content: [
      { type: "thinking", thinking: "invalid" }
    ] }] }), "thinking content blocks are not supported"],
    ["unsupported tool type", baseRequest({ tools: [{ type: "server", name: "x", input_schema: {} }] }), "Unsupported tool type 'server'"],
    ["unknown top field", baseRequest({ surprise: true }), "surprise: Extra inputs are not permitted"],
    ["tool schema extension", baseRequest({ tools: [{ name: "x", input_schema: {}, strict: true }] }), "tools[0].strict"],
    ["invalid tool max_uses", baseRequest({ tools: [{ name: "x", input_schema: {}, max_uses: 0 }] }), "tools[0].max_uses"],
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

  it("accepts Claude Code auto-mode requests with thinking disabled", () => {
    expect(parseAnthropicMessagesRequest(baseRequest({
      thinking: { type: "disabled" }
    }))).toMatchObject({
      clientModel: "claude-sonnet-test",
      stream: false
    });
  });

  it("rejects extra fields on disabled thinking", () => {
    expect(() => parseAnthropicMessagesRequest(baseRequest({
      thinking: { type: "disabled", budget_tokens: 0 }
    }))).toThrow("thinking.budget_tokens: Extra inputs are not permitted");
  });
});

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";

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

  it("keeps tool messages textual and emits one attributed multimodal user message", () => {
    const canonical = parseAnthropicMessagesRequest(baseRequest({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_one", name: "Read", input: { file_path: "one.png" } },
            { type: "tool_use", id: "toolu_two", name: "Read", input: { file_path: "two.webp" } }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_one",
              content: [
                { type: "text", text: "First preview" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }
              ]
            },
            {
              type: "tool_result",
              tool_use_id: "toolu_two",
              content: [
                { type: "text", text: "Second preview" },
                { type: "image", source: { type: "url", url: "https://example.com/tool.webp" } }
              ],
              is_error: true
            },
            { type: "text", text: "Compare " },
            { type: "image", source: { type: "url", url: "https://example.com/original.jpg" } },
            { type: "text", text: "to both." }
          ]
        }
      ],
      tools: [{ name: "Read", input_schema: { type: "object" } }]
    }));
    const converted = serializeOpenAIChatRequest(canonical, { model: "gpt-5" });

    expect(converted.body.messages).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "toolu_one",
            type: "function",
            function: { name: "Read", arguments: "{\"file_path\":\"one.png\"}" }
          },
          {
            id: "toolu_two",
            type: "function",
            function: { name: "Read", arguments: "{\"file_path\":\"two.webp\"}" }
          }
        ]
      },
      { role: "tool", tool_call_id: "toolu_one", content: "First preview" },
      { role: "tool", tool_call_id: "toolu_two", content: "Tool execution failed:\nSecond preview" },
      {
        role: "user",
        content: [
          { type: "text", text: "Tool result toolu_one:" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AAAA", detail: "auto" }
          },
          { type: "text", text: "Tool result toolu_two:" },
          {
            type: "image_url",
            image_url: { url: "https://example.com/tool.webp", detail: "auto" }
          },
          { type: "text", text: "Compare " },
          {
            type: "image_url",
            image_url: { url: "https://example.com/original.jpg", detail: "auto" }
          },
          { type: "text", text: "to both." }
        ]
      }
    ]);
  });

  it("maps an ordinary user image to nested image_url while preserving order", () => {
    const canonical = parseAnthropicMessagesRequest(baseRequest({
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Before" },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } },
          { type: "text", text: "After" }
        ]
      }]
    }));

    expect(serializeOpenAIChatRequest(canonical, { model: "gpt-5" }).body.messages).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "Before" },
        {
          type: "image_url",
          image_url: { url: "data:image/jpeg;base64,BBBB", detail: "auto" }
        },
        { type: "text", text: "After" }
      ]
    }]);
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

describe("OpenAI Responses target", () => {
  it("serializes typed input, tools, capabilities, and strict output", () => {
    const canonical = parseAnthropicMessagesRequest(baseRequest({
      system: "Be concise.",
      messages: [
        { role: "assistant", content: [
          { type: "text", text: "Calling" },
          { type: "tool_use", id: "call:1", name: "mcp.tool", input: { value: 1 } }
        ] },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "call:1", content: "ok" },
          { type: "text", text: "Continue" }
        ] }
      ],
      tools: [{ name: "mcp.tool", description: "A tool", input_schema: {
        type: "object", properties: { value: { type: "number" } }
      } }],
      tool_choice: { type: "tool", name: "mcp.tool", disable_parallel_tool_use: true },
      output_config: {
        effort: "high",
        format: { type: "json_schema", schema: { type: "object", properties: { answer: { type: "string" } } } }
      },
      temperature: 0.2,
      top_p: 0.8
    }));
    const converted = serializeOpenAIResponsesRequest(canonical, {
      model: "gpt-5",
      compatibility: { supportsSampling: true }
    });

    expect(converted.body).toMatchObject({
      model: "gpt-5",
      instructions: "Be concise.",
      max_output_tokens: 2048,
      stream: false,
      store: false,
      temperature: 0.2,
      top_p: 0.8,
      tool_choice: { type: "function", name: "mcp_tool" },
      parallel_tool_calls: false,
      reasoning: { effort: "high" },
      text: { format: {
        type: "json_schema", name: "structured_output", strict: true,
        schema: { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "string" } } }
      } }
    });
    expect(converted.body.input).toEqual([
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Calling" }] },
      { type: "function_call", call_id: "call_1_0af63155", name: "mcp_tool", arguments: "{\"value\":1}" },
      { type: "function_call_output", call_id: "call_1_0af63155", output: "ok" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] }
    ]);
    // Default toolStrict is non_strict: preserve Claude optional-field schemas.
    expect(converted.body.tools).toEqual([{
      type: "function", name: "mcp_tool", description: "A tool", strict: false,
      parameters: { type: "object", properties: { value: { type: "number" } } }
    }]);
    expect(converted.body.stop).toBeUndefined();
  });

  it("serializes Anthropic web search server tools as Responses hosted web_search", () => {
    const canonical = parseAnthropicMessagesRequest(baseRequest({
      tools: [{
        type: "web_search_20250305",
        name: "web_search",
        allowed_domains: ["threejs.org"],
        user_location: { type: "approximate", country: "US" }
      }],
      tool_choice: { type: "tool", name: "web_search" }
    }));
    const converted = serializeOpenAIResponsesRequest(canonical, { model: "gpt-5.6" });

    expect(converted.body.tools).toEqual([{
      type: "web_search",
      filters: { allowed_domains: ["threejs.org"] },
      user_location: { type: "approximate", country: "US" }
    }]);
    expect(converted.body.tool_choice).toEqual({ type: "web_search" });
    expect(converted.toolNames.sourceToTarget.size).toBe(0);
    expect(JSON.stringify(converted.body)).not.toContain("max_uses");
  });

  it("uses native input_image parts for ordinary and function-call-output images", () => {
    const canonical = parseAnthropicMessagesRequest(baseRequest({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_image", name: "Read", input: { file_path: "asset.png" } }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_image",
              content: [
                { type: "text", text: "Preview:" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
                { type: "text", text: " done" }
              ],
              is_error: true
            },
            { type: "text", text: "Compare " },
            { type: "image", source: { type: "url", url: "https://example.com/original.webp" } },
            { type: "text", text: "now." }
          ]
        }
      ],
      tools: [{ name: "Read", input_schema: { type: "object" } }]
    }));
    const converted = serializeOpenAIResponsesRequest(canonical, { model: "gpt-5" });

    expect(converted.body.input).toEqual([
      { type: "function_call", call_id: "toolu_image", name: "Read", arguments: "{\"file_path\":\"asset.png\"}" },
      {
        type: "function_call_output",
        call_id: "toolu_image",
        output: [
          { type: "input_text", text: "Tool execution failed:\n" },
          { type: "input_text", text: "Preview:" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "auto" },
          { type: "input_text", text: " done" }
        ]
      },
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Compare " },
          { type: "input_image", image_url: "https://example.com/original.webp", detail: "auto" },
          { type: "input_text", text: "now." }
        ]
      }
    ]);
  });

  it("keeps text-only function_call_output as a string", () => {
    const canonical = parseAnthropicMessagesRequest(baseRequest({
      messages: [{
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_text",
          content: [{ type: "text", text: "one" }, { type: "text", text: "two" }],
          is_error: true
        }]
      }]
    }));

    expect(serializeOpenAIResponsesRequest(canonical, { model: "gpt-5" }).body.input).toEqual([{
      type: "function_call_output",
      call_id: "toolu_text",
      output: "Tool execution failed:\nonetwo"
    }]);
  });

  it("only expands tool schemas when toolStrict is strict", () => {
    const canonical = parseAnthropicMessagesRequest(baseRequest({
      tools: [{
        name: "Read",
        input_schema: {
          type: "object",
          properties: {
            file_path: { type: "string" },
            offset: { type: "integer" },
            limit: { type: "integer" }
          },
          required: ["file_path"]
        }
      }]
    }));

    const nonStrict = serializeOpenAIResponsesRequest(canonical, {
      model: "gpt-5",
      compatibility: { toolStrict: "non_strict" }
    });
    expect(nonStrict.body.tools).toEqual([{
      type: "function",
      name: "Read",
      strict: false,
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          offset: { type: "integer" },
          limit: { type: "integer" }
        },
        required: ["file_path"]
      }
    }]);

    const strict = serializeOpenAIResponsesRequest(canonical, {
      model: "gpt-5",
      compatibility: { toolStrict: "strict" }
    });
    expect(strict.body.tools).toEqual([{
      type: "function",
      name: "Read",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          offset: { type: "integer" },
          limit: { type: "integer" }
        },
        required: ["file_path", "offset", "limit"],
        additionalProperties: false
      }
    }]);
  });

  it("supports system_input and rejects unsupported output and parallel semantics", () => {
    const plain = parseAnthropicMessagesRequest(baseRequest({ system: "System" }));
    expect(serializeOpenAIResponsesRequest(plain, {
      model: "model",
      compatibility: { instructions: "system_input" }
    }).body).toMatchObject({ system_input: "System" });

    const structured = parseAnthropicMessagesRequest(baseRequest({
      output_config: { format: { type: "json_schema", schema: { type: "object", properties: {} } } }
    }));
    expect(() => serializeOpenAIResponsesRequest(structured, {
      model: "model", compatibility: { structuredOutput: "unsupported" }
    })).toThrow("does not support structured outputs");

    const parallel = parseAnthropicMessagesRequest(baseRequest({
      tools: [{ name: "x", input_schema: {} }],
      tool_choice: { type: "auto", disable_parallel_tool_use: true }
    }));
    expect(() => serializeOpenAIResponsesRequest(parallel, {
      model: "model", compatibility: { parallelToolCalls: "unsupported" }
    })).toThrow("does not support parallel_tool_calls");
  });

  it("parses text, refusal, parallel function calls, status, usage, and item metadata", () => {
    const mapping = createToolNameMapping(["mcp.tool"]);
    const parsed = parseOpenAIResponsesResponseWithMetadata({
      id: "resp_123",
      model: "gpt-5",
      status: "completed",
      output: [
        { type: "reasoning", id: "rs_1" },
        { type: "message", content: [
          { type: "output_text", text: "Working" },
          { type: "refusal", refusal: "No more" }
        ] },
        { type: "function_call", call_id: "call:one", name: "mcp_tool", arguments: "{\"a\":1}" },
        { type: "function_call", call_id: "call:two", name: "mcp_tool", arguments: "{}" }
      ],
      usage: { input_tokens: 10, output_tokens: 4 }
    }, { toolNames: mapping });

    expect(parsed.upstreamItemTypes).toEqual(["reasoning", "message", "function_call"]);
    expect(parsed.response).toMatchObject({
      id: "msg_resp_123",
      model: "gpt-5",
      finishReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 4 },
      content: [
        { type: "text", text: "Working" },
        { type: "text", text: "No more" },
        { type: "tool_use", name: "mcp.tool", input: { a: 1 } },
        { type: "tool_use", name: "mcp.tool", input: {} }
      ]
    });
    expect(canonicalResponseToAnthropic(parsed.response)).toMatchObject({ stop_reason: "tool_use" });
  });

  it("records and ignores Responses web search output items while preserving message content", () => {
    const parsed = parseOpenAIResponsesResponseWithMetadata({
      id: "resp_web",
      model: "gpt-5.6",
      status: "completed",
      output: [
        { type: "web_search_call", id: "ws_1", status: "completed" },
        { type: "message", content: [{ type: "output_text", text: "Search result summary" }] }
      ],
      usage: { input_tokens: 12, output_tokens: 5 }
    });

    expect(parsed.upstreamItemTypes).toEqual(["web_search_call", "message"]);
    expect(parsed.response.content).toEqual([{ type: "text", text: "Search result summary" }]);
    expect(parsed.response.finishReason).toBe("end_turn");
  });

  it("prepares completed image generation output as an absolute saved-image path", () => {
    const imageStore = new GeneratedImageStore({
      context: { homeDir: "C:\\ccp-test-home" },
      requestId: "request-1",
      sessionId: "session-1"
    });
    const parsed = parseOpenAIResponsesResponseWithMetadata({
      id: "resp_image",
      model: "gpt-image",
      status: "completed",
      output: [{
        id: "image_1",
        type: "image_generation_call",
        status: "completed",
        result: ONE_PIXEL_PNG
      }]
    }, { imageStore });

    expect(parsed.upstreamItemTypes).toEqual(["image_generation_call"]);
    expect(parsed.generatedImages).toHaveLength(1);
    expect(path.isAbsolute(parsed.generatedImages[0].path)).toBe(true);
    expect(parsed.response.content).toEqual([{
      type: "text",
      text: `Generated image saved to:\n\`${parsed.generatedImages[0].path}\``
    }]);
  });

  it("accepts a final image result with a stale generating status from a compatible proxy", () => {
    const imageStore = new GeneratedImageStore({
      context: { homeDir: "C:\\ccp-test-home" },
      requestId: "request-stale-status"
    });
    const parsed = parseOpenAIResponsesResponseWithMetadata({
      id: "resp_image",
      model: "gpt-image",
      status: "completed",
      output: [{
        id: "image_stale",
        type: "image_generation_call",
        status: "generating",
        result: ONE_PIXEL_PNG
      }]
    }, { imageStore });

    expect(parsed.generatedImages).toHaveLength(1);
    expect(parsed.response.content[0]).toMatchObject({ type: "text" });
  });

  it.each([
    ["incomplete", ONE_PIXEL_PNG, "Expected 'completed'"],
    ["completed", "not base64!", "valid base64"],
    ["completed", Buffer.from("not an image").toString("base64"), "Unsupported image format"]
  ])("rejects invalid image generation results", (status, result, expected) => {
    const imageStore = new GeneratedImageStore({
      context: { homeDir: "C:\\ccp-test-home" },
      requestId: "request-1"
    });
    expect(() => parseOpenAIResponsesResponse({
      id: "resp_image",
      model: "gpt-image",
      status: "completed",
      output: [{ id: "image_1", type: "image_generation_call", status, result }]
    }, { imageStore })).toThrow(expected);
  });

  it.each([
    [{ id: "r", model: "m", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "message", content: [{ type: "output_text", text: "partial" }] }] }, "max_tokens"],
    [{ id: "r", model: "m", status: "failed", error: { message: "provider failed" }, output: [] }, "provider failed"],
    [{ id: "r", model: "m", status: "completed", output: [{ type: "web_search_call" }] }, "No representable output"],
    [{ id: "r", model: "m", status: "completed", output: [{ type: "reasoning" }] }, "No representable output"],
    [{ id: "r", model: "m", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: -1 } }, "non-negative safe integer"],
    [{ id: "r", model: "m", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], usage: null }, "response.usage"]
  ])("handles Responses status and protocol errors", (response, expected) => {
    if (expected === "max_tokens") {
      expect(parseOpenAIResponsesResponse(response)).toMatchObject({ finishReason: "max_tokens" });
    } else {
      expect(() => parseOpenAIResponsesResponse(response)).toThrow(expected);
    }
  });
});
