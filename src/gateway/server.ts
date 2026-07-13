import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import type { AddressInfo } from "node:net";
import { assertProfileName, CcpError } from "../core/errors.js";
import type { PathContext } from "../core/paths.js";
import { GATEWAY_PROTOCOL_VERSION } from "../core/gateway-lifecycle.js";
import type { GatewayProtocolCompatibility, GatewayUpstreamProtocol } from "../core/types.js";
import { authorizeLocalGatewayRequest } from "./auth.js";
import { parseAnthropicMessagesRequest } from "./anthropic-source.js";
import type { CanonicalReasoningEffort, CanonicalUsage, ToolNameMapping } from "./canonical.js";
import {
  GatewayProtocolError,
  invalidRequest,
  toAnthropicErrorEnvelope,
  type GatewayError,
  type GatewayErrorType
} from "./errors.js";
import {
  OpenAIResponsesAnthropicStreamBridge,
  type AnthropicStreamBridge
} from "./openai-responses-streaming.js";
import {
  parseOpenAIResponsesResponseWithMetadata,
  serializeOpenAIResponsesRequest
} from "./openai-responses-target.js";
import {
  canonicalResponseToAnthropic,
  sanitizeEndpointUrlForLog
} from "./utils.js";
import {
  parseOpenAIChatResponse,
  serializeOpenAIChatRequest
} from "./openai-chat-target.js";
import { GatewayRegistry, type GatewayRouteSnapshot } from "./registry.js";
import { OpenAIAnthropicStreamBridge } from "./streaming.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3921;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_UPSTREAM_ERROR_BYTES = 1024 * 1024;
const DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES = 64 * 1024 * 1024;
const DEFAULT_TOTAL_TIMEOUT_MS = 10 * 60 * 1000;
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

interface RegistryLike {
  resolve(profileName: string): Promise<GatewayRouteSnapshot>;
  countProfiles(): Promise<number>;
}

export interface GatewayRequestLog {
  requestId: string;
  completedAt: string;
  method: string;
  pathname: string;
  profileName?: string;
  model?: string;
  clientModel?: string;
  stream?: boolean;
  protocol?: GatewayUpstreamProtocol;
  endpointHost?: string;
  endpointUrl?: string;
  effort?: CanonicalReasoningEffort;
  effortMapping?: GatewayProtocolCompatibility["reasoningEffort"];
  upstreamFields?: string[];
  upstreamEventTypes?: string[];
  upstreamItemTypes?: string[];
  inputTokens?: number;
  outputTokens?: number;
  sessionId?: string;
  agentId?: string;
  parentAgentId?: string;
  status: number;
  durationMs: number;
}

export interface GatewayServerOptions {
  context?: PathContext;
  registry?: RegistryLike;
  fetch?: typeof fetch;
  instanceId?: string;
  maxBodyBytes?: number;
  maxUpstreamErrorBytes?: number;
  maxUpstreamResponseBytes?: number;
  totalTimeoutMs?: number;
  now?: () => number;
  randomId?: () => string;
  onRequestComplete?: (entry: GatewayRequestLog) => void;
}

export interface GatewayListenOptions {
  host?: string;
  port?: number;
}

export interface GatewayServerHandle {
  readonly server: Server;
  readonly instanceId: string;
  listen(options?: GatewayListenOptions): Promise<{ host: string; port: number; endpoint: string }>;
  close(): Promise<void>;
}

interface RequestState {
  requestId: string;
  startedAt: number;
  pathname: string;
  profileName?: string;
  model?: string;
  clientModel?: string;
  stream?: boolean;
  protocol?: GatewayUpstreamProtocol;
  endpointHost?: string;
  endpointUrl?: string;
  effort?: CanonicalReasoningEffort;
  effortMapping?: GatewayProtocolCompatibility["reasoningEffort"];
  upstreamFields?: string[];
  upstreamEventTypes?: string[];
  upstreamItemTypes?: string[];
  inputTokens?: number;
  outputTokens?: number;
  status: number;
  clientDisconnected: boolean;
  timedOut: boolean;
}

interface GatewayStreamResult {
  usage: CanonicalUsage;
  error?: GatewayError;
  upstreamEventTypes?: string[];
  upstreamItemTypes?: string[];
}

