import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, open as openFile, readFile, rm, stat, truncate } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { assertProfileName, CcpError } from "../core/errors.js";
import { getGatewayLogPath, getHomeWorkDir, getMainClaudeDir, type PathContext } from "../core/paths.js";
import {
  createApiProfile,
  createGatewayProfile,
  createLoginProfile,
  listProfiles,
  removeProfile,
  resolveConfigDir,
  summarizeProfile
} from "../core/profiles.js";
import { getGatewayStatus, restartGateway, startGateway, stopGateway } from "../core/gateway-lifecycle.js";
import { createApiProfileFromPreset, createGatewayProfileFromPreset, listProfilePresets } from "../core/presets.js";
import { updateGatewayProfile } from "../core/gateway-profile.js";
import {
  createGatewayUpstream,
  fetchGatewayModels,
  findGatewayUpstreamReferences,
  listGatewayUpstreams,
  removeGatewayUpstream,
  readGatewayUpstreamConfig,
  readGatewayUpstreamSecret,
  updateGatewayUpstream,
  validateGatewayProtocolCompatibility
} from "../core/gateway-upstreams.js";
import { listGatewayUpstreamTemplates } from "../core/gateway-upstream-templates.js";
import { readMeta, readSettings, writeMeta, writeSettings } from "../core/settings.js";
import { getPackageVersion } from "../core/version.js";
import { deleteSessionProject, deleteSessionProjectSession, listSessionProjects, scanSessionProject, syncSessionProject, type SyncProjectSessionSelection } from "../core/sessions.js";
import type {
  ClaudeSettings,
  GatewayCompatibility,
  GatewayProtocolCompatibility,
  GatewayProvider,
  GatewayResponsesCompatibility,
  GatewayUpstreamProtocol,
  GatewayUpstreamSummary,
  ProfileMeta,
  ProfileSummary
} from "../core/types.js";
import {
  CUSTOM_GATEWAY_COMPATIBILITY,
  CUSTOM_RESPONSES_COMPATIBILITY,
  MODERN_OPENAI_COMPATIBILITY,
  OPENAI_GATEWAY_COMPATIBILITY,
  OPENAI_RESPONSES_COMPATIBILITY,
  resolveGatewayBaseUrl,
  resolveGatewayChatCompletionsUrl
} from "../gateway/config.js";
import { sanitizeEndpointUrlForLog } from "../gateway/utils.js";

export interface UiServerOptions {
  host?: string;
  port?: number;
  open?: boolean;
}

interface ActivityEntry {
  id: number;
  time: string;
  type: "info" | "success" | "error";
  message: string;
}

interface WebProfile extends Omit<ProfileSummary, "type" | "tokenStatus"> {
  type: ProfileSummary["type"] | "main";
  tokenStatus: "set" | "missing";
  status: "ready" | "needs_attention" | "unknown";
  statusText: string;
  tags: string[];
  startCommand: string;
  settings?: Record<string, unknown>;
  gatewayUpstream?: GatewayUpstreamSummary;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7821;
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

let nextActivityId = 1;
const activity: ActivityEntry[] = [];

function addActivity(type: ActivityEntry["type"], message: string): void {
  activity.unshift({ id: nextActivityId++, time: new Date().toISOString(), type, message: redact(message) });
  if (activity.length > 100) activity.pop();
}

function redact(value: string): string {
  return value
    .replace(/(ANTHROPIC_AUTH_TOKEN\s*[=:]\s*)[^\s,}]+/gi, "$1[redacted]")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,}]+/gi, "$1[redacted]")
    .replace(/(api[_-]?key\s*[=:]\s*)[^\s,}]+/gi, "$1[redacted]")
    .replace(/data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=_-]+/gi, "data:image/[redacted]")
    .replace(/[A-Za-z0-9+/]{256,}={0,2}/g, "[redacted-base64]")
    .replace(/sk-[A-Za-z0-9._-]{8,}/g, "sk-****");
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(data));
}

function notFound(res: ServerResponse): void {
  json(res, 404, { error: "Not found" });
}

function methodNotAllowed(res: ServerResponse): void {
  json(res, 405, { error: "Method not allowed" });
}

async function readJsonBody<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}

function requireToken(req: IncomingMessage, token: string): void {
  if (req.headers["x-ccp-ui-token"] !== token) {
    throw new CcpError("Invalid UI token.");
  }
}

function publicSettings(settings?: ClaudeSettings): Record<string, unknown> | undefined {
  if (!settings) return undefined;
  const cloned = JSON.parse(JSON.stringify(settings)) as ClaudeSettings;
  if (cloned.env?.ANTHROPIC_AUTH_TOKEN) {
    cloned.env.ANTHROPIC_AUTH_TOKEN = maskToken(cloned.env.ANTHROPIC_AUTH_TOKEN);
  }
  return cloned as Record<string, unknown>;
}

export function publicProfileSettings(profile: ProfileSummary, settings?: ClaudeSettings): Record<string, unknown> | undefined {
  const publicValue = publicSettings(settings) as ClaudeSettings | undefined;
  if (profile.type === "gateway" && publicValue?.env?.ANTHROPIC_AUTH_TOKEN) {
    publicValue.env.ANTHROPIC_AUTH_TOKEN = "[managed by built-in gateway]";
  }
  return publicValue as Record<string, unknown> | undefined;
}

export function listWebProfilePresets() {
  return listProfilePresets();
}

export async function readWebProfileApiKey(name: string, context: PathContext = {}): Promise<string> {
  const config = await resolveConfigDir(name, { allowMain: false, context });
  const profile = await summarizeProfile(name, config.dir);
  if (profile.type !== "api") {
    throw new CcpError(`Profile '${name}' does not use an API Key.`);
  }
  const settings = await readSettings(config.dir);
  return settings?.env?.ANTHROPIC_AUTH_TOKEN ?? "";
}

export async function readWebGatewayUpstreamApiKey(id: string, context: PathContext = {}): Promise<string> {
  return (await readGatewayUpstreamSecret(id, context)).apiKey;
}

