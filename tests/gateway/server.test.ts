import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayProfile as createStoredGatewayProfile } from "../../src/core/profiles.js";
import { createGatewayUpstream } from "../../src/core/gateway-upstreams.js";
import type {
  GatewayCompatibility,
  GatewayProvider,
  GatewayResponsesCompatibility,
  GatewayUpstreamProtocol
} from "../../src/core/types.js";
import { readGatewayProfileSecret, updateGatewayProfile } from "../../src/core/gateway-profile.js";
import { createGatewayServer, type GatewayRequestLog } from "../../src/gateway/server.js";
import { getGatewayGeneratedDir } from "../../src/core/paths.js";
import {
  gatewayDefaultModelAlias,
  gatewayLiveModelAlias,
  gatewayModelOptionAlias
} from "../../src/gateway/models.js";

interface LoopbackHandle {
  endpoint: string;
  close(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];
const FETCH_BLOCKED_TEST_PORTS = new Set([6000, 6665, 6666, 6667, 6668, 6669, 10080]);
const MAX_LOOPBACK_PORT_ATTEMPTS = 20;
const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).reverse().map((cleanup) => cleanup()));
});

function isFetchBlockedEndpoint(endpoint: string): boolean {
  return FETCH_BLOCKED_TEST_PORTS.has(Number(new URL(endpoint).port));
}

async function createContext() {
  const homeDir = await mkdtemp(path.join(tmpdir(), "ccp-gateway-test-"));
  cleanups.push(() => rm(homeDir, { recursive: true, force: true }));
  return { homeDir };
}

async function createTestGatewayProfile(
  input: {
    name: string;
    provider: GatewayProvider;
    chatCompletionsUrl: string;
    apiKey: string;
    model: string;
    models?: string[];
    protocol?: GatewayUpstreamProtocol;
    endpointUrl?: string;
    compatibility?: Partial<GatewayCompatibility> | Partial<GatewayResponsesCompatibility>;
  },
  context: { homeDir: string }
) {
  const upstreamId = `${input.name}-upstream`;
  await createGatewayUpstream({
    id: upstreamId,
    provider: input.provider,
    ...(input.protocol ? { protocol: input.protocol } : {}),
    ...(input.endpointUrl ? { endpointUrl: input.endpointUrl } : {}),
    chatCompletionsUrl: input.chatCompletionsUrl,
    apiKey: input.apiKey,
    models: input.models ?? [input.model],
    compatibility: input.compatibility
  }, context);
  return createStoredGatewayProfile({ name: input.name, upstreamId, model: input.model }, context);
}

async function listenLoopback(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
): Promise<LoopbackHandle> {
  for (let attempt = 0; attempt < MAX_LOOPBACK_PORT_ATTEMPTS; attempt += 1) {
    const server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const handle = {
      endpoint: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      })
    };
    if (isFetchBlockedEndpoint(handle.endpoint)) {
      await handle.close();
      continue;
    }
    cleanups.push(handle.close);
    return handle;
  }
  throw new Error("Could not allocate a fetch-compatible loopback port.");
}

async function readRequestJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function startGateway(context: { homeDir: string }, options: Parameters<typeof createGatewayServer>[0] = {}) {
  for (let attempt = 0; attempt < MAX_LOOPBACK_PORT_ATTEMPTS; attempt += 1) {
    const handle = createGatewayServer({ context, ...options });
    const listening = await handle.listen({ host: "127.0.0.1", port: 0 });
    if (isFetchBlockedEndpoint(listening.endpoint)) {
      await handle.close();
      continue;
    }
    cleanups.push(handle.close);
    return { handle, endpoint: listening.endpoint };
  }
  throw new Error("Could not allocate a fetch-compatible gateway port.");
}

function anthropicRequest(stream = false, overrides: Record<string, unknown> = {}) {
  return {
    model: "claude-client-alias",
    max_tokens: 256,
    messages: [{ role: "user", content: "hello" }],
    stream,
    ...overrides
  };
}