class ClientDisconnectedError extends Error {
  constructor() {
    super("Client disconnected.");
    this.name = "ClientDisconnectedError";
  }
}

export function createGatewayServer(options: GatewayServerOptions = {}): GatewayServerHandle {
  const registry = options.registry ?? new GatewayRegistry(options.context);
  const fetchImpl = options.fetch ?? fetch;
  const instanceId = options.instanceId ?? process.env.CCP_GATEWAY_INSTANCE_ID ?? randomUUID();
  const now = options.now ?? Date.now;
  const randomId = options.randomId ?? randomUUID;
  const startedAt = now();
  let endpoint = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;

  const server = createServer((req, res) => {
    void handleRequest(req, res, {
      ...options,
      registry,
      fetchImpl,
      instanceId,
      now,
      randomId,
      startedAt,
      getEndpoint: () => endpoint
    }).catch(() => {
      if (!res.headersSent && !res.destroyed) {
        sendError(res, 500, { type: "api_error", message: "Gateway request failed." });
      } else if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
    });
  });

  return {
    server,
    instanceId,
    async listen(listenOptions = {}) {
      const host = listenOptions.host ?? DEFAULT_HOST;
      const port = listenOptions.port ?? DEFAULT_PORT;
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
      const address = server.address() as AddressInfo | null;
      if (!address) {
        throw new CcpError("Gateway server did not report a listening address.");
      }
      endpoint = `http://${host}:${address.port}`;
      return { host, port: address.port, endpoint };
    },
    async close() {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeIdleConnections();
      });
    }
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: GatewayServerOptions & {
    registry: RegistryLike;
    fetchImpl: typeof fetch;
    instanceId: string;
    now: () => number;
    randomId: () => string;
    startedAt: number;
    getEndpoint: () => string;
  }
): Promise<void> {
  const requestId = deps.randomId();
  let url: URL;
  try {
    url = parseRequestUrl(req);
  } catch (error) {
    const mapped = mapGatewayFailure(error, false);
    res.setHeader("x-request-id", requestId);
    sendError(res, mapped.status, mapped.error);
    emitRequestLog(deps, req, {
      requestId,
      startedAt: deps.now(),
      pathname: req.url ?? "",
      status: mapped.status,
      clientDisconnected: false,
      timedOut: false
    });
    return;
  }
  const state: RequestState = {
    requestId,
    startedAt: deps.now(),
    pathname: url.pathname,
    status: 500,
    clientDisconnected: false,
    timedOut: false
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    state.timedOut = true;
    controller.abort(new Error("Gateway upstream request timed out."));
  }, deps.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS);

  res.setHeader("x-request-id", requestId);
  res.once("close", () => {
    if (!res.writableEnded) {
      state.clientDisconnected = true;
      controller.abort(new ClientDisconnectedError());
    }
  });
  req.once("aborted", () => {
    state.clientDisconnected = true;
    controller.abort(new ClientDisconnectedError());
  });

  try {
    if (req.method === "HEAD" && (url.pathname === "/" || isProfileHeadPath(url.pathname))) {
      state.status = 204;
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/health") {
      if (req.method !== "GET") {
        sendError(res, 405, { type: "invalid_request_error", message: "Method not allowed." });
        state.status = 405;
        return;
      }
      const profileCount = await deps.registry.countProfiles();
      state.status = 200;
      sendJson(res, 200, {
        ok: true,
        service: "multi-ccp-gateway",
        protocolVersion: GATEWAY_PROTOCOL_VERSION,
        instanceId: deps.instanceId,
        pid: process.pid,
        endpoint: deps.getEndpoint(),
        profileCount,
        uptime: Math.max(0, Math.floor((deps.now() - deps.startedAt) / 1000))
      });
      return;
    }

    const route = parseProfileRoute(url.pathname);
    if (!route) {
      state.status = 404;
      sendError(res, 404, { type: "not_found_error", message: "Not found." });
      return;
    }
    state.profileName = route.profileName;

    if (route.kind === "count_tokens" || route.kind === "models") {
      state.status = 404;
      sendError(res, 404, { type: "not_found_error", message: "Not found." });
      return;
    }
    if (req.method !== "POST") {
      state.status = 405;
      sendError(res, 405, { type: "invalid_request_error", message: "Method not allowed." });
      return;
    }

    let snapshot: GatewayRouteSnapshot;
    try {
      snapshot = await deps.registry.resolve(route.profileName);
    } catch {
      state.status = 401;
      sendError(res, 401, { type: "authentication_error", message: "Invalid authentication credentials." });
      return;
    }
    if (!authorizeLocalGatewayRequest(req.headers, snapshot.secret.localToken)) {
      state.status = 401;
      sendError(res, 401, { type: "authentication_error", message: "Invalid authentication credentials." });
      return;
    }

    validateAnthropicVersion(req);
    validateJsonContentType(req);
    const input = await readJsonBody(req, deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
    const canonical = parseAnthropicMessagesRequest(input);
    state.model = snapshot.config.model;
    state.clientModel = canonical.clientModel;
    state.stream = canonical.stream;
    state.protocol = snapshot.config.protocol;
    state.endpointHost = new URL(snapshot.config.endpointUrl).host;
    state.endpointUrl = snapshot.config.endpointUrl;
    state.effort = canonical.outputConfig?.effort;
    state.effortMapping = snapshot.config.compatibility.reasoningEffort;

    if (snapshot.config.protocol === "openai_responses") {
      const converted = serializeOpenAIResponsesRequest(canonical, {
        model: snapshot.config.model,
        compatibility: snapshot.config.compatibility
      });
      state.upstreamFields = Object.keys(converted.body).sort();
      const upstream = await fetchUpstream(snapshot, converted.body, controller.signal, deps.fetchImpl, state);
      if (!upstream.ok) {
        const mapped = await mapUpstreamError(
          upstream,
          snapshot,
          deps.maxUpstreamErrorBytes ?? DEFAULT_MAX_UPSTREAM_ERROR_BYTES,
          state
        );
        state.status = mapped.status;
        sendError(res, mapped.status, mapped.error);
        return;
      }
      if (canonical.stream) {
        const result = await pipeStreamingResponse(
          res,
          upstream,
          snapshot.config.protocol,
          converted.toolNames,
          snapshot.config.model,
          controller.signal
        );
        state.upstreamEventTypes = result.upstreamEventTypes;
        state.upstreamItemTypes = result.upstreamItemTypes;
        state.inputTokens = result.usage.inputTokens;
        state.outputTokens = result.usage.outputTokens;
        state.status = result.error ? 502 : 200;
        return;
      }
      const parsed = await readUpstreamJson(
        upstream,
        deps.maxUpstreamResponseBytes ?? DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES
      );
      const convertedResponse = parseOpenAIResponsesResponseWithMetadata(parsed, {
        toolNames: converted.toolNames,
        modelFallback: snapshot.config.model
      });
      state.upstreamItemTypes = convertedResponse.upstreamItemTypes;
      state.inputTokens = convertedResponse.response.usage.inputTokens;
      state.outputTokens = convertedResponse.response.usage.outputTokens;
      state.status = 200;
      sendJson(res, 200, canonicalResponseToAnthropic(convertedResponse.response));
      return;
    }

    const converted = serializeOpenAIChatRequest(canonical, {
      model: snapshot.config.model,
      compatibility: snapshot.config.compatibility
    });
    state.upstreamFields = Object.keys(converted.body).sort();
    const upstream = await fetchUpstream(snapshot, converted.body, controller.signal, deps.fetchImpl, state);

    if (!upstream.ok) {
      const mapped = await mapUpstreamError(
        upstream,
        snapshot,
        deps.maxUpstreamErrorBytes ?? DEFAULT_MAX_UPSTREAM_ERROR_BYTES,
        state
      );
      state.status = mapped.status;
      sendError(res, mapped.status, mapped.error);
      return;
    }

    if (canonical.stream) {
      const result = await pipeStreamingResponse(
        res,
        upstream,
        snapshot.config.protocol,
        converted.toolNames,
        snapshot.config.model,
        controller.signal
      );
      state.inputTokens = result.usage.inputTokens;
      state.outputTokens = result.usage.outputTokens;
      state.status = result.error ? 502 : 200;
      return;
    }

    const parsed = await readUpstreamJson(
      upstream,
      deps.maxUpstreamResponseBytes ?? DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES
    );
    const response = parseOpenAIChatResponse(parsed, {
      toolNames: converted.toolNames,
      modelFallback: snapshot.config.model
    });
    state.inputTokens = response.usage.inputTokens;
    state.outputTokens = response.usage.outputTokens;
    state.status = 200;
    sendJson(res, 200, canonicalResponseToAnthropic(response));
  } catch (error) {
    if (state.clientDisconnected || error instanceof ClientDisconnectedError) {
      state.status = 499;
      return;
    }
    const mapped = mapGatewayFailure(error, state.timedOut);
    state.status = mapped.status;
    if (!res.headersSent) {
      sendError(res, mapped.status, mapped.error);
    } else if (!res.writableEnded) {
      await writeWithBackpressure(
        res,
        formatAnthropicSseError(mapped.error),
        new AbortController().signal
      ).catch(() => undefined);
      res.end();
    }
  } finally {
    clearTimeout(timeout);
    emitRequestLog(deps, req, state);
  }
}