export function assertWebProfileWritable(profile: ProfileSummary): void {
  if (!(["api", "gateway"] as ProfileSummary["type"][]).includes(profile.type)) {
    throw new CcpError(`Profile type '${profile.type}' cannot be edited in the Web UI.`);
  }
}

export type WebGatewayCompatibilityMode = "openai" | "responses" | "modern" | "legacy" | "advanced";

export function resolveWebGatewayCompatibility(
  protocol: GatewayUpstreamProtocol,
  provider: GatewayProvider,
  mode: WebGatewayCompatibilityMode,
  advanced?: unknown
): GatewayProtocolCompatibility {
  if (protocol === "openai_responses") {
    let compatibility: Partial<GatewayResponsesCompatibility>;
    if (mode === "openai") {
      if (provider !== "openai") throw new CcpError("The OpenAI compatibility profile requires the OpenAI provider.");
      compatibility = OPENAI_RESPONSES_COMPATIBILITY;
    } else if (mode === "responses") {
      compatibility = CUSTOM_RESPONSES_COMPATIBILITY;
    } else if (mode === "advanced" && advanced && typeof advanced === "object" && !Array.isArray(advanced)) {
      compatibility = advanced as Partial<GatewayResponsesCompatibility>;
    } else if (mode === "modern" || mode === "legacy") {
      throw new CcpError("Chat compatibility profiles cannot be used with the Responses protocol.");
    } else {
      throw new CcpError("Advanced Responses compatibility settings are required.");
    }
    return validateGatewayProtocolCompatibility(protocol, provider, compatibility);
  }

  let compatibility: Partial<GatewayCompatibility>;
  if (mode === "openai") {
    if (provider !== "openai") throw new CcpError("The OpenAI compatibility profile requires the OpenAI provider.");
    compatibility = OPENAI_GATEWAY_COMPATIBILITY;
  } else if (mode === "modern") {
    compatibility = MODERN_OPENAI_COMPATIBILITY;
  } else if (mode === "legacy") {
    compatibility = CUSTOM_GATEWAY_COMPATIBILITY;
  } else if (mode === "advanced" && advanced && typeof advanced === "object" && !Array.isArray(advanced)) {
    compatibility = advanced as Partial<GatewayCompatibility>;
  } else if (mode === "responses") {
    throw new CcpError("The Responses compatibility profile requires the Responses protocol.");
  } else {
    throw new CcpError("Advanced Chat compatibility settings are required.");
  }
  return validateGatewayProtocolCompatibility(protocol, provider, compatibility);
}

function maskToken(token: string): string {
  if (!token || token === "REPLACE_WITH_FULL_TOKEN") return "missing";
  if (token.length <= 8) return "configured";
  return `${token.slice(0, 3)}****${token.slice(-4)}`;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function tagsForProfile(
  profile: ProfileSummary,
  isMain: boolean,
  gatewayRunning: boolean
): { status: WebProfile["status"]; statusText: string; tags: string[] } {
  const type = isMain ? "main" : profile.type;
  const tags: string[] = [];
  tags.push(type === "main" ? "Main" : type === "api" ? "API" : type === "login" ? "Login" : type === "gateway" ? "Gateway" : "Unknown");

  let status: WebProfile["status"] = "ready";
  let statusText = "Ready";
  if (profile.type === "api" && profile.tokenStatus === "missing") {
    status = "needs_attention";
    statusText = "Missing API Key";
  }
  if (profile.type === "api" && !profile.baseUrl) {
    status = "needs_attention";
    statusText = "Missing Base URL";
  }
  if (profile.type === "gateway" && profile.tokenStatus === "missing") {
    status = "needs_attention";
    statusText = "Missing Provider Key";
  } else if (profile.type === "gateway" && !gatewayRunning) {
    status = "needs_attention";
    statusText = "Gateway Offline";
  }
  if (profile.type === "unknown" && !isMain) {
    status = "unknown";
    statusText = "Unknown";
  }

  tags.push(status === "ready" ? "Ready" : statusText);
  if (profile.type === "api") {
    tags.push(profile.model ? "Custom Model" : "Default Model");
  } else if (profile.type === "login") {
    tags.push("Login Profile");
  } else if (profile.type === "gateway") {
    tags.push(profile.meta?.gateway?.upstreamId || "Unbound");
  } else if (isMain) {
    tags.push("Main Config");
  }
  return { status, statusText, tags };
}

async function toWebProfile(
  profile: ProfileSummary,
  isMain: boolean,
  includeSettings = false,
  gatewayRunning = false
): Promise<WebProfile> {
  const tagState = tagsForProfile(profile, isMain, gatewayRunning);
  const settings = includeSettings ? await readSettings(profile.dir) : undefined;
  let gatewayUpstream: GatewayUpstreamSummary | undefined;
  if (profile.type === "gateway" && profile.meta?.gateway?.upstreamId) {
    gatewayUpstream = (await listGatewayUpstreams()).find(
      (item) => item.id === profile.meta?.gateway?.upstreamId
    );
  }
  return {
    ...profile,
    type: isMain ? "main" : profile.type,
    ...tagState,
    startCommand: isMain ? "claude" : `ccp start ${profile.name}`,
    settings: publicProfileSettings(profile, settings),
    gatewayUpstream
  };
}

async function getAllProfiles(includeSettings = false): Promise<WebProfile[]> {
  const gateway = await getGatewayStatus();
  const profiles: WebProfile[] = [];
  const mainDir = getMainClaudeDir();
  if (existsSync(mainDir)) {
    const main = await summarizeProfile("main", mainDir);
    profiles.push(await toWebProfile(main, true, includeSettings, gateway.running));
  }
  for (const profile of await listProfiles()) {
    profiles.push(await toWebProfile(profile, false, includeSettings, gateway.running));
  }
  return profiles;
}

function gatewayWebStatus(status: Awaited<ReturnType<typeof getGatewayStatus>>, profilesUsingGateway?: number) {
  return { ...status, logPath: getGatewayLogPath(), profilesUsingGateway };
}

async function countGatewayProfiles(): Promise<number> {
  return (await listProfiles()).filter((profile) => profile.type === "gateway").length;
}

export interface WebGatewayLogEntry {
  kind: "request" | "system";
  requestId?: string;
  completedAt?: string;
  method?: string;
  pathname?: string;
  profileName?: string;
  clientModel?: string;
  model?: string;
  protocol?: string;
  endpointUrl?: string;
  stream?: boolean;
  effort?: string;
  effortMapping?: string;
  requestKind?: string;
  outcome?: string;
  errorSummary?: string;
  validationField?: string;
  validationRule?: string;
  failureStage?: string;
  failureCode?: string;
  errorType?: string;
  upstreamStatus?: number;
  upstreamRequestId?: string;
  upstreamErrorCode?: string;
  upstreamErrorParam?: string;
  firstEventMs?: number;
  lastEventType?: string;
  terminalEventReceived?: boolean;
  upstreamFields?: string[];
  upstreamEventTypes?: string[];
  upstreamItemTypes?: string[];
  sessionId?: string;
  agentId?: string;
  parentAgentId?: string;
  status?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  message?: string;
}

function safeWebLogIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 256 && /^[A-Za-z0-9_.:@/-]+$/.test(value)
    ? value
    : undefined;
}

