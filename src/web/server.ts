import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { CcpError } from "../core/errors.js";
import { getMainClaudeDir } from "../core/paths.js";
import {
  createApiProfile,
  createCcrProfile,
  createLoginProfile,
  listProfiles,
  removeProfile,
  resolveConfigDir,
  summarizeProfile
} from "../core/profiles.js";
import { getCcrRouteChoices, getCcrStatus, readCcrConfig, restartCcrService, startCcrService, stopCcrService } from "../core/ccr.js";
import { readMeta, readSettings, writeMeta, writeSettings } from "../core/settings.js";
import type { ClaudeSettings, ProfileMeta, ProfileSummary } from "../core/types.js";

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
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7821;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

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

function tagsForProfile(profile: ProfileSummary, isMain: boolean, ccrRunning: boolean): { status: WebProfile["status"]; statusText: string; tags: string[] } {
  const type = isMain ? "main" : profile.type;
  const tags: string[] = [];
  tags.push(type === "main" ? "Main" : type === "api" ? "API" : type === "login" ? "Login" : type === "ccr" ? "CCR" : "Unknown");

  let status: WebProfile["status"] = "ready";
  let statusText = "Ready";
  if (profile.type === "api" && profile.tokenStatus === "missing") {
    status = "needs_attention";
    statusText = "Missing Token";
  }
  if (profile.type === "api" && !profile.baseUrl) {
    status = "needs_attention";
    statusText = "Missing Base URL";
  }
  if (profile.type === "ccr" && !ccrRunning) {
    status = "needs_attention";
    statusText = "CCR Offline";
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
  } else if (profile.type === "ccr") {
    tags.push(profile.meta?.ccrRoute ? "Preset Bound" : "Endpoint Bound");
  } else if (isMain) {
    tags.push("Main Config");
  }
  return { status, statusText, tags };
}

async function toWebProfile(profile: ProfileSummary, isMain: boolean, ccrRunning: boolean, includeSettings = false): Promise<WebProfile> {
  const tagState = tagsForProfile(profile, isMain, ccrRunning);
  const settings = includeSettings ? await readSettings(profile.dir) : undefined;
  return {
    ...profile,
    type: isMain ? "main" : profile.type,
    ...tagState,
    startCommand: isMain ? "claude" : `ccp start ${profile.name}`,
    settings: publicSettings(settings)
  };
}

async function getAllProfiles(includeSettings = false): Promise<WebProfile[]> {
  const ccr = await getCcrStatus();
  const profiles: WebProfile[] = [];
  const mainDir = getMainClaudeDir();
  if (existsSync(mainDir)) {
    const main = await summarizeProfile("main", mainDir);
    profiles.push(await toWebProfile(main, true, ccr.running, includeSettings));
  }
  for (const profile of await listProfiles()) {
    profiles.push(await toWebProfile(profile, false, ccr.running, includeSettings));
  }
  return profiles;
}