function parseRequestUrl(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? "/", "http://127.0.0.1");
  } catch {
    throw invalidRequest("Request URL is invalid.");
  }
}

function isProfileHeadPath(pathname: string): boolean {
  const match = pathname.match(/^\/p\/([^/]+)\/?$/);
  if (!match) return false;
  try {
    assertProfileName(decodeURIComponent(match[1]));
    return true;
  } catch {
    return false;
  }
}

function parseProfileRoute(pathname: string): {
  profileName: string;
  kind: "messages" | "count_tokens" | "models";
} | undefined {
  const match = pathname.match(/^\/p\/([^/]+)\/v1\/(messages(?:\/count_tokens)?|models)$/);
  if (!match) return undefined;
  let profileName: string;
  try {
    profileName = decodeURIComponent(match[1]);
    assertProfileName(profileName);
  } catch {
    return undefined;
  }
  return {
    profileName,
    kind: match[2] === "messages" ? "messages" : match[2] === "models" ? "models" : "count_tokens"
  };
}

function validateAnthropicVersion(req: IncomingMessage): void {
  const version = readHeader(req.headers["anthropic-version"]);
  if (version !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(version)) {
    throw invalidRequest("anthropic-version: Expected a date in YYYY-MM-DD format.");
  }
}

function validateJsonContentType(req: IncomingMessage): void {
  const contentType = readHeader(req.headers["content-type"])?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new GatewayProtocolError(
      { type: "invalid_request_error", message: "Content-Type must be application/json." },
      415
    );
  }
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const declaredLength = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    req.resume();
    throw new GatewayProtocolError(
      { type: "invalid_request_error", message: `Request body exceeds the ${maxBytes}-byte limit.` },
      413
    );
  }

  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maxBytes) {
      req.resume();
      throw new GatewayProtocolError(
        { type: "invalid_request_error", message: `Request body exceeds the ${maxBytes}-byte limit.` },
        413
      );
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    throw invalidRequest("Request body must contain JSON.");
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new GatewayProtocolError(
      { type: "invalid_request_error", message: "Request body is not valid JSON." },
      400,
      { cause: error }
    );
  }
}