function parseGatewayLogLine(line: string): WebGatewayLogEntry | undefined {
  const clean = redact(line.trim());
  if (!clean) return undefined;
  try {
    const value = JSON.parse(clean) as Record<string, unknown>;
    if (value.event === "gateway_request") {
      const strings = (name: string) => typeof value[name] === "string" ? value[name] as string : undefined;
      const numbers = (name: string) => typeof value[name] === "number" ? value[name] as number : undefined;
      const booleans = (name: string) => typeof value[name] === "boolean" ? value[name] as boolean : undefined;
      const stringArrays = (name: string) => Array.isArray(value[name]) && value[name].every((item) => typeof item === "string")
        ? value[name] as string[]
        : undefined;
      return {
        kind: "request",
        requestId: strings("requestId"),
        completedAt: strings("completedAt"),
        method: strings("method"),
        pathname: strings("pathname"),
        profileName: strings("profileName"),
        clientModel: strings("clientModel"),
        model: strings("model"),
        protocol: strings("protocol"),
        endpointUrl: typeof value.endpointUrl === "string" ? sanitizeEndpointUrlForLog(value.endpointUrl) : undefined,
        stream: booleans("stream"),
        effort: strings("effort"),
        effortMapping: strings("effortMapping"),
        requestKind: strings("requestKind"),
        outcome: strings("outcome"),
        errorSummary: strings("errorSummary"),
        validationField: strings("validationField"),
        validationRule: strings("validationRule"),
        failureStage: strings("failureStage"),
        failureCode: strings("failureCode"),
        errorType: strings("errorType"),
        upstreamStatus: numbers("upstreamStatus"),
        upstreamRequestId: strings("upstreamRequestId"),
        upstreamErrorCode: strings("upstreamErrorCode"),
        upstreamErrorParam: strings("upstreamErrorParam"),
        firstEventMs: numbers("firstEventMs"),
        lastEventType: strings("lastEventType"),
        terminalEventReceived: booleans("terminalEventReceived"),
        upstreamFields: stringArrays("upstreamFields"),
        upstreamEventTypes: stringArrays("upstreamEventTypes"),
        upstreamItemTypes: stringArrays("upstreamItemTypes"),
        sessionId: safeWebLogIdentifier(value.sessionId),
        agentId: safeWebLogIdentifier(value.agentId),
        parentAgentId: safeWebLogIdentifier(value.parentAgentId),
        status: numbers("status"),
        durationMs: numbers("durationMs"),
        inputTokens: numbers("inputTokens"),
        outputTokens: numbers("outputTokens")
      };
    }
  } catch {
    // Startup and fatal process messages are plain text rather than JSON request entries.
  }
  return { kind: "system", message: clean };
}

export async function readGatewayLogTail(
  context: PathContext = {},
  limit = 120
): Promise<{ path: string; entries: WebGatewayLogEntry[]; updatedAt?: string }> {
  const logPath = getGatewayLogPath(context);
  try {
    const fileStat = await stat(logPath);
    const readLength = Math.min(fileStat.size, 256 * 1024);
    const offset = Math.max(0, fileStat.size - readLength);
    const buffer = Buffer.alloc(readLength);
    const handle = await openFile(logPath, "r");
    try {
      await handle.read(buffer, 0, readLength, offset);
    } finally {
      await handle.close();
    }
    const lines = buffer.toString("utf8").split(/\r?\n/);
    if (offset > 0) lines.shift();
    const entries = lines
      .map(parseGatewayLogLine)
      .filter((entry): entry is WebGatewayLogEntry => Boolean(entry))
      .slice(-Math.max(1, Math.min(limit, 300)))
      .reverse();
    return { path: logPath, entries, updatedAt: fileStat.mtime.toISOString() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: logPath, entries: [] };
    throw error;
  }
}

async function clearGatewayLogs(): Promise<void> {
  const logPath = getGatewayLogPath();
  await truncate(logPath, 0).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
  await rm(`${logPath}.1`, { force: true });
}

function dashboardFromProfiles(
  profiles: WebProfile[],
  gateway: Awaited<ReturnType<typeof getGatewayStatus>>
) {
  const count = (type: WebProfile["type"]) => profiles.filter((profile) => profile.type === type).length;
  return {
    profiles: {
      total: profiles.length,
      main: count("main"),
      api: count("api"),
      login: count("login"),
      gateway: count("gateway"),
      needsAttention: profiles.filter((profile) => profile.status !== "ready").length
    },
    gateway: gatewayWebStatus(gateway, profiles.filter((profile) => profile.type === "gateway").length),
    activity: activity.slice(0, 8)
  };
}

