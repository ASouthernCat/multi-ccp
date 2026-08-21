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
  type GatewayFailureCode,
  type GatewayErrorType
} from "./errors.js";
import {
  OpenAIResponsesAnthropicStreamBridge,
  type AnthropicStreamBridge
} from "./openai-responses-streaming.js";
import { GeneratedImageStore, type PreparedGeneratedImage } from "./generated-image.js";
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
import { buildGatewayModelDiscovery, resolveGatewayModel } from "./models.js";
import { CollabHub } from "../collab/hub.js";
import { handleMcpRpcRequest, type JsonRpcRequest } from "../collab/mcp-protocol.js";
import type { CollabMessage } from "../collab/types.js";
import { executePeerClaudeTask } from "../collab/cli-worker.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3921;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_UPSTREAM_ERROR_BYTES = 1024 * 1024;
const DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES = 64 * 1024 * 1024;
const DEFAULT_TOTAL_TIMEOUT_MS = 10 * 60 * 1000;
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

function withoutLocalSessionMetadata<T extends object>(record: T): Omit<T, "projectKey" | "projectDir"> {
  const publicRecord = { ...record } as T & { projectKey?: unknown; projectDir?: unknown };
  delete publicRecord.projectKey;
  delete publicRecord.projectDir;
  return publicRecord;
}

interface RegistryLike {
  resolve(profileName: string): Promise<GatewayRouteSnapshot>;
  countProfiles(): Promise<number>;
}
export type GatewayFailureStage =
  | "request_validation"
  | "upstream_connect"
  | "upstream_http"
  | "upstream_response"
  | "stream_protocol"
  | "stream_eof"
  | "gateway_timeout"
  | "client_disconnect"
  | "gateway_internal";

export type GatewayRequestKind = "messages" | "count_tokens" | "models";
export type GatewayRequestOutcome = "success" | "expected_unsupported" | "failure";
export type GatewayValidationRule =
  | "invalid_json"
  | "invalid_content_type"
  | "required"
  | "invalid_type"
  | "unsupported_field"
  | "unsupported_value"
  | "extra_field"
  | "invalid_order"
  | "size_limit";

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
  requestKind?: GatewayRequestKind;
  outcome?: GatewayRequestOutcome;
  errorSummary?: string;
  validationField?: string;
  validationRule?: GatewayValidationRule;
  upstreamErrorCode?: string;
  upstreamErrorParam?: string;
  upstreamFields?: string[];
  upstreamToolTypes?: string[];
  upstreamToolCount?: number;
  upstreamInputItems?: number;
  upstreamHasToolChoice?: boolean;
  upstreamEventTypes?: string[];
  upstreamItemTypes?: string[];
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  failureStage?: GatewayFailureStage;
  failureCode?: GatewayFailureCode;
  errorType?: GatewayErrorType;
  upstreamStatus?: number;
  upstreamRequestId?: string;
  firstEventMs?: number;
  lastEventType?: string;
  terminalEventReceived?: boolean;
  sessionId?: string;
  agentId?: string;
  parentAgentId?: string;
  status: number;
  durationMs: number;
}

export interface GatewayServerOptions {
  context?: PathContext;
  registry?: RegistryLike;
  collabHub?: CollabHub;
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
  readonly collabHub: CollabHub;
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
  requestKind?: GatewayRequestKind;
  outcome?: GatewayRequestOutcome;
  errorSummary?: string;
  validationField?: string;
  validationRule?: GatewayValidationRule;
  upstreamErrorCode?: string;
  upstreamErrorParam?: string;
  upstreamFields?: string[];
  upstreamToolTypes?: string[];
  upstreamToolCount?: number;
  upstreamInputItems?: number;
  upstreamHasToolChoice?: boolean;
  upstreamEventTypes?: string[];
  upstreamItemTypes?: string[];
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  failureStage?: GatewayFailureStage;
  failureCode?: GatewayFailureCode;
  errorType?: GatewayErrorType;
  upstreamStatus?: number;
  upstreamRequestId?: string;
  firstEventMs?: number;
  lastEventType?: string;
  terminalEventReceived?: boolean;
  activeStage?: GatewayFailureStage;
  status: number;
  clientDisconnected: boolean;
  timedOut: boolean;
}

interface GatewayStreamResult {
  usage: CanonicalUsage;
  error?: GatewayError;
  upstreamEventTypes?: string[];
  upstreamItemTypes?: string[];
  firstEventMs?: number;
  lastEventType?: string;
  terminalEventReceived?: boolean;
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
  const collabHub = options.collabHub ?? new CollabHub();
  const startedAt = now();
  let endpoint = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;

