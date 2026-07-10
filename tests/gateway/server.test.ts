import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayProfile } from "../../src/core/profiles.js";
import { readGatewayProfileSecret } from "../../src/core/gateway-profile.js";
import { createGatewayServer, type GatewayRequestLog } from "../../src/gateway/server.js";

interface LoopbackHandle {
  endpoint: string;
  close(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).reverse().map((cleanup) => cleanup()));
});

async function createContext() {
  const homeDir = await mkdtemp(path.join(tmpdir(), "ccp-gateway-test-"));
  cleanups.push(() => rm(homeDir, { recursive: true, force: true }));
  return { homeDir };
}

async function listenLoopback(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
): Promise<LoopbackHandle> {
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
  cleanups.push(handle.close);
  return handle;
}

async function readRequestJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function startGateway(context: { homeDir: string }, options: Parameters<typeof createGatewayServer>[0] = {}) {
  const handle = createGatewayServer({ context, ...options });
  const listening = await handle.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(handle.close);
  return { handle, endpoint: listening.endpoint };
}

function anthropicRequest(stream = false) {
  return {
    model: "claude-client-alias",
    max_tokens: 256,
    messages: [{ role: "user", content: "hello" }],
    stream
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
      protocolVersion: 1,
      instanceId: "instance-test",
      endpoint,
      profileCount: 2
    });
    expect(health.pid).toBe(process.pid);
    expect(handle.instanceId).toBe("instance-test");
  });

  it("returns 404 for optional endpoints without loading profile secrets", async () => {
    const context = await createContext();
    const resolve = vi.fn().mockRejectedValue(new Error("must not resolve"));
    const { endpoint } = await startGateway(context, {
      registry: { resolve, countProfiles: vi.fn().mockResolvedValue(0) }
    });

    const count = await fetch(`${endpoint}/p/example/v1/messages/count_tokens`, { method: "POST" });
    const models = await fetch(`${endpoint}/p/example/v1/models`);

    expect(count.status).toBe(404);
    expect(models.status).toBe(404);
    expect(resolve).not.toHaveBeenCalled();
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
    const profileA = await createGatewayProfile({
      name: "provider-a",
      provider: "openai-compatible",
      chatCompletionsUrl: `${upstream.endpoint}/a/v1/chat/completions`,
      apiKey: "upstream-key-a",
      model: "model-a"
    }, context);
    const profileB = await createGatewayProfile({
      name: "provider-b",
      provider: "openai-compatible",
      chatCompletionsUrl: `${upstream.endpoint}/b/v1/chat/completions`,
      apiKey: "upstream-key-b",
      model: "model-b"
    }, context);
    const secretA = await readGatewayProfileSecret(profileA.dir);
    const secretB = await readGatewayProfileSecret(profileB.dir);
    const { endpoint } = await startGateway(context);

    const call = (name: string, token: string) => fetch(`${endpoint}/p/${name}/v1/messages?beta=true`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(anthropicRequest())
    });
    const [responseA, responseB] = await Promise.all([
      call("provider-a", secretA!.localToken),
      call("provider-b", secretB!.localToken)
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

    const crossProfile = await call("provider-b", secretA!.localToken);
    expect(crossProfile.status).toBe(401);
    expect(received).toHaveLength(2);
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
    const profile = await createGatewayProfile({
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
      body: JSON.stringify(anthropicRequest())
    });
    const invalidJson = await fetch(`${endpoint}/p/limits/v1/messages`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: "{"
    });
    const oversized = await fetch(`${endpoint}/p/limits/v1/messages`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(anthropicRequest())
    });

    expect(contentType.status).toBe(415);
    expect(invalidJson.status).toBe(400);
    expect(oversized.status).toBe(413);
  });

  it("preserves upstream 400 messages while redacting exact configured secrets", async () => {
    const context = await createContext();
    const upstream = await listenLoopback((_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: {
          type: "invalid_request_error",
          message: "thinking.type: Extra inputs are not permitted; upstream-secret must not leak"
        }
      }));
    });
    const profile = await createGatewayProfile({
      name: "errors",
      provider: "openai-compatible",
      chatCompletionsUrl: `${upstream.endpoint}/v1/chat/completions`,
      apiKey: "upstream-secret",
      model: "model"
    }, context);
    const secret = await readGatewayProfileSecret(profile.dir);
    const { endpoint } = await startGateway(context);
    const response = await fetch(`${endpoint}/p/errors/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret!.localToken}`
      },
      body: JSON.stringify(anthropicRequest())
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
    const profile = await createGatewayProfile({
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
      body: JSON.stringify(anthropicRequest())
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
    const profile = await createGatewayProfile({
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
      body: JSON.stringify(anthropicRequest())
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
    const profile = await createGatewayProfile({
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
      body: JSON.stringify(anthropicRequest(true))
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
    const profile = await createGatewayProfile({
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
      body: JSON.stringify(anthropicRequest(true))
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('event: message_start');
    expect(body).toContain('event: error');
    expect(body).toContain('Upstream request timed out.');
    expect(body).not.toContain('event: message_stop');
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
    const profile = await createGatewayProfile({
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
        body: JSON.stringify(anthropicRequest(true))
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
    const profile = await createGatewayProfile({
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
      req.end(JSON.stringify(anthropicRequest(true)));
    });

    await Promise.race([
      upstreamClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("upstream was not aborted")), 2_000))
    ]);
    await vi.waitFor(() => expect(logs.some((entry) => entry.status === 499)).toBe(true));
  });
});