async function fetchUpstream(
  snapshot: GatewayRouteSnapshot,
  body: Record<string, unknown>,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
  state: RequestState
): Promise<Response> {
  try {
    return await fetchImpl(snapshot.config.endpointUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${snapshot.secret.apiKey}`,
        "content-type": "application/json",
        accept: body.stream === true ? "text/event-stream" : "application/json"
      },
      body: JSON.stringify(body),
      redirect: "manual",
      signal
    });
  } catch (error) {
    if (signal.aborted) {
      if (state.clientDisconnected) throw new ClientDisconnectedError();
      if (state.timedOut) {
        throw new GatewayProtocolError({ type: "api_error", message: "Upstream request timed out." }, 504, { cause: error });
      }
    }
    throw new GatewayProtocolError({ type: "api_error", message: "Unable to connect to the upstream provider." }, 502, { cause: error });
  }
}

async function pipeStreamingResponse(
  res: ServerResponse,
  upstream: Response,
  protocol: GatewayUpstreamProtocol,
  toolNames: ToolNameMapping,
  model: string,
  signal: AbortSignal
): Promise<GatewayStreamResult> {
  if (!upstream.body) {
    throw new GatewayProtocolError({ type: "api_error", message: "Upstream streaming response has no body." }, 502);
  }
  const bridge: AnthropicStreamBridge = protocol === "openai_responses"
    ? new OpenAIResponsesAnthropicStreamBridge({ model, toolNames })
    : new OpenAIAnthropicStreamBridge({
        messageId: `msg_${randomUUID().replace(/-/g, "")}`,
        model,
        toolNames
      });
  const toResult = (): GatewayStreamResult => {
    const metadata = bridge.metadata;
    return {
      usage: bridge.usage,
      ...(bridge.error ? { error: bridge.error } : {}),
      ...(metadata ? {
        upstreamEventTypes: metadata.upstreamEventTypes,
        upstreamItemTypes: metadata.upstreamItemTypes
      } : {})
    };
  };
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const output of bridge.push(value)) {
        await writeWithBackpressure(res, output, signal);
      }
      if (bridge.isTerminal) {
        await reader.cancel();
        res.end();
        return toResult();
      }
    }
    for (const output of bridge.finish()) {
      await writeWithBackpressure(res, output, signal);
    }
    res.end();
    return toResult();
  } finally {
    if (signal.aborted) {
      await reader.cancel(signal.reason).catch(() => undefined);
    }
    reader.releaseLock();
  }
}

async function writeWithBackpressure(res: ServerResponse, value: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted || res.destroyed || res.writableEnded) {
    throw new ClientDisconnectedError();
  }
  if (res.write(value)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      signal.removeEventListener("abort", onAbort);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new ClientDisconnectedError());
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new ClientDisconnectedError());
    };
    res.once("drain", onDrain);
    res.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function readUpstreamJson(response: Response, maxBytes: number): Promise<unknown> {
  const raw = await readResponseTextLimited(response, maxBytes);
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new GatewayProtocolError(
      { type: "api_error", message: "Upstream response is not valid JSON." },
      502,
      { cause: error }
    );
  }
}

async function readResponseTextLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new GatewayProtocolError({ type: "api_error", message: "Upstream response exceeded the gateway size limit." }, 502);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

async function mapUpstreamError(
  response: Response,
  snapshot: GatewayRouteSnapshot,
  maxBytes: number,
  state: RequestState
): Promise<{ status: number; error: GatewayError }> {
  let raw = "";
  try {
    raw = await readResponseTextLimited(response, maxBytes);
  } catch (error) {
    if (state.clientDisconnected || state.timedOut) throw error;
  }
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    parsed = undefined;
  }
  const message = redactKnownSecrets(extractErrorMessage(parsed) ?? defaultUpstreamErrorMessage(response.status), snapshot);

  if (isAnthropicErrorEnvelope(parsed) && response.status === 400) {
    return {
      status: response.status,
      error: {
        type: normalizeGatewayErrorType(parsed.error.type, mapUpstreamStatus(response.status).error.type),
        message
      }
    };
  }
  const mapped = mapUpstreamStatus(response.status);
  return { status: mapped.status, error: { type: mapped.error.type, message } };
}

function mapUpstreamStatus(status: number): { status: number; error: GatewayError } {
  if (status === 400 || status === 422) {
    return { status: 400, error: { type: "invalid_request_error", message: "Invalid upstream request." } };
  }
  if (status === 404) {
    return { status: 502, error: { type: "not_found_error", message: "The upstream resource was not found." } };
  }
  if (status === 429) {
    return { status: 429, error: { type: "rate_limit_error", message: "The upstream rate limit was exceeded." } };
  }
  return { status: 502, error: { type: "api_error", message: "The upstream provider returned an error." } };
}

function defaultUpstreamErrorMessage(status: number): string {
  if (status === 401 || status === 403) return "Upstream authentication failed.";
  return mapUpstreamStatus(status).error.message;
}

function extractErrorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const error = isRecord(value.error) ? value.error : value;
  return typeof error.message === "string" && error.message.length > 0 ? error.message : undefined;
}

function isAnthropicErrorEnvelope(value: unknown): value is { type: "error"; error: { type?: unknown; message: string } } {
  return isRecord(value) && value.type === "error" && isRecord(value.error) && typeof value.error.message === "string";
}

function normalizeGatewayErrorType(value: unknown, fallback: GatewayErrorType): GatewayErrorType {
  return value === "invalid_request_error" || value === "authentication_error" || value === "not_found_error" ||
    value === "rate_limit_error" || value === "api_error"
    ? value
    : fallback;
}

function redactKnownSecrets(message: string, snapshot: GatewayRouteSnapshot): string {
  let result = message;
  for (const secret of [snapshot.secret.localToken, snapshot.secret.apiKey]) {
    if (secret) result = result.split(secret).join("[redacted]");
  }
  return result;
}

function mapGatewayFailure(error: unknown, timedOut: boolean): { status: number; error: GatewayError } {
  if (error instanceof GatewayProtocolError) {
    return { status: error.status, error: error.error };
  }
  if (timedOut) {
    return { status: 504, error: { type: "api_error", message: "Upstream request timed out." } };
  }
  return { status: 500, error: { type: "api_error", message: "Gateway request failed." } };
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { "content-type": JSON_CONTENT_TYPE });
  res.end(JSON.stringify(value));
}

function sendError(res: ServerResponse, status: number, error: GatewayError): void {
  sendJson(res, status, toAnthropicErrorEnvelope(error));
}

function formatAnthropicSseError(error: GatewayError): string {
  return `event: error\ndata: ${JSON.stringify(toAnthropicErrorEnvelope(error))}\n\n`;
}

function readHeader(value: string | string[] | undefined): string | undefined {
  const normalized = Array.isArray(value) ? value[0] : value;
  return normalized?.trim() || undefined;
}

function emitRequestLog(
  deps: Pick<GatewayServerOptions, "onRequestComplete"> & { now: () => number },
  req: IncomingMessage,
  state: RequestState
): void {
  if (!deps.onRequestComplete) return;
  const sessionId = readHeader(req.headers["x-claude-code-session-id"]);
  const agentId = readHeader(req.headers["x-claude-code-agent-id"]);
  const parentAgentId = readHeader(req.headers["x-claude-code-parent-agent-id"]);
  const completedAt = deps.now();
  try {
    deps.onRequestComplete({
      requestId: state.requestId,
      completedAt: new Date(completedAt).toISOString(),
      method: req.method ?? "UNKNOWN",
      pathname: state.pathname,
      ...(state.profileName ? { profileName: state.profileName } : {}),
      ...(state.model ? { model: state.model } : {}),
      ...(state.clientModel ? { clientModel: state.clientModel } : {}),
      ...(state.protocol ? { protocol: state.protocol } : {}),
      ...(state.endpointHost ? { endpointHost: state.endpointHost } : {}),
      ...(state.endpointUrl ? { endpointUrl: sanitizeEndpointUrlForLog(state.endpointUrl) } : {}),
      ...(state.stream === undefined ? {} : { stream: state.stream }),
      ...(state.effort ? { effort: state.effort } : {}),
      ...(state.effortMapping ? { effortMapping: state.effortMapping } : {}),
      ...(state.upstreamFields ? { upstreamFields: [...state.upstreamFields] } : {}),
      ...(state.upstreamEventTypes ? { upstreamEventTypes: [...state.upstreamEventTypes] } : {}),
      ...(state.upstreamItemTypes ? { upstreamItemTypes: [...state.upstreamItemTypes] } : {}),
      ...(state.inputTokens === undefined ? {} : { inputTokens: state.inputTokens }),
      ...(state.outputTokens === undefined ? {} : { outputTokens: state.outputTokens }),
      ...(sessionId ? { sessionId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(parentAgentId ? { parentAgentId } : {}),
      status: state.status,
      durationMs: Math.max(0, completedAt - state.startedAt)
    });
  } catch {
    // Observability hooks must never change gateway request behavior.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