function dashboardFromProfiles(profiles: WebProfile[], ccr: Awaited<ReturnType<typeof getCcrStatus>>) {
  const count = (type: WebProfile["type"]) => profiles.filter((profile) => profile.type === type).length;
  return {
    profiles: {
      total: profiles.length,
      main: count("main"),
      api: count("api"),
      login: count("login"),
      ccr: count("ccr"),
      needsAttention: profiles.filter((profile) => profile.status !== "ready").length
    },
    ccr: {
      installed: ccr.installed,
      running: ccr.running,
      endpoint: ccr.endpoint,
      uiUrl: `${ccr.endpoint.replace(/\/$/, "")}/ui/`,
      apiKeyStatus: ccr.apiKeyStatus
    },
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
  const ccr = await getCcrStatus();
  addActivity("success", `Updated profile '${name}'.`);
  return toWebProfile(summarized, false, ccr.running, true);
}

function setOptionalEnv(settings: ClaudeSettings, key: string, value: string): void {
  settings.env ??= {};
  if (value) settings.env[key] = value;
  else delete settings.env[key];
}

async function updateCcrBinding(name: string, body: Record<string, unknown>): Promise<WebProfile> {
  const config = await resolveConfigDir(name, { allowMain: false });
  const route = String(body.route ?? "").trim();
  const preset = String(body.preset ?? name).trim() || name;
  if (!route) throw new CcpError("CCR route is required.");

  const meta = (await readMeta(config.dir)) as ProfileMeta | undefined;
  if (!meta || meta.type !== "ccr") throw new CcpError(`Profile '${name}' is not a CCR profile.`);
  meta.ccrRoute = route;
  meta.ccrPreset = preset;
  await writeMeta(config.dir, meta);
  const summarized = await summarizeProfile(name, config.dir);
  const ccr = await getCcrStatus();
  addActivity("success", `Updated CCR binding for '${name}'.`);
  return toWebProfile(summarized, false, ccr.running, true);
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
  return "application/octet-stream";
}

async function serveStatic(res: ServerResponse, pathname: string, token: string): Promise<void> {
  const root = assetRoot();
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const resolved = path.resolve(root, `.${safePath}`);
  if (!resolved.startsWith(path.resolve(root))) return notFound(res);

  try {
    let data = await readFile(resolved, "utf8");
    if (resolved.endsWith("index.html")) {
      data = data.replace("__CCP_UI_TOKEN__", token);
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

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string, token: string): Promise<void> {
  try {
    if (req.method !== "GET") requireToken(req, token);

    if (pathname === "/api/dashboard") {
      if (req.method !== "GET") return methodNotAllowed(res);
      const profiles = await getAllProfiles();
      return json(res, 200, dashboardFromProfiles(profiles, await getCcrStatus()));
    }

    if (pathname === "/api/profiles") {
      if (req.method !== "GET") return methodNotAllowed(res);
      return json(res, 200, { profiles: await getAllProfiles() });
    }

    if (pathname === "/api/activity") {
      if (req.method !== "GET") return methodNotAllowed(res);
      return json(res, 200, { activity });
    }

    if (pathname === "/api/ccr/status") {
      if (req.method !== "GET") return methodNotAllowed(res);
      const status = await getCcrStatus();
      const profiles = await getAllProfiles();
      return json(res, 200, { ...status, uiUrl: `${status.endpoint.replace(/\/$/, "")}/ui/`, profilesUsingCcr: profiles.filter((profile) => profile.type === "ccr").length });
    }

    if (pathname === "/api/ccr/routes") {
      if (req.method !== "GET") return methodNotAllowed(res);
      return json(res, 200, { routes: getCcrRouteChoices(await readCcrConfig()) });
    }

    if (pathname === "/api/ccr/start") {
      if (req.method !== "POST") return methodNotAllowed(res);
      await startCcrService();
      addActivity("success", "CCR start command sent.");
      return json(res, 200, { status: await getCcrStatus() });
    }

    if (pathname === "/api/ccr/restart") {
      if (req.method !== "POST") return methodNotAllowed(res);
      await restartCcrService();
      addActivity("success", "CCR restart command sent.");
      return json(res, 200, { status: await getCcrStatus() });
    }

    if (pathname === "/api/ccr/stop") {
      if (req.method !== "POST") return methodNotAllowed(res);
      await stopCcrService();
      addActivity("success", "CCR stop command sent.");
      return json(res, 200, { status: await getCcrStatus() });
    }

    if (pathname === "/api/profiles/api") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJsonBody<Record<string, string>>(req);
      const created = await createApiProfile({ name: body.name ?? "", baseUrl: body.baseUrl ?? "", token: body.token ?? "", model: body.model ?? "" });
      addActivity("success", `Created API profile '${created.name}'.`);
      return json(res, 201, { profile: await toWebProfile(created, false, (await getCcrStatus()).running, true) });
    }

    if (pathname === "/api/profiles/login") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJsonBody<Record<string, string>>(req);
      const created = await createLoginProfile({ name: body.name ?? "" });
      addActivity("success", `Created login profile '${created.name}'.`);
      return json(res, 201, { profile: await toWebProfile(created, false, (await getCcrStatus()).running, true) });
    }

    if (pathname === "/api/profiles/ccr") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJsonBody<Record<string, string>>(req);
      const created = await createCcrProfile({ name: body.name ?? "", route: body.route ?? "", token: body.token ?? "" });
      addActivity("success", `Created CCR profile '${created.name}'.`);
      return json(res, 201, { profile: await toWebProfile(created, false, (await getCcrStatus()).running, true) });
    }

    const profileMatch = pathname.match(/^\/api\/profiles\/([^/]+)$/);
    if (profileMatch) {
      const name = decodeURIComponent(profileMatch[1]);
      if (req.method === "GET") {
        const config = await resolveConfigDir(name, { allowMain: true });
        const profile = await summarizeProfile(config.name, config.dir);
        return json(res, 200, { profile: await toWebProfile(profile, config.isMain, (await getCcrStatus()).running, true) });
      }
      if (req.method === "PUT") {
        const body = await readJsonBody<Record<string, unknown>>(req);
        const kind = String(body.kind ?? "api");
        const profile = kind === "ccr" ? await updateCcrBinding(name, body) : await updateApiSettings(name, body);
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
      await handleApi(req, res, url.pathname, token);
      return;
    }
    await serveStatic(res, url.pathname, token);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const url = `http://${host}:${port}/`;
  addActivity("info", `UI started at ${url}`);
  console.log(`ccp ui running at ${url}`);
  console.log("Press Ctrl+C to stop.");
  if (host !== DEFAULT_HOST) {
    console.log("Warning: ccp ui is not bound to 127.0.0.1. Use only on trusted networks.");
  }
  if (options.open) openBrowser(url);
}