async function updateApiSettings(name: string, body: Record<string, unknown>): Promise<WebProfile> {
  const config = await resolveConfigDir(name, { allowMain: false });
  const settings = (await readSettings(config.dir)) ?? { theme: "dark" };
  settings.env ??= {};

  const baseUrl = String(body.baseUrl ?? "").trim();
  const token = String(body.token ?? "");
  const model = String(body.model ?? "").trim();
  const opusModel = String(body.opusModel ?? "").trim();
  const sonnetModel = String(body.sonnetModel ?? "").trim();
  const haikuModel = String(body.haikuModel ?? "").trim();
  const subagentModel = String(body.subagentModel ?? "").trim();

  if (baseUrl) settings.env.ANTHROPIC_BASE_URL = baseUrl;
  if (token.trim()) settings.env.ANTHROPIC_AUTH_TOKEN = token.trim();

  setOptionalEnv(settings, "ANTHROPIC_MODEL", model);
  setOptionalEnv(settings, "ANTHROPIC_DEFAULT_OPUS_MODEL", opusModel || model);
  setOptionalEnv(settings, "ANTHROPIC_DEFAULT_SONNET_MODEL", sonnetModel || model);
  setOptionalEnv(settings, "ANTHROPIC_DEFAULT_HAIKU_MODEL", haikuModel || model);
  setOptionalEnv(settings, "CLAUDE_CODE_SUBAGENT_MODEL", subagentModel);

  await writeSettings(config.dir, settings);
  const summarized = await summarizeProfile(name, config.dir);
  const gateway = await getGatewayStatus();
  addActivity("success", `Updated profile '${name}'.`);
  return toWebProfile(summarized, false, true, gateway.running);
}

function setOptionalEnv(settings: ClaudeSettings, key: string, value: string): void {
  settings.env ??= {};
  if (value) settings.env[key] = value;
  else delete settings.env[key];
}

function gatewayProvider(value: unknown): GatewayProvider {
  if (value === "openai" || value === "openai-compatible") return value;
  throw new CcpError("Gateway provider must be openai or openai-compatible.");
}

function gatewayProtocol(value: unknown): GatewayUpstreamProtocol {
  if (value === "openai_chat_completions" || value === "openai_responses") return value;
  throw new CcpError("Gateway protocol must be openai_responses or openai_chat_completions.");
}

function gatewayCompatibilityMode(
  value: unknown,
  protocol: GatewayUpstreamProtocol,
  provider: GatewayProvider
): WebGatewayCompatibilityMode {
  const fallback = provider === "openai" ? "openai" : protocol === "openai_responses" ? "responses" : "modern";
  const mode = String(value ?? fallback) as WebGatewayCompatibilityMode;
  if (["openai", "responses", "modern", "legacy", "advanced"].includes(mode)) return mode;
  throw new CcpError("Unknown gateway compatibility profile.");
}

function gatewayRequestProtocol(body: Record<string, unknown>): GatewayUpstreamProtocol {
  if (body.protocol !== undefined) return gatewayProtocol(body.protocol);
  return "openai_chat_completions";
}

function gatewayRequestEndpoint(
  body: Record<string, unknown>,
  protocol: GatewayUpstreamProtocol,
  provider: GatewayProvider
): string {
  const endpointUrl = body.endpointUrl === undefined ? undefined : String(body.endpointUrl);
  const legacyUrl = body.chatCompletionsUrl === undefined ? undefined : String(body.chatCompletionsUrl);
  if (protocol === "openai_responses") {
    if (legacyUrl !== undefined) {
      throw new CcpError("chatCompletionsUrl cannot be used with the Responses protocol. Send endpointUrl instead.");
    }
    return endpointUrl ?? "";
  }
  if (endpointUrl !== undefined) return endpointUrl;
  return legacyUrl === undefined ? "" : resolveGatewayChatCompletionsUrl(provider, legacyUrl);
}

function gatewayModels(value: unknown): string[] {
  const source = Array.isArray(value) ? value : String(value ?? "").split(/[\s,]+/);
  return [...new Set(source.map((model) => String(model).trim()).filter(Boolean))];
}

function gatewayRequestHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CcpError("Gateway request headers must be an object.");
  }
  return value as Record<string, string>;
}

function gatewayRequestUrl(
  body: Record<string, unknown>,
  protocol: GatewayUpstreamProtocol,
  provider: GatewayProvider
): string {
  const baseUrl = body.baseUrl === undefined ? undefined : String(body.baseUrl);
  const endpointUrl = body.endpointUrl === undefined ? undefined : String(body.endpointUrl);
  if (baseUrl !== undefined && endpointUrl !== undefined) {
    throw new CcpError("Send either baseUrl or endpointUrl, not both.");
  }
  if (baseUrl !== undefined) return resolveGatewayBaseUrl(protocol, provider, baseUrl);
  return gatewayRequestEndpoint(body, protocol, provider);
}

async function webGatewayUpstreams(): Promise<Array<GatewayUpstreamSummary & { profileNames: string[] }>> {
  const upstreams = await listGatewayUpstreams();
  return Promise.all(upstreams.map(async (upstream) => ({
    ...upstream,
    ...(upstream.protocol === "openai_chat_completions" ? { chatCompletionsUrl: upstream.endpointUrl } : {}),
    profileNames: await findGatewayUpstreamReferences(upstream.id)
  })));
}

async function updateGatewaySettings(name: string, body: Record<string, unknown>): Promise<WebProfile> {
  const configDir = await resolveConfigDir(name, { allowMain: false });
  await updateGatewayProfile(configDir.dir, name, {
    upstreamId: String(body.upstreamId ?? ""),
    model: String(body.model ?? "")
  });
  const summarized = await summarizeProfile(name, configDir.dir);
  const gateway = await getGatewayStatus();
  addActivity("success", `Updated gateway profile '${name}'.`);
  return toWebProfile(summarized, false, true, gateway.running);
}

function assetRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const distAssets = path.join(here, "assets");
  if (existsSync(distAssets)) return distAssets;
  return path.resolve(here, "../../src/web/assets");
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}

async function serveStatic(res: ServerResponse, pathname: string, token: string): Promise<void> {
  const root = assetRoot();
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const resolved = path.resolve(root, `.${safePath}`);
  if (!resolved.startsWith(path.resolve(root))) return notFound(res);

  try {
    let data: string | Buffer = await readFile(resolved);
    if (resolved.endsWith("index.html")) {
      data = data.toString("utf8")
        .replace("__CCP_UI_TOKEN__", token)
        .replace("__CCP_VERSION__", getPackageVersion());
    }
    res.writeHead(200, { "content-type": contentType(resolved) });
    res.end(data);
  } catch {
    notFound(res);
  }
}

function openBrowser(url: string): void {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function terminalCommandForProfile(name: string): string {
  return name.toLowerCase() === "main" ? "claude" : `ccp start ${name}`;
}

function spawnDetached(command: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function spawnFirstAvailable(commands: { command: string; args: string[] }[], cwd?: string): Promise<void> {
  let lastError: unknown;
  for (const candidate of commands) {
    try {
      await spawnDetached(candidate.command, candidate.args, cwd);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  const reason = lastError instanceof Error ? ` ${lastError.message}` : "";
  throw new CcpError(`Failed to open terminal.${reason}`);
}

function ensureLocalhostActionAllowed(host: string): void {
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new CcpError("This local system action is only available when ccp ui is bound to localhost.");
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function openTerminal(commandLine: string, cwd: string): Promise<void> {
  if (process.platform === "win32") {
    await spawnDetached("cmd.exe", ["/d", "/c", "start", "", "/D", cwd, "cmd.exe", "/k", commandLine], cwd);
    return;
  }

  const commandInCwd = `cd ${shellQuote(cwd)} && ${commandLine}`;

  if (process.platform === "darwin") {
    const script = `tell application "Terminal" to do script ${JSON.stringify(commandInCwd)}`;
    await spawnDetached("osascript", ["-e", script], cwd);
    return;
  }

  await spawnFirstAvailable([
    { command: "x-terminal-emulator", args: ["-e", "sh", "-lc", commandInCwd] },
    { command: "gnome-terminal", args: ["--", "sh", "-lc", commandInCwd] },
    { command: "konsole", args: ["-e", "sh", "-lc", commandInCwd] },
    { command: "xfce4-terminal", args: ["-e", `sh -lc ${JSON.stringify(commandInCwd)}`] },
    { command: "xterm", args: ["-e", "sh", "-lc", commandInCwd] }
  ], cwd);
}

async function revealPathInFileManager(filePath: string): Promise<void> {
  if (process.platform === "win32") {
    await spawnDetached("explorer.exe", [`/select,${filePath}`]);
    return;
  }

  if (process.platform === "darwin") {
    await spawnDetached("open", ["-R", filePath]);
    return;
  }

  try {
    await spawnDetached("dbus-send", [
      "--session",
      "--dest=org.freedesktop.FileManager1",
      "--type=method_call",
      "/org/freedesktop/FileManager1",
      "org.freedesktop.FileManager1.ShowItems",
      `array:string:${pathToFileURL(filePath).href}`,
      "string:"
    ]);
  } catch {
    await spawnDetached("xdg-open", [path.dirname(filePath)]);
  }
}

async function revealProfileSettings(name: string, host: string): Promise<string> {
  ensureLocalhostActionAllowed(host);
  if (name.toLowerCase() !== "main") assertProfileName(name);
  const config = await resolveConfigDir(name, { allowMain: true });
  const profile = await summarizeProfile(config.name, config.dir);
  await revealPathInFileManager(profile.settingsPath);
  addActivity("success", `Opened settings path for '${config.name}'.`);
  return profile.settingsPath;
}

async function launchProfileTerminal(name: string, host: string): Promise<string> {
  ensureLocalhostActionAllowed(host);
  if (name.toLowerCase() !== "main") assertProfileName(name);
  const config = await resolveConfigDir(name, { allowMain: true });
  const cwd = getHomeWorkDir();
  await mkdir(cwd, { recursive: true });
  const commandLine = terminalCommandForProfile(config.name);
  await openTerminal(commandLine, cwd);
  addActivity("success", `Opened terminal for '${config.name}'.`);
  return commandLine;
}

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string, token: string, host: string): Promise<void> {
  try {
    if (req.method !== "GET") requireToken(req, token);

    if (pathname === "/api/presets") {
      if (req.method !== "GET") return methodNotAllowed(res);
      return json(res, 200, {
        presets: listWebProfilePresets()
      });
    }

    if (pathname === "/api/profiles/preset") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJsonBody<Record<string, string>>(req);
      const presetId = body.presetId ?? "";
      let created: ProfileSummary;
      if (body.kind === "api") {
        created = await createApiProfileFromPreset({ presetId, name: body.name, token: body.token ?? "" });
      } else if (body.kind === "gateway") {
        created = await createGatewayProfileFromPreset({
          presetId,
          name: body.name,
          upstreamId: body.upstreamId ?? "",
          model: body.model ?? ""
        });
      } else {
        throw new CcpError("This preset type is not available in the Web UI. Use the ccp CLI.");
      }
      addActivity("success", `Created profile '${created.name}' from preset '${presetId}'.`);
      return json(res, 201, { profile: await toWebProfile(created, false, true, (await getGatewayStatus()).running) });
    }

    if (pathname === "/api/dashboard") {
      if (req.method !== "GET") return methodNotAllowed(res);
      const profiles = await getAllProfiles();
      const gateway = await getGatewayStatus();
      return json(res, 200, dashboardFromProfiles(profiles, gateway));
    }

    if (pathname === "/api/profiles") {
      if (req.method !== "GET") return methodNotAllowed(res);
      return json(res, 200, { profiles: await getAllProfiles() });
    }

    if (pathname === "/api/activity") {
      if (req.method !== "GET") return methodNotAllowed(res);
      return json(res, 200, { activity });
    }

    if (pathname === "/api/sessions/projects") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJsonBody<Record<string, string>>(req);
      return json(res, 200, await listSessionProjects({
        sourceName: body.sourceName ?? "",
        targetName: body.targetName ?? ""
      }));
    }

    if (pathname === "/api/sessions/scan") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJsonBody<Record<string, string>>(req);
      return json(res, 200, await scanSessionProject({
        sourceName: body.sourceName ?? "",
        targetName: body.targetName ?? "",
        projectKey: body.projectKey ?? ""
      }));
    }

    if (pathname === "/api/sessions/sync") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJsonBody<{ sourceName?: string; targetName?: string; projectKey?: string; selections?: SyncProjectSessionSelection[] }>(req);
      const result = await syncSessionProject({
        sourceName: body.sourceName ?? "",
        targetName: body.targetName ?? "",
        projectKey: body.projectKey ?? "",
        selections: Array.isArray(body.selections) ? body.selections : []
      });
      addActivity("success", `Synced sessions ${result.sourceName} -> ${result.targetName} for ${result.projectKey}.`);
      return json(res, 200, result);
    }

    if (pathname === "/api/sessions/project/delete") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJsonBody<{ profileName?: string; sourceName?: string; projectKey?: string }>(req);
      const result = await deleteSessionProject({
        sourceName: body.profileName ?? body.sourceName ?? "",
        projectKey: body.projectKey ?? ""
      });
      addActivity("success", `Deleted session project ${result.sourceName}:${result.projectKey}.`);
      return json(res, 200, result);
    }

    if (pathname === "/api/sessions/session/delete") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJsonBody<{ sourceName?: string; projectKey?: string; sessionName?: string }>(req);
      const result = await deleteSessionProjectSession({
        sourceName: body.sourceName ?? "",
        projectKey: body.projectKey ?? "",
        sessionName: body.sessionName ?? ""
      });
      addActivity("success", `Deleted source session ${result.sourceName}:${result.projectKey}/${result.sessionName}.`);
      return json(res, 200, result);
    }

    if (pathname === "/api/gateway/status") {
      if (req.method !== "GET") return methodNotAllowed(res);
      const [status, profileCount] = await Promise.all([getGatewayStatus(), countGatewayProfiles()]);
      return json(res, 200, gatewayWebStatus(status, profileCount));
    }

    if (pathname === "/api/gateway/start") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const status = await startGateway();
      addActivity("success", "Built-in gateway started.");
      return json(res, 200, gatewayWebStatus(status, await countGatewayProfiles()));
    }

    if (pathname === "/api/gateway/restart") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const status = await restartGateway();
      addActivity("success", "Built-in gateway restarted.");
      return json(res, 200, gatewayWebStatus(status, await countGatewayProfiles()));
    }

    if (pathname === "/api/gateway/stop") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const status = await stopGateway();
      addActivity("success", "Built-in gateway stopped.");
      return json(res, 200, gatewayWebStatus(status, await countGatewayProfiles()));
    }

    if (pathname === "/api/gateway/log") {
      if (req.method !== "GET") return methodNotAllowed(res);
      requireToken(req, token);
      return json(res, 200, await readGatewayLogTail());
    }

    if (pathname === "/api/gateway/log/clear") {
      if (req.method !== "POST") return methodNotAllowed(res);
      await clearGatewayLogs();
      addActivity("success", "Gateway logs cleared.");
      return json(res, 200, await readGatewayLogTail());
    }

    if (pathname === "/api/collab/mesh") {
      if (req.method !== "GET") return methodNotAllowed(res);
      const [peersRes, blackboardRes, supervisorRes, dispatchesRes] = await Promise.all([
        fetch("http://127.0.0.1:3921/api/collab/peers")
          .then(async (response) => response.ok
            ? { online: true, data: await response.json() as Record<string, unknown> }
            : { online: false, data: { peers: [] } })
          .catch(() => ({ online: false, data: { peers: [] } })),
        fetch("http://127.0.0.1:3921/api/collab/blackboard")
          .then((response) => response.ok ? response.json() : { blackboard: [] })
          .catch(() => ({ blackboard: [] })),
        fetch("http://127.0.0.1:3921/api/collab/supervisor/messages?limit=100")
          .then((response) => response.ok ? response.json() : { messages: [], unread: 0 })
          .catch(() => ({ messages: [], unread: 0 })),
        fetch("http://127.0.0.1:3921/api/collab/dispatches?limit=100")
          .then((response) => response.ok ? response.json() : { dispatches: [], summary: {} })
          .catch(() => ({ dispatches: [], summary: {} }))
      ]);
      return json(res, 200, {
        ok: true,
        gatewayOnline: peersRes.online,
        peers: (peersRes.data as any).peers ?? [],
        blackboard: (blackboardRes as any).blackboard ?? [],
        dispatches: (dispatchesRes as any).dispatches ?? [],
        dispatchSummary: (dispatchesRes as any).summary ?? {},
        supervisorMessages: (supervisorRes as any).messages ?? [],
        supervisorUnread: (supervisorRes as any).unread ?? 0
      });
    }

    if (pathname === "/api/collab/send") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJsonBody<Record<string, unknown>>(req);
      const from = body.from ? String(body.from).trim() : "web-ui";
      const target = body.to ? String(body.to).trim() : undefined;
      const targetPeerId = body.peerId ? String(body.peerId).trim() : undefined;
      const sourcePeerId = body.sourcePeerId ? String(body.sourcePeerId).trim() : undefined;
      const message = body.message ? String(body.message).trim() : undefined;
      if (!target || !message) {
        return json(res, 400, { ok: false, error: "Missing 'to' or 'message'." });
      }
      try {
        const senderProfile = (from && from !== "__hub__" && from !== "web-ui") ? from : "web-ui";
        const isRelay = senderProfile !== "web-ui";
        const dispatchRes = await fetch("http://127.0.0.1:3921/api/collab/supervisor/dispatch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: isRelay ? "relay" : body.isAsk === true ? "ask" : "task",
            to: isRelay ? senderProfile : target,
            peerId: isRelay ? sourcePeerId : targetPeerId,
            relayTo: isRelay ? target : undefined,
            relayPeerId: isRelay ? targetPeerId : undefined,
            message,
            reportBack: body.reportBack === true || (!isRelay && body.reportBack !== false)
          })
        });
        const dispatchJson = await dispatchRes.json() as Record<string, unknown>;
        if (!dispatchRes.ok) {
          const gatewayError = String((dispatchJson as any).error?.message ?? dispatchJson.error ?? "Gateway rejected the supervisor dispatch.");
          return json(res, dispatchRes.status, { ok: false, error: gatewayError });
        }

        addActivity("info", isRelay
          ? `Supervisor instructed @${senderProfile} to coordinate with @${target}.`
          : `Supervisor dispatched work to @${target}.`);
        return json(res, 200, { ok: true, result: dispatchJson });
      } catch (error) {
        return json(res, 502, {
          ok: false,
          error: error instanceof Error ? error.message : "Failed to dispatch message to Gateway."
        });
      }
    }

    if (pathname === "/api/collab/blackboard") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJsonBody<Record<string, unknown>>(req);
      const key = typeof body.key === "string" ? body.key.trim() : "";
      if (!key || typeof body.value !== "string") {
        return json(res, 400, {
          ok: false,
          error: "Blackboard writes require a non-empty string 'key' field and a string 'value'."
        });
      }
      try {
        const gatewayRes = await fetch("http://127.0.0.1:3921/api/collab/blackboard", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key, value: body.value })
        });
        const gatewayJson = await gatewayRes.json() as Record<string, unknown>;
        if (!gatewayRes.ok) {
          const gatewayError = String((gatewayJson as any).error?.message ?? gatewayJson.error ?? "Gateway rejected the blackboard write.");
          return json(res, gatewayRes.status, { ok: false, error: gatewayError });
        }
        addActivity("info", `Supervisor updated shared blackboard '${key}'.`);
        return json(res, gatewayRes.status, gatewayJson);
      } catch (error) {
        return json(res, 502, {
          ok: false,
          error: error instanceof Error ? error.message : "Failed to update the Gateway blackboard."
        });
      }
    }

    if (pathname === "/api/collab/supervisor/read") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJsonBody<Record<string, unknown>>(req);
      try {
        const gatewayRes = await fetch("http://127.0.0.1:3921/api/collab/supervisor/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ids: Array.isArray(body.ids) ? body.ids.map(String) : undefined,
            all: body.all === true
          })
        });
        const result = await gatewayRes.json();
        return json(res, gatewayRes.ok ? 200 : gatewayRes.status, result);
      } catch {
        return json(res, 502, { ok: false, error: "Failed to update supervisor inbox." });
      }
    }

    if (pathname === "/api/gateway/upstreams") {
      if (req.method === "GET") return json(res, 200, { upstreams: await webGatewayUpstreams() });
      if (req.method === "POST") {
        const body = await readJsonBody<Record<string, unknown>>(req);
        const provider = gatewayProvider(body.provider);
        const protocol = gatewayRequestProtocol(body);
        const mode = gatewayCompatibilityMode(body.compatibilityMode, protocol, provider);
        const created = await createGatewayUpstream({
          id: String(body.id ?? ""),
          provider,
          protocol,
          endpointUrl: gatewayRequestUrl(body, protocol, provider),
          apiKey: String(body.apiKey ?? ""),
          models: gatewayModels(body.models),
          compatibility: resolveWebGatewayCompatibility(protocol, provider, mode, body.compatibility),
          requestHeaders: gatewayRequestHeaders(body.requestHeaders)
        });
        addActivity("success", `Created gateway upstream '${created.id}'.`);
        return json(res, 201, { upstream: { ...created, profileNames: [] } });
      }
      return methodNotAllowed(res);
    }

    if (pathname === "/api/gateway/upstreams/models") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJsonBody<Record<string, unknown>>(req);
      const provider = gatewayProvider(body.provider);
      const protocol = gatewayRequestProtocol(body);
      const endpointUrl = gatewayRequestUrl(body, protocol, provider);
      const result = await fetchGatewayModels({
        provider,
        protocol,
        endpointUrl,
        apiKey: String(body.apiKey ?? ""),
        requestHeaders: gatewayRequestHeaders(body.requestHeaders)
      });
      return json(res, 200, result);
    }

    if (pathname === "/api/gateway/upstream-templates") {
      if (req.method !== "GET") return methodNotAllowed(res);
      return json(res, 200, { templates: listGatewayUpstreamTemplates() });
    }

    const upstreamApiKeyMatch = pathname.match(/^\/api\/gateway\/upstreams\/([^/]+)\/api-key$/);
    if (upstreamApiKeyMatch) {
      if (req.method !== "POST") return methodNotAllowed(res);
      const id = decodeURIComponent(upstreamApiKeyMatch[1]);
      return json(res, 200, { apiKey: await readWebGatewayUpstreamApiKey(id) });
    }

    const upstreamMatch = pathname.match(/^\/api\/gateway\/upstreams\/([^/]+)$/);
    if (upstreamMatch) {
      const id = decodeURIComponent(upstreamMatch[1]);
      if (req.method === "GET") {
        const upstream = await readGatewayUpstreamConfig(id);
        return json(res, 200, {
          upstream: {
            ...upstream,
            ...(upstream.protocol === "openai_chat_completions" ? { chatCompletionsUrl: upstream.endpointUrl } : {}),
            apiKeyStatus: "set",
            profileNames: await findGatewayUpstreamReferences(id)
          }
        });
      }
      if (req.method === "PUT") {
        const body = await readJsonBody<Record<string, unknown>>(req);
        const provider = gatewayProvider(body.provider);
        const protocol = gatewayRequestProtocol(body);
        const mode = gatewayCompatibilityMode(body.compatibilityMode, protocol, provider);
        const updated = await updateGatewayUpstream(id, {
          id: String(body.id ?? id),
          provider,
          protocol,
          endpointUrl: gatewayRequestUrl(body, protocol, provider),
          apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
          models: gatewayModels(body.models),
          compatibility: resolveWebGatewayCompatibility(protocol, provider, mode, body.compatibility),
          requestHeaders: gatewayRequestHeaders(body.requestHeaders)
        });
        addActivity("success", `Updated gateway upstream '${id}'${updated.id === id ? "" : ` as '${updated.id}'`}.`);
        return json(res, 200, {
          upstream: {
            ...updated,
            profileNames: await findGatewayUpstreamReferences(updated.id)
          }
        });
      }
      if (req.method === "DELETE") {
        const body = await readJsonBody<Record<string, string>>(req);
        if (body.confirmId !== id) throw new CcpError("Upstream ID confirmation does not match.");
        await removeGatewayUpstream(id);
        addActivity("success", `Deleted gateway upstream '${id}'.`);
        return json(res, 200, { removed: id });
      }
      return methodNotAllowed(res);
    }

    if (pathname === "/api/profiles/api" && req.method === "POST") {
      const body = await readJsonBody<Record<string, string>>(req);
      const created = await createApiProfile({ name: body.name ?? "", baseUrl: body.baseUrl ?? "", token: body.token ?? "", model: body.model ?? "" });
      addActivity("success", `Created API profile '${created.name}'.`);
      return json(res, 201, { profile: await toWebProfile(created, false, true, (await getGatewayStatus()).running) });
    }

    if (pathname === "/api/profiles/login" && req.method === "POST") {
      const body = await readJsonBody<Record<string, string>>(req);
      const created = await createLoginProfile({ name: body.name ?? "" });
      addActivity("success", `Created login profile '${created.name}'.`);
      return json(res, 201, { profile: await toWebProfile(created, false, true, (await getGatewayStatus()).running) });
    }

    if (pathname === "/api/profiles/gateway" && req.method === "POST") {
      const body = await readJsonBody<Record<string, unknown>>(req);
      const created = await createGatewayProfile({
        name: String(body.name ?? ""),
        upstreamId: String(body.upstreamId ?? ""),
        model: String(body.model ?? ""),
        preset: typeof body.presetId === "string" ? body.presetId : "gateway"
      });
      addActivity("success", `Created gateway profile '${created.name}'.`);
      const gateway = await getGatewayStatus();
      return json(res, 201, { profile: await toWebProfile(created, false, true, gateway.running) });
    }

    const revealSettingsMatch = pathname.match(/^\/api\/profiles\/([^/]+)\/reveal-settings$/);
    if (revealSettingsMatch) {
      if (req.method !== "POST") return methodNotAllowed(res);
      const name = decodeURIComponent(revealSettingsMatch[1]);
      const settingsPath = await revealProfileSettings(name, host);
      return json(res, 200, { path: settingsPath });
    }

    const profileApiKeyMatch = pathname.match(/^\/api\/profiles\/([^/]+)\/api-key$/);
    if (profileApiKeyMatch) {
      if (req.method !== "POST") return methodNotAllowed(res);
      const name = decodeURIComponent(profileApiKeyMatch[1]);
      return json(res, 200, { apiKey: await readWebProfileApiKey(name) });
    }

    const terminalMatch = pathname.match(/^\/api\/profiles\/([^/]+)\/terminal$/);
    if (terminalMatch) {
      if (req.method !== "POST") return methodNotAllowed(res);
      const name = decodeURIComponent(terminalMatch[1]);
      const command = await launchProfileTerminal(name, host);
      return json(res, 200, { command });
    }

    const profileMatch = pathname.match(/^\/api\/profiles\/([^/]+)$/);
    if (profileMatch) {
      const name = decodeURIComponent(profileMatch[1]);
      if (req.method === "GET") {
        const config = await resolveConfigDir(name, { allowMain: true });
        const profile = await summarizeProfile(config.name, config.dir);
        const gateway = await getGatewayStatus();
        return json(res, 200, {
          profile: await toWebProfile(profile, config.isMain, true, gateway.running)
        });
      }
      if (req.method === "PUT") {
        const current = await summarizeProfile(name, (await resolveConfigDir(name, { allowMain: false })).dir);
        assertWebProfileWritable(current);
        const body = await readJsonBody<Record<string, unknown>>(req);
        const kind = String(body.kind ?? "api");
        const profile = kind === "gateway"
          ? await updateGatewaySettings(name, body)
          : await updateApiSettings(name, body);
        return json(res, 200, { profile });
      }
      if (req.method === "DELETE") {
        const body = await readJsonBody<Record<string, string>>(req);
        if (body.confirmName !== name) throw new CcpError("Profile name confirmation does not match.");
        const removed = await removeProfile(name);
        addActivity("success", `Deleted profile '${name}' at ${removed}.`);
        return json(res, 200, { removed });
      }
      return methodNotAllowed(res);
    }

    notFound(res);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addActivity("error", message);
    json(res, error instanceof CcpError ? 400 : 500, { error: redact(message) });
  }
}

export async function startUiServer(options: UiServerOptions = {}): Promise<void> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const token = randomBytes(24).toString("hex");
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname, token, host);
      return;
    }
    await serveStatic(res, url.pathname, token);
  });

  const url = `http://${host}:${port}/`;

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve());
    });
  } catch (error) {
    server.close();
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.log(`ccp ui is already running at ${url}`);
      if (options.open !== false) openBrowser(url);
      return;
    }
    throw error;
  }

  addActivity("info", `UI started at ${url}`);
  console.log(`ccp ui running at ${url}`);
  console.log("Press Ctrl+C to stop.");
  if (host !== DEFAULT_HOST) {
    console.log("Warning: ccp ui is not bound to 127.0.0.1. Use only on trusted networks.");
  }
  if (options.open) openBrowser(url);
}