describe("gateway HTTP protocol", () => {
  it("serves unauthenticated HEAD probes and health without resolving a profile", async () => {
    const context = await createContext();
    const resolve = vi.fn().mockRejectedValue(new Error("must not resolve"));
    const { endpoint, handle } = await startGateway(context, {
      instanceId: "instance-test",
      registry: { resolve, countProfiles: vi.fn().mockResolvedValue(2) }
    });

    const root = await fetch(endpoint, { method: "HEAD" });
    const profile = await fetch(`${endpoint}/p/not-created/`, { method: "HEAD" });
    const health = await fetch(`${endpoint}/health`).then((response) => response.json());

    expect(root.status).toBe(204);
    expect(await root.text()).toBe("");
    expect(profile.status).toBe(204);
    expect(resolve).not.toHaveBeenCalled();
    expect(health).toMatchObject({
      ok: true,
      service: "multi-ccp-gateway",
      protocolVersion: 5,
      instanceId: "instance-test",
      endpoint,
      profileCount: 2
    });
    expect(health.pid).toBe(process.pid);
    expect(handle.instanceId).toBe("instance-test");
  });

  it("keeps count_tokens optional and protects model discovery", async () => {
    const context = await createContext();
    const resolve = vi.fn().mockRejectedValue(new Error("must not resolve"));
    const logs: GatewayRequestLog[] = [];
    const { endpoint } = await startGateway(context, {
      registry: { resolve, countProfiles: vi.fn().mockResolvedValue(0) },
      onRequestComplete: (entry) => logs.push(entry)
    });

    const count = await fetch(`${endpoint}/p/example/v1/messages/count_tokens`, { method: "POST" });
    const models = await fetch(`${endpoint}/p/example/v1/models`);

    expect(count.status).toBe(404);
    expect(models.status).toBe(401);
    expect(resolve).toHaveBeenCalledWith("example");
    await vi.waitFor(() => expect(logs).toHaveLength(2));
    expect(logs.map((entry) => ({ kind: entry.requestKind, outcome: entry.outcome, status: entry.status }))).toEqual([
      { kind: "count_tokens", outcome: "expected_unsupported", status: 404 },
      { kind: "models", outcome: "failure", status: 401 }
    ]);
  });

  it("discovers current upstream models and routes aliases to the selected model", async () => {
    const context = await createContext();
    const received: Array<Record<string, unknown>> = [];
    const upstream = await listenLoopback(async (req, res) => {
      received.push(await readRequestJson(req));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chat",
        model: "second-model",
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }]
      }));
    });
    const profile = await createTestGatewayProfile({
      name: "model-picker",
      provider: "openai-compatible",
      chatCompletionsUrl: `${upstream.endpoint}/v1/chat/completions`,
      apiKey: "key",
      model: "first-model",
      models: ["first-model", "second-model"]
    }, context);
    const secret = await readGatewayProfileSecret(profile.dir);
    const { endpoint } = await startGateway(context);
    const catalog = await fetch(`${endpoint}/p/model-picker/v1/models`, {
      headers: { "x-api-key": secret!.localToken }
    }).then((response) => response.json()) as {
      data: Array<{ id: string; display_name: string }>;
      has_more: boolean;
      first_id: string | null;
      last_id: string | null;
    };
    const selected = catalog.data.find((entry) => entry.id === gatewayModelOptionAlias("second-model"));
    const defaultEntries = catalog.data.filter((entry) => entry.display_name === "first-model (model-picker-upstream)");
    expect(catalog.has_more).toBe(false);
    expect(catalog.first_id).toBe(catalog.data[0]?.id);
    expect(catalog.last_id).toBe(catalog.data.at(-1)?.id);
    expect(selected).toBeDefined();
    expect(selected!.id).toBe(gatewayModelOptionAlias("second-model"));
    expect(selected!.id.startsWith("anthropic.ccp-option-")).toBe(true);
    expect(catalog.data.map((entry) => entry.id)).toEqual([
      gatewayDefaultModelAlias("first-model"),
      gatewayDefaultModelAlias("second-model"),
      gatewayModelOptionAlias("first-model"),
      gatewayModelOptionAlias("second-model")
    ]);
    expect(defaultEntries.map((entry) => entry.id)).toEqual([
      gatewayDefaultModelAlias("first-model"),
      gatewayModelOptionAlias("first-model")
    ]);

    const response = await fetch(`${endpoint}/p/model-picker/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": secret!.localToken },
      body: JSON.stringify(anthropicRequest(false, { model: selected!.id }))
    });
    expect(response.status).toBe(200);
    expect(received[0]?.model).toBe("second-model");

    const liveResponse = await fetch(`${endpoint}/p/model-picker/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": secret!.localToken },
      body: JSON.stringify(anthropicRequest(false, {
        model: gatewayLiveModelAlias("second-model", ["first-model", "second-model"])
      }))
    });
    expect(liveResponse.status).toBe(200);
    expect(received[1]?.model).toBe("second-model");
  });

  it("applies binding changes to Default on the next request without overriding explicit model selections", async () => {
    const context = await createContext();
    const received: string[] = [];
    const upstream = await listenLoopback(async (req, res) => {
      received.push(String((await readRequestJson(req)).model));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chat",
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }]
      }));
    });
    const profile = await createTestGatewayProfile({
      name: "hot-default",
      provider: "openai-compatible",
      chatCompletionsUrl: `${upstream.endpoint}/v1/chat/completions`,
      apiKey: "key",
      model: "first-model",
      models: ["first-model", "second-model"]
    }, context);
    const secret = await readGatewayProfileSecret(profile.dir);
    const { endpoint } = await startGateway(context);
    const call = (model: string) => fetch(`${endpoint}/p/hot-default/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": secret!.localToken },
      body: JSON.stringify(anthropicRequest(false, { model }))
    });

    const firstDefaultAlias = gatewayDefaultModelAlias("first-model");
    expect((await call(firstDefaultAlias)).status).toBe(200);
    await updateGatewayProfile(profile.dir, profile.name, {
      upstreamId: "hot-default-upstream",
      model: "second-model"
    }, context);
    expect((await call(firstDefaultAlias)).status).toBe(200);
    expect((await call(gatewayDefaultModelAlias("second-model"))).status).toBe(200);
    expect((await call(gatewayModelOptionAlias("first-model"))).status).toBe(200);

    expect(received).toEqual([
      "first-model",
      "second-model",
      "second-model",
      "first-model"
    ]);
  });

  it("rejects an old ccp model alias instead of silently using the profile default", async () => {
    const context = await createContext();
    const profile = await createTestGatewayProfile({
      name: "stale-model",
      provider: "openai-compatible",
      chatCompletionsUrl: "https://example.test/v1/chat/completions",
      apiKey: "key",
      model: "configured-model"
    }, context);
    const secret = await readGatewayProfileSecret(profile.dir);
    const { endpoint } = await startGateway(context);
    const response = await fetch(`${endpoint}/p/stale-model/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": secret!.localToken },
      body: JSON.stringify(anthropicRequest(false, { model: "claude-ccp-cmVtb3ZlZC1tb2RlbA" }))
    });
    const body = await response.json() as { error?: { message?: string } };
    expect(response.status).toBe(400);
    expect(body.error?.message).toContain("not configured");
  });

  it("rejects built-in Claude models instead of silently using the profile default", async () => {
    const context = await createContext();
    const profile = await createTestGatewayProfile({
      name: "builtin-model",
      provider: "openai-compatible",
      chatCompletionsUrl: "https://example.test/v1/chat/completions",
      apiKey: "key",
      model: "configured-model"
    }, context);
    const secret = await readGatewayProfileSecret(profile.dir);
    const { endpoint } = await startGateway(context);
    const response = await fetch(`${endpoint}/p/builtin-model/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": secret!.localToken },
      body: JSON.stringify(anthropicRequest(false, { model: "claude-opus-5" }))
    });
    const body = await response.json() as { error?: { message?: string } };
    expect(response.status).toBe(400);
    expect(body.error?.message).toContain("not configured for the current Gateway Upstream");
  });

  it("isolates concurrent profiles, upstream credentials, models, and local tokens", async () => {
    const context = await createContext();
    const received: Array<{ path: string; authorization: string | undefined; body: Record<string, unknown> }> = [];
    const upstream = await listenLoopback(async (req, res) => {
      const body = await readRequestJson(req);
      received.push({ path: req.url ?? "", authorization: req.headers.authorization, body });
      const provider = req.url?.startsWith("/a/") ? "a" : "b";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: `response-${provider}`,
        model: `upstream-${provider}`,
        choices: [{ index: 0, message: { role: "assistant", content: `reply-${provider}` }, finish_reason: "stop" }],
        usage: { prompt_tokens: provider === "a" ? 11 : 22, completion_tokens: 3 }
      }));
    });
    const profileA = await createTestGatewayProfile({
      name: "provider-a",
      provider: "openai-compatible",
      chatCompletionsUrl: `${upstream.endpoint}/a/v1/chat/completions`,
      apiKey: "upstream-key-a",
      model: "model-a"
    }, context);
    const profileB = await createTestGatewayProfile({
      name: "provider-b",
      provider: "openai-compatible",
      chatCompletionsUrl: `${upstream.endpoint}/b/v1/chat/completions`,
      apiKey: "upstream-key-b",
      model: "model-b"
    }, context);
    const secretA = await readGatewayProfileSecret(profileA.dir);
    const secretB = await readGatewayProfileSecret(profileB.dir);
    const { endpoint } = await startGateway(context);

    const call = (name: string, token: string, model: string) => fetch(`${endpoint}/p/${name}/v1/messages?beta=true`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(anthropicRequest(false, { model }))
    });
    const [responseA, responseB] = await Promise.all([
      call("provider-a", secretA!.localToken, "model-a"),
      call("provider-b", secretB!.localToken, "model-b")
    ]);
    const [bodyA, bodyB] = await Promise.all([responseA.json(), responseB.json()]);

    expect(responseA.status).toBe(200);
    expect(responseB.status).toBe(200);
    expect(bodyA.content[0].text).toBe("reply-a");
    expect(bodyB.content[0].text).toBe("reply-b");
    expect(received).toHaveLength(2);
    expect(received.find((item) => item.path.startsWith("/a/"))).toMatchObject({
      authorization: "Bearer upstream-key-a",
      body: { model: "model-a" }
    });
    expect(received.find((item) => item.path.startsWith("/b/"))).toMatchObject({
      authorization: "Bearer upstream-key-b",
      body: { model: "model-b" }
    });

    const crossProfile = await call("provider-b", secretA!.localToken, "model-b");
    expect(crossProfile.status).toBe(401);
    expect(received).toHaveLength(2);
  });

  it("dispatches Responses requests to their endpoint with their key and parses non-stream output", async () => {
    const context = await createContext();
    let received: { url: string; authorization?: string; body: Record<string, unknown> } | undefined;
    const upstream = await listenLoopback(async (req, res) => {
      received = { url: req.url ?? "", authorization: req.headers.authorization, body: await readRequestJson(req) };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "resp_server",
        model: "responses-model",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "responses-ok" }] }],
        usage: { input_tokens: 7, output_tokens: 2 }
      }));
    });
    const profile = await createTestGatewayProfile({
      name: "responses",
      provider: "openai-compatible",
      protocol: "openai_responses",
      endpointUrl: `${upstream.endpoint}/v1/responses?trace=visible-in-upstream#fragment`,
      chatCompletionsUrl: `${upstream.endpoint}/v1/chat/completions`,
      apiKey: "responses-key",
      model: "responses-model"
    }, context);
    const secret = await readGatewayProfileSecret(profile.dir);
    const logs: GatewayRequestLog[] = [];
    const { endpoint } = await startGateway(context, { onRequestComplete: (entry) => logs.push(entry) });

    const response = await fetch(`${endpoint}/p/responses/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret!.localToken}` },
      body: JSON.stringify(anthropicRequest(false, { model: "responses-model" }))
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.content[0].text).toBe("responses-ok");
    expect(received).toMatchObject({
      url: "/v1/responses?trace=visible-in-upstream",
      authorization: "Bearer responses-key",
      body: { model: "responses-model", store: false, stream: false }
    });
    expect(received?.body.messages).toBeUndefined();
    await vi.waitFor(() => expect(logs).toHaveLength(1));
    expect(logs[0]).toMatchObject({
      protocol: "openai_responses",
      endpointHost: new URL(upstream.endpoint).host,
      endpointUrl: `${upstream.endpoint}/v1/responses`,
      upstreamItemTypes: ["message"],
      inputTokens: 7,
      outputTokens: 2,
      status: 200
    });
  });

  it("logs safe upstream request shape diagnostics without tool payloads", async () => {
    const context = await createContext();
    const upstream = await listenLoopback((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "resp_shape",
        model: "responses-model",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 11, output_tokens: 1 }
      }));
    });
    const profile = await createTestGatewayProfile({
      name: "responses-shape",
      provider: "openai-compatible",
      protocol: "openai_responses",
      endpointUrl: `${upstream.endpoint}/v1/responses`,
      chatCompletionsUrl: `${upstream.endpoint}/v1/chat/completions`,
      apiKey: "responses-key",
      model: "responses-model"
    }, context);
    const secret = await readGatewayProfileSecret(profile.dir);
    const logs: GatewayRequestLog[] = [];
    const { endpoint } = await startGateway(context, { onRequestComplete: (entry) => logs.push(entry) });

    const response = await fetch(`${endpoint}/p/responses-shape/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret!.localToken}` },
      body: JSON.stringify(anthropicRequest(false, {
        model: "responses-model",
        tools: [
          {
            name: "Read",
            description: "Read a file from disk.",
            input_schema: {
              type: "object",
              properties: { file_path: { type: "string" } },
              required: ["file_path"]
            }
          },
          { type: "web_search_20250305", name: "web_search", max_uses: 1 }
        ],
        tool_choice: { type: "auto" }
      }))
    });

    expect(response.status).toBe(200);
    await response.json();
    await vi.waitFor(() => expect(logs).toHaveLength(1));
    expect(logs[0]).toMatchObject({
      protocol: "openai_responses",
      upstreamToolTypes: ["function", "web_search"],
      upstreamToolCount: 2,
      upstreamInputItems: 1,
      upstreamHasToolChoice: true,
      inputTokens: 11,
      outputTokens: 1,
      status: 200
    });
    const serializedLog = JSON.stringify(logs[0]);
    expect(serializedLog).not.toContain("Read a file from disk.");
    expect(serializedLog).not.toContain("file_path");
  });

  it("isolates concurrent Chat and Responses protocol requests", async () => {
    const context = await createContext();
    const received: Array<{ path: string; authorization?: string; body: Record<string, unknown> }> = [];
    const upstream = await listenLoopback(async (req, res) => {
      const body = await readRequestJson(req);
      received.push({ path: req.url ?? "", authorization: req.headers.authorization, body });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/responses") {
        res.end(JSON.stringify({
          id: "resp_mixed", model: "responses-model", status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "responses" }] }]
        }));
      } else {
        res.end(JSON.stringify({
          id: "chat_mixed", model: "chat-model",
          choices: [{ message: { content: "chat" }, finish_reason: "stop" }]
        }));
      }
    });
    const chat = await createTestGatewayProfile({
      name: "mixed-chat", provider: "openai-compatible",
      chatCompletionsUrl: `${upstream.endpoint}/chat/completions`, apiKey: "chat-key", model: "chat-model"
    }, context);
    const responses = await createTestGatewayProfile({
      name: "mixed-responses", provider: "openai-compatible", protocol: "openai_responses",
      endpointUrl: `${upstream.endpoint}/responses`, chatCompletionsUrl: `${upstream.endpoint}/chat/completions`,
      apiKey: "responses-key", model: "responses-model"
    }, context);
    const [chatSecret, responsesSecret] = await Promise.all([
      readGatewayProfileSecret(chat.dir), readGatewayProfileSecret(responses.dir)
    ]);
    const { endpoint } = await startGateway(context);
    const call = (name: string, token: string, model: string) => fetch(`${endpoint}/p/${name}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": token },
      body: JSON.stringify(anthropicRequest(false, { model }))
    });
    const [chatResponse, responsesResponse] = await Promise.all([
      call("mixed-chat", chatSecret!.localToken, "chat-model"),
      call("mixed-responses", responsesSecret!.localToken, "responses-model")
    ]);

    expect((await chatResponse.json()).content[0].text).toBe("chat");
    expect((await responsesResponse.json()).content[0].text).toBe("responses");
    expect(received.find((item) => item.path === "/chat/completions")).toMatchObject({
      authorization: "Bearer chat-key", body: { model: "chat-model", messages: expect.any(Array) }
    });
    expect(received.find((item) => item.path === "/responses")).toMatchObject({
      authorization: "Bearer responses-key", body: { model: "responses-model", input: expect.any(Array), store: false }
    });
  });

  it("streams Responses SSE end to end with endpoint, key, usage, and metadata dispatch", async () => {
    const context = await createContext();
    let received: { url: string; authorization?: string; body: Record<string, unknown> } | undefined;
    const sse = (type: string, payload: Record<string, unknown>) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
    const upstream = await listenLoopback(async (req, res) => {
      received = { url: req.url ?? "", authorization: req.headers.authorization, body: await readRequestJson(req) };
      res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "upstream-responses-1" });
      const created = sse("response.created", {
        response: { id: "resp_stream", model: "responses-model", status: "in_progress" }
      });
      res.write(created.slice(0, 37));
      res.write(created.slice(37));
      res.write(sse("codex.response.metadata", { provider: "aicodemirror" }));
      res.write(sse("response.output_item.added", {
        output_index: 0, item: { id: "msg_1", type: "message", content: [] }
      }));
      res.write(sse("response.content_part.added", {
        item_id: "msg_1", output_index: 0, content_index: 0,
        part: { type: "output_text", text: "" }
      }));
      res.write(sse("response.output_text.delta", {
        item_id: "msg_1", output_index: 0, content_index: 0, delta: "responses-stream"
      }));
      res.end(sse("response.completed", {
        response: {
          id: "resp_stream", model: "responses-model", status: "completed",
          usage: { input_tokens: 9, output_tokens: 3 }
        }
      }));
    });
    const profile = await createTestGatewayProfile({
      name: "responses-stream",
      provider: "openai-compatible",
      protocol: "openai_responses",
      endpointUrl: `${upstream.endpoint}/v1/responses`,
      chatCompletionsUrl: `${upstream.endpoint}/v1/chat/completions`,
      apiKey: "responses-stream-key",
      model: "responses-model"
    }, context);
    const secret = await readGatewayProfileSecret(profile.dir);
    const logs: GatewayRequestLog[] = [];
    const { endpoint } = await startGateway(context, { onRequestComplete: (entry) => logs.push(entry) });
    const response = await fetch(`${endpoint}/p/responses-stream/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": secret!.localToken },
      body: JSON.stringify(anthropicRequest(true, { model: "responses-model" }))
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain('"text":"responses-stream"');
    expect(body).toContain('"input_tokens":9');
    expect(body).toContain("event: message_stop");
    expect(received).toMatchObject({
      url: "/v1/responses",
      authorization: "Bearer responses-stream-key",
      body: { model: "responses-model", stream: true, store: false }
    });
    expect(received?.body.input).toEqual(expect.any(Array));
    expect(received?.body.messages).toBeUndefined();
    await vi.waitFor(() => expect(logs).toHaveLength(1));
    expect(logs[0]).toMatchObject({
      protocol: "openai_responses",
      upstreamItemTypes: ["message"],
      inputTokens: 9,
      outputTokens: 3,
      upstreamStatus: 200,
      upstreamRequestId: "upstream-responses-1",
      lastEventType: "response.completed",
      terminalEventReceived: true,
      status: 200
    });
    expect(logs[0].upstreamEventTypes).toEqual(expect.arrayContaining([
      "response.created", "response.output_item.added", "response.content_part.added",
      "response.output_text.delta", "codex.response.metadata", "response.completed"
    ]));
  });

  it("saves streamed Responses image output before returning its absolute path", async () => {
    const context = await createContext();
    const sse = (type: string, payload: Record<string, unknown>) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
    const upstream = await listenLoopback((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "upstream-image-1" });
      res.write(sse("response.created", {
        response: { id: "resp_image", model: "responses-model", status: "in_progress" }
      }));
      res.write(sse("response.output_item.added", {
        output_index: 0,
        item: { id: "image_1", type: "image_generation_call", status: "in_progress" }
      }));
      res.write(sse("response.image_generation_call.partial_image", {
        output_index: 0, item_id: "image_1", partial_image_index: 0, partial_image_b64: ONE_PIXEL_PNG
      }));
      res.write(sse("response.output_item.done", {
        output_index: 0,
        item: { id: "image_1", type: "image_generation_call", status: "completed", result: ONE_PIXEL_PNG }
      }));
      res.end(sse("response.completed", {
        response: {
          id: "resp_image",
          model: "responses-model",
          status: "completed",
          output: [{ id: "image_1", type: "image_generation_call", status: "completed", result: ONE_PIXEL_PNG }],
          usage: { input_tokens: 4, output_tokens: 1 }
        }
      }));
    });
    const profile = await createTestGatewayProfile({
      name: "responses-image",
      provider: "openai-compatible",
      protocol: "openai_responses",
      endpointUrl: `${upstream.endpoint}/v1/responses`,
      chatCompletionsUrl: `${upstream.endpoint}/v1/chat/completions`,
      apiKey: "responses-key",
      model: "responses-model"
    }, context);
    const secret = await readGatewayProfileSecret(profile.dir);
    const logs: GatewayRequestLog[] = [];
    const { endpoint } = await startGateway(context, { onRequestComplete: (entry) => logs.push(entry) });

    const response = await fetch(`${endpoint}/p/responses-image/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": secret!.localToken,
        "x-claude-code-session-id": "session-image-test"
      },
      body: JSON.stringify(anthropicRequest(true, { model: "responses-model" }))
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    const imageDir = path.join(getGatewayGeneratedDir(context), "session-image-test");
    const files = await readdir(imageDir);
    expect(files).toHaveLength(1);
    const imagePath = path.join(imageDir, files[0]);
    expect(path.isAbsolute(imagePath)).toBe(true);
    expect(await readFile(imagePath)).toEqual(Buffer.from(ONE_PIXEL_PNG, "base64"));
    expect(body).toContain("Generated image saved to:");
    expect(body).toContain(`\`${JSON.stringify(imagePath).slice(1, -1)}\``);
    expect(body).not.toContain(ONE_PIXEL_PNG);
    expect(body).not.toContain("event: error");
    expect(body).toContain("event: message_stop");
    await vi.waitFor(() => expect(logs).toHaveLength(1));
    expect(logs[0]).toMatchObject({
      status: 200,
      upstreamStatus: 200,
      upstreamRequestId: "upstream-image-1",
      upstreamItemTypes: ["image_generation_call"],
      lastEventType: "response.completed",
      terminalEventReceived: true,
      sessionId: "session-image-test"
    });
  });

  it("saves a proxy image result whose done item retains generating status", async () => {
    const context = await createContext();
    const sse = (type: string, payload: Record<string, unknown>) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
    const upstream = await listenLoopback((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "upstream-stale-image" });
      res.write(sse("response.created", {
        response: { id: "resp_image", model: "responses-model", status: "in_progress" }
      }));
      res.write(sse("response.output_item.added", {
        output_index: 0,
        item: { id: "image_stale", type: "image_generation_call", status: "in_progress" }
      }));
      res.write(sse("response.output_item.done", {
        output_index: 0,
        item: { id: "image_stale", type: "image_generation_call", status: "generating", result: ONE_PIXEL_PNG }
      }));
      res.end(sse("response.completed", {
        response: {
          id: "resp_image",
          model: "responses-model",
          status: "completed",
          output: [{
            id: "image_stale", type: "image_generation_call", status: "generating", result: ONE_PIXEL_PNG
          }],
          usage: { input_tokens: 4, output_tokens: 1 }
        }
      }));
    });
    const profile = await createTestGatewayProfile({
      name: "responses-stale-image",
      provider: "openai-compatible",
      protocol: "openai_responses",
      endpointUrl: `${upstream.endpoint}/v1/responses`,
      chatCompletionsUrl: `${upstream.endpoint}/v1/chat/completions`,
      apiKey: "responses-key",
      model: "responses-model"
    }, context);
    const secret = await readGatewayProfileSecret(profile.dir);
    const logs: GatewayRequestLog[] = [];
    const { endpoint } = await startGateway(context, { onRequestComplete: (entry) => logs.push(entry) });

    const response = await fetch(`${endpoint}/p/responses-stale-image/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": secret!.localToken,
        "x-claude-code-session-id": "session-stale-image"
      },
      body: JSON.stringify(anthropicRequest(true, { model: "responses-model" }))
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Generated image saved to:");
    expect(body).not.toContain(ONE_PIXEL_PNG);
    await vi.waitFor(() => expect(logs).toHaveLength(1));
    expect(logs[0]).toMatchObject({
      status: 200,
      upstreamStatus: 200,
      upstreamRequestId: "upstream-stale-image",
      upstreamItemTypes: ["image_generation_call"],
      lastEventType: "response.completed",
      terminalEventReceived: true
    });
  });

  it("returns an SSE error without exposing a path when generated image persistence fails", async () => {
    const context = await createContext();
    await mkdir(path.dirname(getGatewayGeneratedDir(context)), { recursive: true });
    await writeFile(getGatewayGeneratedDir(context), "blocks generated image directory creation");
    const sse = (type: string, payload: Record<string, unknown>) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
    const upstream = await listenLoopback((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse("response.created", {
        response: { id: "resp_image_failure", model: "responses-model", status: "in_progress" }
      }));
      res.end(sse("response.output_item.done", {
        output_index: 0,
        item: { id: "image_failure", type: "image_generation_call", status: "completed", result: ONE_PIXEL_PNG }
      }));
    });
    const profile = await createTestGatewayProfile({
      name: "responses-image-failure",
      provider: "openai-compatible",
      protocol: "openai_responses",
      endpointUrl: `${upstream.endpoint}/v1/responses`,
      chatCompletionsUrl: `${upstream.endpoint}/v1/chat/completions`,
      apiKey: "responses-key",
      model: "responses-model"
    }, context);
    const secret = await readGatewayProfileSecret(profile.dir);
    const logs: GatewayRequestLog[] = [];
    const { endpoint } = await startGateway(context, { onRequestComplete: (entry) => logs.push(entry) });

    const response = await fetch(`${endpoint}/p/responses-image-failure/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": secret!.localToken },
      body: JSON.stringify(anthropicRequest(true, { model: "responses-model" }))
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("event: error");
    expect(body).toContain("could not save the generated image");
    expect(body).not.toContain("Generated image saved to:");
    await vi.waitFor(() => expect(logs).toHaveLength(1));
    expect(logs[0]).toMatchObject({
      status: 502,
      failureStage: "gateway_internal",
      failureCode: "gateway_internal_error",
      errorType: "api_error"
    });
  });

  it("maps Claude output_config effort without forwarding the Anthropic field", async () => {
    const context = await createContext();
    let upstreamBody: Record<string, unknown> | undefined;
    const upstream = await listenLoopback(async (req, res) => {
      upstreamBody = await readRequestJson(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "effort-response",
        model: "reasoning-model",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      }));
    });
    const profile = await createTestGatewayProfile({
      name: "gpt-5.6",
      provider: "openai-compatible",
      chatCompletionsUrl: `${upstream.endpoint}/v1/chat/completions`,
      apiKey: "upstream-key",
      model: "reasoning-model",
      compatibility: { reasoningEffort: "reasoning_effort" }
    }, context);
    const secret = await readGatewayProfileSecret(profile.dir);
    const logs: GatewayRequestLog[] = [];
    const { endpoint } = await startGateway(context, { onRequestComplete: (entry) => logs.push(entry) });

    const response = await fetch(`${endpoint}/p/gpt-5.6/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret!.localToken}`
      },
      body: JSON.stringify(anthropicRequest(false, {
        model: "reasoning-model",
        output_config: { effort: "xhigh" }
      }))
    });

    expect(response.status).toBe(200);
    await response.json();
    expect(upstreamBody?.reasoning_effort).toBe("xhigh");
    expect(upstreamBody?.output_config).toBeUndefined();
    await vi.waitFor(() => expect(logs).toHaveLength(1));
    expect(logs[0]).toMatchObject({
      profileName: "gpt-5.6",
      model: "reasoning-model",
      clientModel: "reasoning-model",
      stream: false,
      effort: "xhigh",
      effortMapping: "reasoning_effort",
      inputTokens: 1,
      outputTokens: 1,
      status: 200
    });
    expect(logs[0].completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(logs[0].upstreamFields).toContain("reasoning_effort");
    expect(logs[0].upstreamFields).not.toContain("output_config");
  });

  it("accepts x-api-key and validates content type, JSON, and body limits", async () => {
    const context = await createContext();
    const upstream = await listenLoopback((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "ok",
        model: "model",
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }]
      }));
    });
    const profile = await createTestGatewayProfile({
      name: "limits",
      provider: "openai-compatible",
      chatCompletionsUrl: `${upstream.endpoint}/v1/chat/completions`,
      apiKey: "key",
      model: "model"
    }, context);
    const secret = await readGatewayProfileSecret(profile.dir);
    const { endpoint } = await startGateway(context, { maxBodyBytes: 64 });
    const auth = { "x-api-key": secret!.localToken };

    const contentType = await fetch(`${endpoint}/p/limits/v1/messages`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(anthropicRequest(false, { model: "model" }))
    });
    const invalidJson = await fetch(`${endpoint}/p/limits/v1/messages`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: "{"
    });
    const oversized = await fetch(`${endpoint}/p/limits/v1/messages`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(anthropicRequest(false, { model: "model" }))
    });

    expect(contentType.status).toBe(415);
    expect(invalidJson.status).toBe(400);
    expect(oversized.status).toBe(413);
  });

  it("classifies local request validation failures before contacting upstream", async () => {
    const context = await createContext();
    let upstreamRequests = 0;
    const upstream = await listenLoopback((_req, res) => {
      upstreamRequests += 1;
      res.writeHead(500);
      res.end();
    });
    const profile = await createTestGatewayProfile({
      name: "local-validation",
      provider: "openai-compatible",
      chatCompletionsUrl: `${upstream.endpoint}/v1/chat/completions`,
      apiKey: "key",
      model: "model"
    }, context);
    const secret = await readGatewayProfileSecret(profile.dir);
    const logs: GatewayRequestLog[] = [];
    const { endpoint } = await startGateway(context, { onRequestComplete: (entry) => logs.push(entry) });

    const response = await fetch(`${endpoint}/p/local-validation/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": secret!.localToken },
      body: "{bad"
    });

    expect(response.status).toBe(400);
    expect(upstreamRequests).toBe(0);
    await vi.waitFor(() => expect(logs).toHaveLength(1));
    expect(logs[0]).toMatchObject({
      requestKind: "messages",
      outcome: "failure",
      status: 400,
      failureStage: "request_validation",
      failureCode: "local_validation_error",
      errorType: "invalid_request_error",
      errorSummary: "The request failed local Anthropic-format validation.",
      validationRule: "invalid_json"
    });
    expect(logs[0].upstreamStatus).toBeUndefined();
  });

  it("preserves upstream 400 messages while redacting exact configured secrets", async () => {
    const context = await createContext();
    const upstream = await listenLoopback((_req, res) => {
      res.writeHead(400, { "content-type": "application/json", "x-request-id": "upstream-invalid-1" });
      res.end(JSON.stringify({
        error: {
          type: "invalid_request_error",
          code: "unsupported_value",
          param: "input[0].content[1].image_url",
          message: "thinking.type: Extra inputs are not permitted; upstream-secret must not leak"
        }
      }));
    });
    const profile = await createTestGatewayProfile({
      name: "errors",
      provider: "openai-compatible",
      chatCompletionsUrl: `${upstream.endpoint}/v1/chat/completions`,
      apiKey: "upstream-secret",
      model: "model"
    }, context);
    const secret = await readGatewayProfileSecret(profile.dir);
    const logs: GatewayRequestLog[] = [];
    const { endpoint } = await startGateway(context, { onRequestComplete: (entry) => logs.push(entry) });
    const response = await fetch(`${endpoint}/p/errors/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret!.localToken}`
      },
      body: JSON.stringify(anthropicRequest(false, { model: "model" }))
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "thinking.type: Extra inputs are not permitted; [redacted] must not leak"
      }
    });
    await vi.waitFor(() => expect(logs).toHaveLength(1));
    expect(logs[0]).toMatchObject({
      requestKind: "messages",
      outcome: "failure",
      status: 400,
      upstreamStatus: 400,
      upstreamRequestId: "upstream-invalid-1",
      upstreamErrorCode: "unsupported_value",
      upstreamErrorParam: "input[0].content[1].image_url",
      failureStage: "upstream_http",
      failureCode: "upstream_http_error",
      errorType: "invalid_request_error",
      errorSummary: "The selected upstream rejected the converted request with HTTP 400."
    });
    expect(JSON.stringify(logs[0])).not.toContain("must not leak");
  });

  it("does not follow upstream redirects with provider credentials", async () => {
    const context = await createContext();
    let redirectedRequestCount = 0;
    const upstream = await listenLoopback((req, res) => {
      if (req.url === "/redirected") {
        redirectedRequestCount += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(302, { location: `${upstream.endpoint}/redirected` });
      res.end();
    });
    const profile = await createTestGatewayProfile({
      name: "redirect",
      provider: "openai-compatible",
      chatCompletionsUrl: `${upstream.endpoint}/v1/chat/completions`,
      apiKey: "must-not-be-forwarded",
      model: "model"
    }, context);
    const secret = await readGatewayProfileSecret(profile.dir);
    const { endpoint } = await startGateway(context);
    const response = await fetch(`${endpoint}/p/redirect/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": secret!.localToken },
      body: JSON.stringify(anthropicRequest(false, { model: "model" }))
    });

    expect(response.status).toBe(502);
    expect(redirectedRequestCount).toBe(0);
  });

  it("maps non-400 Anthropic upstream envelopes without confusing local authentication", async () => {
    const context = await createContext();
    const upstream = await listenLoopback((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({
        type: "error",
        error: { type: "authentication_error", message: "upstream credential rejected" }
      }));
    });
    const profile = await createTestGatewayProfile({
      name: "anthropic-error",
      provider: "openai-compatible",
      chatCompletionsUrl: `${upstream.endpoint}/v1/chat/completions`,
      apiKey: "key",
      model: "model"
    }, context);
    const secret = await readGatewayProfileSecret(profile.dir);
    const { endpoint } = await startGateway(context);
    const response = await fetch(`${endpoint}/p/anthropic-error/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": secret!.localToken },
      body: JSON.stringify(anthropicRequest(false, { model: "model" }))
    });
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({
      type: "error",
      error: { type: "api_error", message: "upstream credential rejected" }
    });
  });

  it("converts split upstream SSE into a complete Anthropic stream", async () => {
    const context = await createContext();
    const upstream = await listenLoopback((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: {\"id\":\"chat-1\",\"model\":\"model\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hel");
      res.write("lo\"},\"finish_reason\":null}]}\n\n");
      res.write("data: {\"id\":\"chat-1\",\"model\":\"model\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":1}}\n\n");
      res.end("data: [DONE]\n\n");
    });
    const profile = await createTestGatewayProfile({
      name: "stream",
      provider: "openai-compatible",
      chatCompletionsUrl: `${upstream.endpoint}/v1/chat/completions`,
      apiKey: "key",
      model: "model"
    }, context);
    const secret = await readGatewayProfileSecret(profile.dir);
    const { endpoint } = await startGateway(context);
    const response = await fetch(`${endpoint}/p/stream/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": secret!.localToken },
      body: JSON.stringify(anthropicRequest(true, { model: "model" }))
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain('event: message_start');
    expect(body).toContain('"text":"hello"');
    expect(body).toContain('"input_tokens":4');
    expect(body).toContain('event: message_stop');
  });

  it("emits an Anthropic SSE error when a started stream times out", async () => {
    const context = await createContext();
    const upstream = await listenLoopback((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"id":"chat","model":"model","choices":[{"index":0,"delta":{"content":"first"},"finish_reason":null}]}\n\n');
    });
    const profile = await createTestGatewayProfile({
      name: "timeout",
      provider: "openai-compatible",
      chatCompletionsUrl: `${upstream.endpoint}/v1/chat/completions`,
      apiKey: "key",
      model: "model"
    }, context);
    const secret = await readGatewayProfileSecret(profile.dir);
    const { endpoint } = await startGateway(context, { totalTimeoutMs: 30 });
    const response = await fetch(`${endpoint}/p/timeout/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": secret!.localToken },
      body: JSON.stringify(anthropicRequest(true, { model: "model" }))
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('event: message_start');
    expect(body).toContain('event: error');
    expect(body).toContain('Upstream request timed out.');
    expect(body).not.toContain('event: message_stop');
  });

  it("records streaming protocol errors as internal 502 instead of success", async () => {
    const context = await createContext();
    const upstream = await listenLoopback((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: {bad}\n\n");
    });
    const profile = await createTestGatewayProfile({
      name: "stream-error-log",
      provider: "openai-compatible",
      chatCompletionsUrl: `${upstream.endpoint}/v1/chat/completions`,
      apiKey: "key",
      model: "model"
    }, context);
    const secret = await readGatewayProfileSecret(profile.dir);
    const logs: GatewayRequestLog[] = [];
    const { endpoint } = await startGateway(context, { onRequestComplete: (entry) => logs.push(entry) });

    const response = await fetch(`${endpoint}/p/stream-error-log/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": secret!.localToken },
      body: JSON.stringify(anthropicRequest(true, { model: "model" }))
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("event: error");
    expect(body).toContain("Upstream SSE data is not valid JSON.");
    await vi.waitFor(() => expect(logs).toHaveLength(1));
    expect(logs[0]).toMatchObject({
      profileName: "stream-error-log",
      stream: true,
      status: 502,
      inputTokens: 0,
      outputTokens: 0
    });
  });

  it("stops reading upstream immediately after DONE even when the provider keeps the socket open", async () => {
    const context = await createContext();
    let upstreamClosedResolve!: () => void;
    const upstreamClosed = new Promise<void>((resolve) => {
      upstreamClosedResolve = resolve;
    });
    const upstream = await listenLoopback((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"id":"chat","model":"model","choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.once("close", upstreamClosedResolve);
    });
    const profile = await createTestGatewayProfile({
      name: "done-without-eof",
      provider: "openai-compatible",
      chatCompletionsUrl: `${upstream.endpoint}/v1/chat/completions`,
      apiKey: "key",
      model: "model"
    }, context);
    const secret = await readGatewayProfileSecret(profile.dir);
    const { endpoint } = await startGateway(context, { totalTimeoutMs: 2_000 });

    const body = await Promise.race([
      fetch(`${endpoint}/p/done-without-eof/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": secret!.localToken },
        body: JSON.stringify(anthropicRequest(true, { model: "model" }))
      }).then((response) => response.text()),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("gateway waited for upstream EOF")), 500))
    ]);

    expect(body).toContain('event: message_stop');
    await Promise.race([
      upstreamClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("upstream reader was not cancelled")), 500))
    ]);
  });

  it("aborts only the disconnected client's upstream request and records internal 499", async () => {
    const context = await createContext();
    let upstreamClosedResolve!: () => void;
    const upstreamClosed = new Promise<void>((resolve) => {
      upstreamClosedResolve = resolve;
    });
    const upstream = await listenLoopback((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"id":"chat","model":"model","choices":[{"index":0,"delta":{"content":"first"},"finish_reason":null}]}\n\n');
      res.once("close", upstreamClosedResolve);
    });
    const profile = await createTestGatewayProfile({
      name: "disconnect",
      provider: "openai-compatible",
      chatCompletionsUrl: `${upstream.endpoint}/v1/chat/completions`,
      apiKey: "key",
      model: "model"
    }, context);
    const secret = await readGatewayProfileSecret(profile.dir);
    const logs: GatewayRequestLog[] = [];
    const { endpoint } = await startGateway(context, { onRequestComplete: (entry) => logs.push(entry) });
    const url = new URL(`${endpoint}/p/disconnect/v1/messages`);

    await new Promise<void>((resolve, reject) => {
      const req = httpRequest({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": secret!.localToken
        }
      }, (res) => {
        res.once("data", () => {
          res.destroy();
          resolve();
        });
      });
      req.once("error", reject);
      req.end(JSON.stringify(anthropicRequest(true, { model: "model" })));
    });

    await Promise.race([
      upstreamClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("upstream was not aborted")), 2_000))
    ]);
    await vi.waitFor(() => expect(logs.some((entry) => entry.status === 499)).toBe(true));
  });
});