  const server = createServer((req, res) => {
    void handleRequest(req, res, {
      ...options,
      registry,
      collabHub,
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

  collabHub.setAutoResponder(async (msg) => {
    // An active terminal must produce the real reply through reply_peer. A
    // delivery acknowledgement is not a valid answer to ask_peer.
    const targetPeer = collabHub.findPeer(msg.to, msg.toPeerId);
    if (collabHub.hasActiveSubscriber(msg.to, msg.toPeerId)) return undefined;

    // An offline peer is executed through a dedicated background Claude CLI
    // session. Failures remain failures instead of becoming successful replies.
    try {
      return { reply: await executePeerClaudeTask(msg, options.context, targetPeer?.projectDir) };
    } catch (error) {
      const fallback = await generatePeerAutoResponse(registry, endpoint, msg);
      if (fallback) return { reply: fallback };
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  return {
    server,
    instanceId,
    collabHub,
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
    collabHub: CollabHub;
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

    if (url.pathname === "/mcp/collab/sse") {
      if (url.searchParams.get("role") !== "terminal") {
        sendError(res, 400, { type: "invalid_request_error", message: "Collaboration SSE is reserved for terminal sessions." });
        state.status = 400;
        return;
      }
      const profile = url.searchParams.get("profile") || "anonymous";
      const project = url.searchParams.get("project") || "default";
      const peerId = url.searchParams.get("peerId") || undefined;
      if (deps.collabHub.isSupervisorTarget(profile)) {
        sendError(res, 400, { type: "invalid_request_error", message: "The Web UI supervisor cannot connect as a CLI peer." });
        state.status = 400;
        return;
      }
      const model = url.searchParams.get("model") || undefined;
      const pidStr = url.searchParams.get("pid");
      const pid = pidStr ? Number.parseInt(pidStr, 10) : undefined;

      const projectDir = url.searchParams.get("projectDir") || undefined;

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*"
      });

      deps.collabHub.registerPeer({
        peerId,
        profile,
        projectKey: project,
        projectDir,
        model,
        pid,
        status: "idle"
      });

      const endpointPeerId = peerId ? `&peerId=${encodeURIComponent(peerId)}` : "";
      res.write(`event: endpoint\ndata: /mcp/collab/message?profile=${encodeURIComponent(profile)}&project=${encodeURIComponent(project)}${endpointPeerId}\n\n`);

      const unsubscribe = deps.collabHub.subscribe(profile, project, (msg) => {
        if (!res.destroyed && !res.writableEnded) {
          res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
        }
      }, peerId);

      const keepAliveTimer = setInterval(() => {
        if (!res.destroyed && !res.writableEnded) {
          deps.collabHub.heartbeat(profile, peerId);
          res.write(": keepalive\n\n");
        }
      }, 15000);

      req.on("close", () => {
        clearInterval(keepAliveTimer);
        unsubscribe();
        if (!deps.collabHub.hasActiveSubscriber(profile, peerId)) {
          deps.collabHub.unregisterPeer(profile, peerId);
        }
      });
      state.status = 200;
      return;
    }

    if (url.pathname === "/mcp/collab/message") {
      if (req.method !== "POST") {
        sendError(res, 405, { type: "invalid_request_error", message: "Method not allowed." });
        state.status = 405;
        return;
      }
      const profile = url.searchParams.get("profile") || "anonymous";
      const project = url.searchParams.get("project") || "default";
      const peerId = url.searchParams.get("peerId") || undefined;
      if (deps.collabHub.isSupervisorTarget(profile)) {
        sendError(res, 400, { type: "invalid_request_error", message: "The Web UI supervisor cannot call Agent MCP tools." });
        state.status = 400;
        return;
      }
      const body = await readJsonBody(req, deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
      const response = await handleMcpRpcRequest(deps.collabHub, { profile, peerId, projectKey: project, context: deps.context }, body as JsonRpcRequest);
      state.status = response ? 200 : 202;
      if (response) {
        sendJson(res, 200, response);
      } else {
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }
      return;
    }

    if (url.pathname === "/api/collab/peers") {
      if (req.method !== "GET") {
        sendError(res, 405, { type: "invalid_request_error", message: "Method not allowed." });
        state.status = 405;
        return;
      }
      const peers = deps.collabHub.listPeers().map(withoutLocalSessionMetadata);
      state.status = 200;
      sendJson(res, 200, { ok: true, peers });
      return;
    }

    if (url.pathname === "/api/collab/blackboard") {
      if (req.method === "GET") {
        const blackboard = deps.collabHub.listBlackboard();
        state.status = 200;
        sendJson(res, 200, { ok: true, blackboard });
        return;
      }
      if (req.method === "POST") {
        const body = await readJsonBody(req, deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES) as Record<string, unknown>;
        const key = typeof body.key === "string" ? body.key.trim() : "";
        if (!key || typeof body.value !== "string") {
          sendError(res, 400, {
            type: "invalid_request_error",
            message: "Blackboard writes require a non-empty string 'key' field and a string 'value'."
          });
          state.status = 400;
          return;
        }
        const entry = deps.collabHub.setBlackboard({
          key,
          value: body.value,
          author: "web-ui"
        });
        state.status = 201;
        sendJson(res, 201, { ok: true, entry });
        return;
      }
      sendError(res, 405, { type: "invalid_request_error", message: "Method not allowed." });
      state.status = 405;
      return;
    }

    if (url.pathname === "/mcp/collab/activity") {
      if (req.method !== "POST") {
        sendError(res, 405, { type: "invalid_request_error", message: "Method not allowed." });
        state.status = 405;
        return;
      }
      const peerId = String(url.searchParams.get("peerId") || "").trim();
      const rawKind = url.searchParams.get("kind");
      const kind = rawKind === "input" || rawKind === "tool" ? rawKind : "output";
      if (!peerId) {
        sendError(res, 400, { type: "invalid_request_error", message: "Missing 'peerId'." });
        state.status = 400;
        return;
      }
      const recorded = deps.collabHub.recordPeerActivity(peerId, kind);
      state.status = recorded ? 204 : 404;
      res.writeHead(state.status);
      res.end();
      return;
    }

    if (url.pathname === "/api/collab/dispatches") {
      if (req.method !== "GET") {
        sendError(res, 405, { type: "invalid_request_error", message: "Method not allowed." });
        state.status = 405;
        return;
      }
      const limitValue = Number.parseInt(url.searchParams.get("limit") || "100", 10);
      const statusValue = url.searchParams.get("status") || undefined;
      const status = statusValue === "pending" || statusValue === "waiting" || statusValue === "processing"
        || statusValue === "stalled" || statusValue === "disconnected" || statusValue === "completed"
        || statusValue === "timeout" || statusValue === "error"
        ? statusValue
        : undefined;
      const dispatches = deps.collabHub.listDispatches({
        limit: Number.isFinite(limitValue) ? limitValue : 100,
        status
      }).map(withoutLocalSessionMetadata);
      const summary = dispatches.reduce((counts, dispatch) => {
        counts[dispatch.status] += 1;
        return counts;
      }, { pending: 0, waiting: 0, processing: 0, stalled: 0, disconnected: 0, completed: 0, timeout: 0, error: 0 });
      state.status = 200;
      sendJson(res, 200, { ok: true, dispatches, summary });
      return;
    }

    if (url.pathname === "/api/collab/supervisor/messages") {
      if (req.method === "GET") {
        const unreadOnly = url.searchParams.get("unread") === "true";
        const limitValue = Number.parseInt(url.searchParams.get("limit") || "100", 10);
        const messages = deps.collabHub.listSupervisorMessages({
          unreadOnly,
          limit: Number.isFinite(limitValue) ? limitValue : 100
        }).map(withoutLocalSessionMetadata);
        state.status = 200;
        sendJson(res, 200, {
          ok: true,
          unread: messages.filter((message) => !message.readAt).length,
          messages
        });
        return;
      }
      if (req.method === "POST") {
        const body = await readJsonBody(req, deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES) as Record<string, unknown>;
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : undefined;
        const marked = deps.collabHub.markSupervisorMessagesRead({
          ids,
          all: body.all === true
        });
        state.status = 200;
        sendJson(res, 200, { ok: true, marked });
        return;
      }
      sendError(res, 405, { type: "invalid_request_error", message: "Method not allowed." });
      state.status = 405;
      return;
    }

    if (url.pathname === "/api/collab/supervisor/dispatch") {
      if (req.method !== "POST") {
        sendError(res, 405, { type: "invalid_request_error", message: "Method not allowed." });
        state.status = 405;
        return;
      }
      const body = await readJsonBody(req, deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES) as Record<string, unknown>;
      const target = String(body.to ?? "").trim();
      const targetPeerId = String(body.peerId ?? body.toPeerId ?? "").trim() || undefined;
      const relayTo = String(body.relayTo ?? "").trim();
      const relayPeerId = String(body.relayPeerId ?? "").trim() || undefined;
      const message = String(body.message ?? "").trim();
      const mode = body.mode === "relay" ? "relay" : body.mode === "ask" ? "ask" : "task";
      const reportBack = mode === "relay" ? body.reportBack === true : body.reportBack !== false;
      if (!target || !message || (mode === "relay" && !relayTo)) {
        sendError(res, 400, { type: "invalid_request_error", message: "Missing dispatch target, relay target, or message." });
        state.status = 400;
        return;
      }
      if (mode === "relay" && target.toLowerCase() === relayTo.toLowerCase()
        && (!targetPeerId || !relayPeerId || targetPeerId === relayPeerId)) {
        sendError(res, 400, { type: "invalid_request_error", message: "Relay source and target must be different agents." });
        state.status = 400;
        return;
      }

      const targetLower = target.toLowerCase();
      const matchingPeers = deps.collabHub
        .listPeers()
        .filter((candidate) => candidate.profile.trim().toLowerCase() === targetLower);
      const selectedTarget = targetPeerId
        ? matchingPeers.find((candidate) => candidate.peerId === targetPeerId)
        : matchingPeers.length === 1 ? matchingPeers[0] : undefined;
      if (targetPeerId && !selectedTarget) {
        sendError(res, 404, {
          type: "not_found_error",
          message: `No active Agent CLI '@${target}' with peerId '${targetPeerId}' was found.`
        });
        state.status = 404;
        return;
      }
      if (!targetPeerId && matchingPeers.length > 1) {
        const peerIds = matchingPeers.map((candidate) => candidate.peerId).sort().join(", ");
        sendError(res, 409, {
          type: "invalid_request_error",
          message: `Agent '@${target}' has multiple active CLI instances (${peerIds}). Specify 'peerId'.`
        });
        state.status = 409;
        return;
      }
      if (!selectedTarget) {
        sendError(res, 404, { type: "not_found_error", message: `No active Agent CLI '@${target}' was found.` });
        state.status = 404;
        return;
      }
      const relayMatches = mode === "relay"
        ? deps.collabHub.listPeers().filter((candidate) => candidate.profile.trim().toLowerCase() === relayTo.toLowerCase())
        : [];
      const selectedRelay = mode !== "relay" ? undefined : relayPeerId
        ? relayMatches.find((candidate) => candidate.peerId === relayPeerId)
        : relayMatches.length === 1 ? relayMatches[0] : undefined;
      if (mode === "relay" && !selectedRelay) {
        const detail = relayMatches.length > 1 && !relayPeerId
          ? `Agent '@${relayTo}' has multiple active CLI instances. Specify 'relayPeerId'.`
          : `No active Agent CLI '@${relayTo}'${relayPeerId ? ` with peerId '${relayPeerId}'` : ""} was found.`;
        sendError(res, relayMatches.length > 1 ? 409 : 404, { type: "invalid_request_error", message: detail });
        state.status = relayMatches.length > 1 ? 409 : 404;
        return;
      }
      // The working session is local execution metadata, not a routing or visibility scope.
      const projectKey = selectedTarget.projectKey || "global";
      const relayIdentityHint = selectedRelay ? `，并在工具参数 peer_id 中指定 "${selectedRelay.peerId}"` : "";
      const instructionContent = mode === "relay"
        ? `请联系 @${relayTo}${relayIdentityHint}，向其传达以下协作请求：${message}`
        : mode === "ask"
          ? `请处理并回答监管台的问题：${message}`
          : message;
      const instructionContext = mode === "relay"
        ? "这是用户通过 Web UI 可视化协作面板发出的路由指令。Web UI 只负责监管和调度，不是 Agent CLI。"
        : "这是用户通过 Web UI 可视化协作面板直接发出的监管指令。Web UI 不是 Agent CLI。";

      const result = await deps.collabHub.sendMessage({
        from: "web-ui",
        to: target,
        toPeerId: selectedTarget.peerId,
        projectKey,
        type: "task",
        content: instructionContent,
        context: instructionContext,
        waitForReply: false,
        origin: "supervisor",
        responsePolicy: reportBack ? "supervisor" : "none",
        relayTo: mode === "relay" ? relayTo : undefined
      });
      state.status = 200;
      sendJson(res, 200, {
        ok: true,
        mode,
        instructionTarget: target,
        peerId: selectedTarget.peerId,
        relayTo: mode === "relay" ? relayTo : undefined,
        relayPeerId: selectedRelay?.peerId,
        reportBack,
        messageId: result.messageId,
        status: result.status,
        responseStatus: result.responseStatus
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
    state.requestKind = route.kind;

    if (route.kind === "count_tokens") {
      state.status = 404;
      state.outcome = "expected_unsupported";
      sendError(res, 404, { type: "not_found_error", message: "Not found." });
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
    if (route.kind === "models") {
      if (req.method !== "GET") {
        state.status = 405;
        sendError(res, 405, { type: "invalid_request_error", message: "Method not allowed." });
        return;
      }
      state.status = 200;
      state.outcome = "success";
      const models = buildGatewayModelDiscovery(snapshot);
      sendJson(res, 200, {
        data: models,
        has_more: false,
        first_id: models[0]?.id ?? null,
        last_id: models.at(-1)?.id ?? null
      });
      return;
    }
    if (req.method !== "POST") {
      state.status = 405;
      sendError(res, 405, { type: "invalid_request_error", message: "Method not allowed." });
      return;
    }

    state.activeStage = "request_validation";
    validateAnthropicVersion(req);
    validateJsonContentType(req);
    const input = await readJsonBody(req, deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
    const canonical = parseAnthropicMessagesRequest(input);
    state.clientModel = canonical.clientModel;
    const selectedModel = resolveGatewayModel(canonical.clientModel, snapshot);
    state.model = selectedModel;
    state.stream = canonical.stream;
    state.protocol = snapshot.config.protocol;
    state.endpointHost = new URL(snapshot.config.endpointUrl).host;
    state.endpointUrl = snapshot.config.endpointUrl;
    state.effort = canonical.outputConfig?.effort;
    state.effortMapping = snapshot.config.compatibility.reasoningEffort;

    if (snapshot.config.protocol === "openai_responses") {
      const imageStore = new GeneratedImageStore({
        context: deps.context,
        requestId: state.requestId,
        sessionId: readHeader(req.headers["x-claude-code-session-id"])
      });
      const converted = serializeOpenAIResponsesRequest(canonical, {
        model: selectedModel,
        compatibility: snapshot.config.compatibility
      });
      state.upstreamFields = Object.keys(converted.body).sort();
      annotateUpstreamRequestShape(state, converted.body);
      const upstream = await fetchUpstream(snapshot, converted.body, controller.signal, deps.fetchImpl, state);
      if (!upstream.ok) {
        const mapped = await mapUpstreamError(
          upstream,
          snapshot,
          deps.maxUpstreamErrorBytes ?? DEFAULT_MAX_UPSTREAM_ERROR_BYTES,
          state
        );
        state.status = mapped.status;
        setFailure(state, "upstream_http", "upstream_http_error", mapped.error, mapped.diagnostics);
        sendError(res, mapped.status, mapped.error);
        return;
      }
      if (canonical.stream) {
        const result = await pipeStreamingResponse(
          res,
          upstream,
          snapshot.config.protocol,
          converted.toolNames,
          selectedModel,
          controller.signal,
          state.startedAt,
          deps.now,
          (firstEventMs) => { state.firstEventMs ??= firstEventMs; },
          imageStore
        );
        state.upstreamEventTypes = result.upstreamEventTypes;
        state.upstreamItemTypes = result.upstreamItemTypes;
        state.inputTokens = result.usage.inputTokens;
        state.outputTokens = result.usage.outputTokens;
        state.cacheReadInputTokens = result.usage.cacheReadInputTokens;
        state.cacheCreationInputTokens = result.usage.cacheCreationInputTokens;
        state.firstEventMs = result.firstEventMs;
        state.lastEventType = result.lastEventType;
        state.terminalEventReceived = result.terminalEventReceived;
        if (result.error) {
          setFailure(state, classifyResponsesStreamFailure(result), result.error.code ?? "upstream_response_error", result.error);
        }
        state.status = result.error ? 502 : 200;
        return;
      }
      const parsed = await readUpstreamJson(
        upstream,
        deps.maxUpstreamResponseBytes ?? DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES
      );
      const convertedResponse = parseOpenAIResponsesResponseWithMetadata(parsed, {
        toolNames: converted.toolNames,
        modelFallback: selectedModel,
        imageStore
      });
      await persistGeneratedImages(imageStore, convertedResponse.generatedImages);
      state.upstreamItemTypes = convertedResponse.upstreamItemTypes;
      state.inputTokens = convertedResponse.response.usage.inputTokens;
      state.outputTokens = convertedResponse.response.usage.outputTokens;
      state.cacheReadInputTokens = convertedResponse.response.usage.cacheReadInputTokens;
      state.cacheCreationInputTokens = convertedResponse.response.usage.cacheCreationInputTokens;
      state.status = 200;
      state.activeStage = undefined;
      sendJson(res, 200, canonicalResponseToAnthropic(convertedResponse.response));
      return;
    }

    const converted = serializeOpenAIChatRequest(canonical, {
      model: selectedModel,
      compatibility: snapshot.config.compatibility
    });
    state.upstreamFields = Object.keys(converted.body).sort();
    annotateUpstreamRequestShape(state, converted.body);
    const upstream = await fetchUpstream(snapshot, converted.body, controller.signal, deps.fetchImpl, state);

    if (!upstream.ok) {
      const mapped = await mapUpstreamError(
        upstream,
        snapshot,
        deps.maxUpstreamErrorBytes ?? DEFAULT_MAX_UPSTREAM_ERROR_BYTES,
        state
      );
      state.status = mapped.status;
      setFailure(state, "upstream_http", "upstream_http_error", mapped.error, mapped.diagnostics);
      sendError(res, mapped.status, mapped.error);
      return;
    }

    if (canonical.stream) {
      const result = await pipeStreamingResponse(
        res,
        upstream,
        snapshot.config.protocol,
        converted.toolNames,
        selectedModel,
        controller.signal,
        state.startedAt,
        deps.now,
        (firstEventMs) => { state.firstEventMs ??= firstEventMs; }
      );
      state.inputTokens = result.usage.inputTokens;
      state.outputTokens = result.usage.outputTokens;
      state.cacheReadInputTokens = result.usage.cacheReadInputTokens;
      state.cacheCreationInputTokens = result.usage.cacheCreationInputTokens;
      state.firstEventMs = result.firstEventMs;
      if (result.error) {
        setFailure(state, "stream_protocol", result.error.code ?? "upstream_response_error", result.error);
      }
      state.status = result.error ? 502 : 200;
      return;
    }

    const parsed = await readUpstreamJson(
      upstream,
      deps.maxUpstreamResponseBytes ?? DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES
    );
    const response = parseOpenAIChatResponse(parsed, {
      toolNames: converted.toolNames,
      modelFallback: selectedModel
    });
    state.inputTokens = response.usage.inputTokens;
    state.outputTokens = response.usage.outputTokens;
    state.cacheReadInputTokens = response.usage.cacheReadInputTokens;
    state.cacheCreationInputTokens = response.usage.cacheCreationInputTokens;
    state.status = 200;
    state.activeStage = undefined;
    sendJson(res, 200, canonicalResponseToAnthropic(response));
  } catch (error) {
    if (state.clientDisconnected || error instanceof ClientDisconnectedError) {
      state.status = 499;
      setFailure(state, "client_disconnect", "client_disconnected", {
        type: "api_error",
        message: "Client disconnected."
      });
      return;
    }
    const mapped = mapGatewayFailure(error, state.timedOut);
    state.status = mapped.status;
    if (state.timedOut) {
      setFailure(state, "gateway_timeout", "gateway_timeout", mapped.error);
    } else if (!state.failureStage) {
      const code = error instanceof GatewayProtocolError
        ? error.error.code ?? (state.activeStage === "request_validation" ? "local_validation_error" : "upstream_response_error")
        : "gateway_internal_error";
      const stage = code === "gateway_internal_error" ? "gateway_internal" : state.activeStage ?? "gateway_internal";
      setFailure(state, stage, code, mapped.error);
    }
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
  state.activeStage = "upstream_connect";
  try {
    const response = await fetchImpl(snapshot.config.endpointUrl, {
      method: "POST",
      headers: {
        ...snapshot.config.requestHeaders,
        authorization: `Bearer ${snapshot.secret.apiKey}`,
        "content-type": "application/json",
        accept: body.stream === true ? "text/event-stream" : "application/json"
      },
      body: JSON.stringify(body),
      redirect: "manual",
      signal
    });
    state.upstreamStatus = response.status;
    state.upstreamRequestId = readUpstreamRequestId(response.headers);
    state.activeStage = response.ok ? "upstream_response" : "upstream_http";
    return response;
  } catch (error) {
    if (signal.aborted) {
      if (state.clientDisconnected) throw new ClientDisconnectedError();
      if (state.timedOut) {
        throw new GatewayProtocolError({ type: "api_error", message: "Upstream request timed out." }, 504, { cause: error });
      }
    }
    throw new GatewayProtocolError({
      type: "api_error",
      message: "Unable to connect to the upstream provider.",
      code: "upstream_connect_error"
    }, 502, { cause: error });
  }
}

async function pipeStreamingResponse(
  res: ServerResponse,
  upstream: Response,
  protocol: GatewayUpstreamProtocol,
  toolNames: ToolNameMapping,
  model: string,
  signal: AbortSignal,
  startedAt: number,
  now: () => number,
  onFirstEvent: (firstEventMs: number) => void,
  imageStore?: GeneratedImageStore
): Promise<GatewayStreamResult> {
  if (!upstream.body) {
    throw new GatewayProtocolError({ type: "api_error", message: "Upstream streaming response has no body." }, 502);
  }
  const bridge: AnthropicStreamBridge = protocol === "openai_responses"
    ? new OpenAIResponsesAnthropicStreamBridge({ model, toolNames, imageStore })
    : new OpenAIAnthropicStreamBridge({
        messageId: `msg_${randomUUID().replace(/-/g, "")}`,
        model,
        toolNames
      });
  let firstEventMs: number | undefined;
  const toResult = (): GatewayStreamResult => {
    const metadata = bridge.metadata;
    return {
      usage: bridge.usage,
      ...(firstEventMs === undefined ? {} : { firstEventMs }),
      ...(bridge.error ? { error: bridge.error } : {}),
      ...(metadata ? {
        upstreamEventTypes: metadata.upstreamEventTypes,
        upstreamItemTypes: metadata.upstreamItemTypes,
        ...(metadata.lastEventType ? { lastEventType: metadata.lastEventType } : {}),
        terminalEventReceived: metadata.terminalEventReceived
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
      if (firstEventMs === undefined) {
        firstEventMs = Math.max(0, now() - startedAt);
        onFirstEvent(firstEventMs);
      }
      const outputChunks = bridge.push(value);
      if (imageStore && bridge.takePreparedImages) {
        await persistGeneratedImages(imageStore, bridge.takePreparedImages());
      }
      for (const output of outputChunks) {
        await writeWithBackpressure(res, output, signal);
      }
      if (bridge.isTerminal) {
        await reader.cancel();
        res.end();
        return toResult();
      }
    }
    const outputChunks = bridge.finish();
    if (imageStore && bridge.takePreparedImages) {
      await persistGeneratedImages(imageStore, bridge.takePreparedImages());
    }
    for (const output of outputChunks) {
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

interface GatewayFailureDiagnostics {
  errorSummary?: string;
  validationField?: string;
  validationRule?: GatewayValidationRule;
  upstreamErrorCode?: string;
  upstreamErrorParam?: string;
}

async function mapUpstreamError(
  response: Response,
  snapshot: GatewayRouteSnapshot,
  maxBytes: number,
  state: RequestState
): Promise<{ status: number; error: GatewayError; diagnostics: GatewayFailureDiagnostics }> {
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
  const diagnostics = extractSafeUpstreamDiagnostics(parsed, response.status);

  if (isAnthropicErrorEnvelope(parsed) && response.status === 400) {
    return {
      status: response.status,
      error: {
        type: normalizeGatewayErrorType(parsed.error.type, mapUpstreamStatus(response.status).error.type),
        message
      },
      diagnostics
    };
  }
  const mapped = mapUpstreamStatus(response.status);
  return { status: mapped.status, error: { type: mapped.error.type, message }, diagnostics };
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

function extractSafeUpstreamDiagnostics(value: unknown, status: number): GatewayFailureDiagnostics {
  const error = isRecord(value) && isRecord(value.error) ? value.error : isRecord(value) ? value : undefined;
  return {
    errorSummary: safeFailureSummary("upstream_http", status),
    ...(safeDiagnosticToken(error?.code) ? { upstreamErrorCode: safeDiagnosticToken(error?.code) } : {}),
    ...(safeDiagnosticPath(error?.param) ? { upstreamErrorParam: safeDiagnosticPath(error?.param) } : {})
  };
}

function safeDiagnosticToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 128 && /^[A-Za-z0-9_.:/-]+$/.test(trimmed)
    ? trimmed
    : undefined;
}

function safeDiagnosticPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 256 && /^[A-Za-z0-9_.\[\]-]+$/.test(trimmed)
    ? trimmed
    : undefined;
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

function safeCorrelationId(value: string | string[] | undefined): string | undefined {
  const normalized = readHeader(value);
  return normalized && normalized.length <= 256 && /^[A-Za-z0-9_.:@/-]+$/.test(normalized)
    ? normalized
    : undefined;
}

async function persistGeneratedImages(
  store: GeneratedImageStore,
  images: PreparedGeneratedImage[]
): Promise<void> {
  try {
    for (const image of images) await store.persist(image);
  } catch (error) {
    throw new GatewayProtocolError({
      type: "api_error",
      message: "The gateway could not save the generated image.",
      code: "gateway_internal_error"
    }, 502, { cause: error });
  }
}

function readUpstreamRequestId(headers: Headers): string | undefined {
  for (const name of ["x-request-id", "request-id", "x-correlation-id", "cf-ray"]) {
    const value = headers.get(name)?.trim();
    if (value && value.length <= 256 && !/[\r\n\0]/.test(value)) return value;
  }
  return undefined;
}

function setFailure(
  state: RequestState,
  stage: GatewayFailureStage,
  code: GatewayFailureCode,
  error: GatewayError,
  diagnostics: GatewayFailureDiagnostics = {}
): void {
  state.failureStage = stage;
  state.failureCode = code;
  state.errorType = error.type;
  state.outcome = "failure";
  state.errorSummary = diagnostics.errorSummary ?? safeFailureSummary(stage, state.status);
  state.upstreamErrorCode = diagnostics.upstreamErrorCode;
  state.upstreamErrorParam = diagnostics.upstreamErrorParam;
  if (stage === "request_validation") {
    const validation = classifyValidationError(error.message);
    state.validationField = validation.field;
    state.validationRule = validation.rule;
  }
}

function safeFailureSummary(stage: GatewayFailureStage, status: number): string {
  switch (stage) {
    case "request_validation":
      return "The request failed local Anthropic-format validation.";
    case "upstream_connect":
      return "The gateway could not connect to the selected upstream.";
    case "upstream_http":
      return `The selected upstream rejected the converted request with HTTP ${status}.`;
    case "upstream_response":
      return "The upstream response could not be converted to Anthropic Messages format.";
    case "stream_protocol":
      return "The upstream stream contained invalid or unsupported protocol data.";
    case "stream_eof":
      return "The upstream stream ended without a terminal response event.";
    case "gateway_timeout":
      return "The upstream request exceeded the gateway timeout.";
    case "client_disconnect":
      return "The client disconnected before the gateway request completed.";
    case "gateway_internal":
      return "The gateway encountered an internal processing error.";
  }
}

function classifyValidationError(message: string): { field?: string; rule: GatewayValidationRule } {
  if (message === "Request body is not valid JSON.") return { rule: "invalid_json" };
  if (message === "Content-Type must be application/json.") return { rule: "invalid_content_type" };
  if (message.includes("exceeds the") && message.includes("byte limit")) return { rule: "size_limit" };

  const separator = message.indexOf(":");
  const rawField = separator > 0 ? message.slice(0, separator) : undefined;
  const field = normalizeValidationField(rawField);
  if (message.includes("Field required")) return { ...(field ? { field } : {}), rule: "required" };
  if (message.includes("Extra inputs are not permitted")) return { ...(field ? { field } : {}), rule: "extra_field" };
  if (message.includes("must appear before") || message.includes("cannot be represented")) {
    return { ...(field ? { field } : {}), rule: "invalid_order" };
  }
  if (message.includes("not supported") || message.includes("Unsupported")) {
    return { ...(field ? { field } : {}), rule: "unsupported_value" };
  }
  return { ...(field ? { field } : {}), rule: "invalid_type" };
}

function normalizeValidationField(value: string | undefined): string | undefined {
  if (!value || value.length > 256) return undefined;
  const segments = value.split(".");
  const normalized = segments.map((segment) => {
    const match = segment.match(/^([A-Za-z0-9_\[\]-]+)$/);
    if (match) return match[1];
    return "<unknown-field>";
  }).join(".");
  return safeDiagnosticPath(normalized.replaceAll("<unknown-field>", "unknown_field"))
    ? normalized
    : undefined;
}

function classifyResponsesStreamFailure(result: GatewayStreamResult): GatewayFailureStage {
  if (result.error?.code === "missing_terminal_event") return "stream_eof";
  if (result.terminalEventReceived) return "upstream_response";
  return "stream_protocol";
}

function annotateUpstreamRequestShape(state: RequestState, body: Record<string, unknown>): void {
  const tools = Array.isArray(body.tools) ? body.tools : undefined;
  if (tools) {
    state.upstreamToolCount = tools.length;
    const types = [...new Set(tools.map((tool) => isRecord(tool) ? safeDiagnosticToken(tool.type) : undefined)
      .filter((type): type is string => type !== undefined))];
    if (types.length > 0) state.upstreamToolTypes = types;
  }
  const input = body.input;
  if (Array.isArray(input)) state.upstreamInputItems = input.length;
  if (body.tool_choice !== undefined) state.upstreamHasToolChoice = true;
}

function emitRequestLog(
  deps: Pick<GatewayServerOptions, "onRequestComplete"> & { now: () => number },
  req: IncomingMessage,
  state: RequestState
): void {
  if (!deps.onRequestComplete) return;
  const sessionId = safeCorrelationId(req.headers["x-claude-code-session-id"]);
  const agentId = safeCorrelationId(req.headers["x-claude-code-agent-id"]);
  const parentAgentId = safeCorrelationId(req.headers["x-claude-code-parent-agent-id"]);
  const completedAt = deps.now();
  const outcome = state.outcome ?? (state.status >= 200 && state.status < 400 ? "success" : "failure");
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
      ...(state.requestKind ? { requestKind: state.requestKind } : {}),
      outcome,
      ...(state.errorSummary ? { errorSummary: state.errorSummary } : {}),
      ...(state.validationField ? { validationField: state.validationField } : {}),
      ...(state.validationRule ? { validationRule: state.validationRule } : {}),
      ...(state.upstreamErrorCode ? { upstreamErrorCode: state.upstreamErrorCode } : {}),
      ...(state.upstreamErrorParam ? { upstreamErrorParam: state.upstreamErrorParam } : {}),
      ...(state.upstreamFields ? { upstreamFields: [...state.upstreamFields] } : {}),
      ...(state.upstreamToolTypes ? { upstreamToolTypes: [...state.upstreamToolTypes] } : {}),
      ...(state.upstreamToolCount === undefined ? {} : { upstreamToolCount: state.upstreamToolCount }),
      ...(state.upstreamInputItems === undefined ? {} : { upstreamInputItems: state.upstreamInputItems }),
      ...(state.upstreamHasToolChoice === undefined ? {} : {
        upstreamHasToolChoice: state.upstreamHasToolChoice
      }),
      ...(state.upstreamEventTypes ? { upstreamEventTypes: [...state.upstreamEventTypes] } : {}),
      ...(state.upstreamItemTypes ? { upstreamItemTypes: [...state.upstreamItemTypes] } : {}),
      ...(state.inputTokens === undefined ? {} : { inputTokens: state.inputTokens }),
      ...(state.outputTokens === undefined ? {} : { outputTokens: state.outputTokens }),
      ...(state.cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens: state.cacheReadInputTokens }),
      ...(state.cacheCreationInputTokens === undefined
        ? {}
        : { cacheCreationInputTokens: state.cacheCreationInputTokens }),
      ...(state.failureStage ? { failureStage: state.failureStage } : {}),
      ...(state.failureCode ? { failureCode: state.failureCode } : {}),
      ...(state.errorType ? { errorType: state.errorType } : {}),
      ...(state.upstreamStatus === undefined ? {} : { upstreamStatus: state.upstreamStatus }),
      ...(state.upstreamRequestId ? { upstreamRequestId: state.upstreamRequestId } : {}),
      ...(state.firstEventMs === undefined ? {} : { firstEventMs: state.firstEventMs }),
      ...(state.lastEventType ? { lastEventType: state.lastEventType } : {}),
      ...(state.terminalEventReceived === undefined ? {} : {
        terminalEventReceived: state.terminalEventReceived
      }),
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

async function generatePeerAutoResponse(
  registry: RegistryLike,
  endpoint: string,
  msg: CollabMessage
): Promise<string | undefined> {
  try {
    const route = await registry.resolve(msg.to);
    if (!route) return undefined;

    const systemPrompt = `You are the AI coding agent '${msg.to}'. Another AI agent in the project, '@${msg.from}', is collaborating with you and sent you the following message:\n"${msg.content}"\n${msg.context ? `Context: ${msg.context}\n` : ""}${msg.expectedFormat ? `Expected format: ${msg.expectedFormat}\n` : ""}\nReply directly, professionally, and concisely to @${msg.from}.`;

    const requestBody = {
      model: route.models[0] || route.config.model,
      messages: [{ role: "user", content: systemPrompt }],
      max_tokens: 1024
    };

    const res = await fetch(`${endpoint}/p/${encodeURIComponent(msg.to)}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": route.secret.localToken,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(requestBody)
    });

    if (!res.ok) return undefined;
    const data = (await res.json()) as any;
    if (data.content && Array.isArray(data.content)) {
      const textBlock = data.content.find((c: any) => c.type === "text");
      return textBlock?.text;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
