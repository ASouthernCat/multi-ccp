import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { CcpError } from "./errors.js";
import { getClaudeCodeRouterConfigPath, getClaudeCodeRouterDir, type PathContext } from "./paths.js";
import { readMeta, readSettings, writeMeta, writeSettings } from "./settings.js";

export interface CcrProvider {
  name?: string;
  api_base_url?: string;
  api_key?: string;
  models?: string[];
  [key: string]: unknown;
}

export interface CcrProviderTemplate {
  name: string;
  api_base_url: string;
  api_key?: string;
  models: string[];
}

export interface EnsureCcrProviderTemplateResult {
  changed: boolean;
  route: string;
  providerName: string;
}

export interface CcrConfig {
  HOST?: string;
  PORT?: number | string;
  APIKEY?: string;
  Providers?: CcrProvider[];
  Router?: Record<string, unknown>;
  [key: string]: unknown;
}


export interface CcrStatus {
  installed: boolean;
  command?: string;
  configPath: string;
  endpoint: string;
  running: boolean;
  apiKeyStatus: "set" | "missing";
  configExists: boolean;
  hasProviders: boolean;
  routeCount: number;
  ready: boolean;
  statusText: "Not Installed" | "Needs Config" | "Offline" | "Running";
  nextAction: "install" | "configure" | "start" | "open";
  routesReason?: "not_installed" | "config_missing" | "no_providers" | "no_routes";
}

const CCR_MODEL_ENV_NAMES = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "CLAUDE_CODE_SUBAGENT_MODEL"
];


function stripBom(value: string): string {
  return value.replace(/^﻿/, "");
}

export async function readCcrConfig(context: PathContext = {}): Promise<CcrConfig | undefined> {
  const configPath = getClaudeCodeRouterConfigPath(context);
  try {
    return JSON.parse(stripBom(await readFile(configPath, "utf8"))) as CcrConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    const reason = error instanceof Error ? ` ${error.message}` : "";
    throw new CcpError(`Failed to read CCR config: ${configPath}.${reason}`);
  }
}

export function getCcrEndpoint(config?: CcrConfig): string {
  let host = String(config?.HOST ?? "127.0.0.1");
  const port = Number(config?.PORT ?? 3456);

  if (host === "0.0.0.0" || host === "::") {
    host = "127.0.0.1";
  }

  return `http://${host}:${Number.isFinite(port) ? port : 3456}`;
}

export async function getCcrEndpointFromConfig(context: PathContext = {}): Promise<string> {
  return getCcrEndpoint(await readCcrConfig(context));
}

function commandExists(command: string): { exists: boolean; source?: string } {
  const result = process.platform === "win32"
    ? spawnSync("where.exe", [command], { encoding: "utf8" })
    : spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" });

  if (result.status !== 0) {
    return { exists: false };
  }

  const candidates = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const source = process.platform === "win32"
    ? candidates.find((line) => line.toLowerCase().endsWith(".cmd")) ?? candidates[0]
    : candidates[0];
  return { exists: true, source };
}

function spawnCli(command: string, args: string[], options: { detached?: boolean; stdio?: "inherit" | "ignore" } = {}): ChildProcess {
  const stdio = options.stdio ?? "inherit";
  if (process.platform === "win32") {
    return spawn("cmd.exe", ["/d", "/c", command, ...args], {
      detached: options.detached,
      stdio
    });
  }

  return spawn(command, args, {
    detached: options.detached,
    stdio
  });
}

export function getCcrCommand(): string | undefined {
  return commandExists("ccr").source;
}

export function isCcrInstalled(): boolean {
  return commandExists("ccr").exists;
}

export async function testTcpEndpoint(endpoint: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      resolve(false);
      return;
    }

    const socket = net.createConnection({ host: url.hostname, port: Number(url.port), timeout: timeoutMs });
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

export async function getCcrStatus(context: PathContext = {}): Promise<CcrStatus> {
  const config = await readCcrConfig(context);
  const endpoint = getCcrEndpoint(config);
  const command = getCcrCommand();
  const installed = Boolean(command);
  const configExists = Boolean(config);
  const hasProviders = Boolean(config?.Providers?.length);
  const routeCount = getCcrRouteChoices(config).length;
  const running = await testTcpEndpoint(endpoint);
  const ready = installed && configExists && hasProviders && routeCount > 0 && running;
  const statusText: CcrStatus["statusText"] = !installed ? "Not Installed" : !configExists || !hasProviders ? "Needs Config" : running ? "Running" : "Offline";
  const nextAction: CcrStatus["nextAction"] = !installed ? "install" : !configExists || !hasProviders || routeCount === 0 ? "configure" : running ? "open" : "start";

  return {
    installed,
    command,
    configPath: getClaudeCodeRouterConfigPath(context),
    endpoint,
    running,
    apiKeyStatus: config?.APIKEY ? "set" : "missing",
    configExists,
    hasProviders,
    routeCount,
    ready,
    statusText,
    nextAction,
    routesReason: getCcrRoutesReason({ installed, configExists, hasProviders, routeCount })
  };
}


export async function invokeCcrCli(action: string, extraArgs: string[] = []): Promise<number> {
  if (!isCcrInstalled()) {
    throw new CcpError("CCR is not installed. Run 'ccp ccr install' first.");
  }

  return new Promise((resolve, reject) => {
    const child = spawnCli("ccr", [action, ...extraArgs]);
    child.on("error", (error: Error) => reject(new CcpError(`Failed to run ccr ${action}: ${error.message}`)));
    child.on("exit", (code: number | null) => resolve(code ?? 0));
  });
}

export async function installCcr(): Promise<number> {
  if (!commandExists("npm").exists) {
    throw new CcpError("npm was not found. Make sure Node.js/npm is available in this terminal.");
  }

  if (isCcrInstalled()) {
    console.log("CCR is already installed.");
    return 0;
  }

  return new Promise((resolve, reject) => {
    const child = spawnCli("npm", ["install", "-g", "@musistudio/claude-code-router"]);
    child.on("error", (error: Error) => reject(new CcpError(`Failed to install CCR: ${error.message}`)));
    child.on("exit", (code: number | null) => resolve(code ?? 0));
  });
}

async function waitForEndpoint(endpoint: string, attempts = 20, delayMs = 500): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (await testTcpEndpoint(endpoint)) {
      return true;
    }
  }
  return false;
}

export async function startCcrService(context: PathContext = {}): Promise<void> {
  const endpoint = await getCcrEndpointFromConfig(context);
  if (await testTcpEndpoint(endpoint)) {
    console.log(`CCR is already running: ${endpoint}`);
    return;
  }

  if (!isCcrInstalled()) {
    throw new CcpError("CCR is not installed. Run 'ccp ccr install' first.");
  }

  const child = spawnCli("ccr", ["start"], { detached: true, stdio: "ignore" });
  child.unref();

  if (await waitForEndpoint(endpoint)) {
    console.log(`CCR started: ${endpoint}`);
  } else {
    console.log(`CCR start command was sent, but endpoint is not reachable yet: ${endpoint}`);
  }
}

export async function stopCcrService(): Promise<void> {
  await invokeCcrCli("stop");
  console.log("CCR stop command sent.");
}

export async function restartCcrService(context: PathContext = {}): Promise<void> {
  await stopCcrService();
  await startCcrService(context);
  const status = await getCcrStatus(context);
  printCcrStatus(status);
}

export function printCcrStatus(status: CcrStatus): void {
  console.log(`CCR status:    ${status.statusText}`);
  console.log(`CCR installed: ${status.installed}`);
  if (status.command) {
    console.log(`CCR command:   ${status.command}`);
  }
  console.log(`Config:        ${status.configPath}`);
  console.log(`Config ready:  ${status.configExists && status.hasProviders}`);
  console.log(`Routes:        ${status.routeCount}`);
  console.log(`Endpoint:      ${status.endpoint}`);
  console.log(`Running:       ${status.running}`);
  console.log(`APIKEY:        ${status.apiKeyStatus}`);
  switch (status.nextAction) {
    case "install":
      console.log("Next:          ccp ccr install");
      break;
    case "configure":
      console.log("Next:          ccp ccr model");
      break;
    case "start":
      console.log("Next:          ccp ccr start");
      break;
    case "open":
      console.log("Next:          ccp ccr ui");
      break;
  }
}


export function getCcrPresetRoot(context: PathContext = {}): string {
  return path.join(getClaudeCodeRouterDir(context), "presets");
}

export function getCcrPresetDir(name: string, context: PathContext = {}): string {
  return path.join(getCcrPresetRoot(context), name);
}

export function getCcrPresetManifestPath(name: string, context: PathContext = {}): string {
  return path.join(getCcrPresetDir(name, context), "manifest.json");
}

export function getCcrPidPath(context: PathContext = {}): string {
  return path.join(getClaudeCodeRouterDir(context), ".claude-code-router.pid");
}

export async function getCcrPresetEndpoint(name: string, context: PathContext = {}): Promise<string> {
  return `${await getCcrEndpointFromConfig(context)}/preset/${name}`;
}

async function getFileMtimeMs(filePath: string): Promise<number | undefined> {
  try {
    return (await stat(filePath)).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export function getCcrRouteChoices(config?: CcrConfig): string[] {
  const choices: string[] = [];
  for (const provider of config?.Providers ?? []) {
    if (!provider.name) continue;
    for (const model of provider.models ?? []) {
      choices.push(`${provider.name},${model}`);
    }
  }
  return choices.sort((a, b) => a.localeCompare(b));
}

export function getCcrRoutesReason(status: Pick<CcrStatus, "installed" | "configExists" | "hasProviders" | "routeCount">): CcrStatus["routesReason"] {
  if (!status.installed) return "not_installed";
  if (!status.configExists) return "config_missing";
  if (!status.hasProviders) return "no_providers";
  if (status.routeCount === 0) return "no_routes";
  return undefined;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function routeExists(config: CcrConfig, route: string): boolean {
  const [providerName, modelName] = route.split(",", 2).map((item) => item.trim());
  if (!providerName || !modelName) {
    return false;
  }

  const provider = config.Providers?.find((item) => item.name === providerName);
  return Boolean(provider?.models?.includes(modelName));
}

function ensureRouterRoute(config: CcrConfig, route: string): boolean {
  let changed = false;
  let router: Record<string, unknown>;
  if (isPlainRecord(config.Router)) {
    router = config.Router;
  } else {
    router = {};
    config.Router = router;
    changed = true;
  }

  const routeKeys = ["default", "background", "think", "longContext", "webSearch"] as const;
  for (const key of routeKeys) {
    const current = typeof router[key] === "string" ? router[key].trim() : "";
    if (!current || !routeExists(config, current)) {
      router[key] = route;
      changed = true;
    }
  }

  if (typeof router.longContextThreshold !== "number") {
    const threshold = Number(router.longContextThreshold ?? 60000);
    router.longContextThreshold = Number.isFinite(threshold) ? threshold : 60000;
    changed = true;
  }

  if (router.image !== undefined && typeof router.image === "string" && router.image.trim() && !routeExists(config, router.image)) {
    router.image = "";
    changed = true;
  }

  return changed;
}

async function readCcrPid(context: PathContext = {}): Promise<number | undefined> {
  let raw = "";
  try {
    raw = await readFile(getCcrPidPath(context), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  const pid = Number(raw.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function parseEpochMs(output: string): number | undefined {
  const value = Number(output.trim());
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseDateMs(output: string): number | undefined {
  const value = Date.parse(output.trim());
  return Number.isFinite(value) ? value : undefined;
}

async function getProcessStartTimeMs(pid: number): Promise<number | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }

  if (process.platform === "win32") {
    const command = [
      "$p = Get-CimInstance Win32_Process -Filter \"ProcessId = " + pid + "\" -ErrorAction SilentlyContinue",
      "if ($p) { [DateTimeOffset]$p.CreationDate | ForEach-Object { $_.ToUnixTimeMilliseconds() } }"
    ].join("; ");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], { encoding: "utf8" });
    if (result.status !== 0) {
      return undefined;
    }
    return parseEpochMs(result.stdout);
  }

  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  if (result.status !== 0) {
    return undefined;
  }
  return parseDateMs(result.stdout);
}

export async function ensureCcrProviderTemplate(
  template: CcrProviderTemplate,
  options: { apiKey?: string; providerName?: string } = {},
  context: PathContext = {}
): Promise<EnsureCcrProviderTemplateResult> {
  const providerName = options.providerName?.trim() || template.name;
  const model = template.models[0];
  if (!providerName || !model) {
    throw new CcpError("CCR provider template must include a provider name and at least one model.");
  }

  const configPath = getClaudeCodeRouterConfigPath(context);
  const config = (await readCcrConfig(context)) ?? { HOST: "127.0.0.1", PORT: 3456, Providers: [] };
  config.Providers ??= [];
  let changed = false;
  let provider = config.Providers.find((item) => item.name === providerName);

  if (!provider) {
    provider = {
      ...cloneJson(template),
      name: providerName,
      models: [...template.models]
    };
    config.Providers.push(provider);
    changed = true;
  } else {
    const currentBaseUrl = typeof provider.api_base_url === "string" ? provider.api_base_url : "";
    if (currentBaseUrl && normalizeUrl(currentBaseUrl) !== normalizeUrl(template.api_base_url)) {
      throw new CcpError(`CCR provider '${providerName}' already exists with a different api_base_url. Rename the provider or update it in CCR UI.`);
    }
    if (!currentBaseUrl) {
      provider.api_base_url = template.api_base_url;
      changed = true;
    }
    provider.models ??= [];
    for (const item of template.models) {
      if (!provider.models.includes(item)) {
        provider.models.push(item);
        changed = true;
      }
    }
  }

  const apiKey = options.apiKey?.trim() || template.api_key?.trim();
  if (apiKey && provider.api_key !== apiKey) {
    provider.api_key = apiKey;
    changed = true;
  }

  const route = `${providerName},${model}`;
  if (ensureRouterRoute(config, route)) {
    changed = true;
  }

  if (changed) {
    await mkdir(getClaudeCodeRouterDir(context), { recursive: true });
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  }

  return { changed, route, providerName };
}

export async function reloadCcrRuntimeWhenChanged(
  changed: boolean,
  context: PathContext = {},
  options: {
    testEndpoint?: typeof testTcpEndpoint;
    restart?: typeof restartCcrService;
    allowCustomHomeDir?: boolean;
  } = {}
): Promise<boolean> {
  if (!changed) {
    return false;
  }
  if (context.homeDir && !options.allowCustomHomeDir) {
    return false;
  }

  const endpoint = await getCcrEndpointFromConfig(context);
  const testEndpoint = options.testEndpoint ?? testTcpEndpoint;
  if (!(await testEndpoint(endpoint))) {
    return false;
  }

  console.log("CCR config changed. Restarting CCR...");
  const restart = options.restart ?? restartCcrService;
  await restart(context);
  return true;
}

export async function reloadCcrRuntimeIfPresetOutdated(
  presetName: string,
  context: PathContext = {},
  options: {
    testEndpoint?: typeof testTcpEndpoint;
    restart?: typeof restartCcrService;
    getProcessStartTimeMs?: (pid: number) => Promise<number | undefined>;
    allowCustomHomeDir?: boolean;
  } = {}
): Promise<boolean> {
  if (context.homeDir && !options.allowCustomHomeDir) {
    return false;
  }

  const endpoint = await getCcrEndpointFromConfig(context);
  const testEndpoint = options.testEndpoint ?? testTcpEndpoint;
  if (!(await testEndpoint(endpoint))) {
    return false;
  }

  const [presetMtimeMs, pid] = await Promise.all([
    getFileMtimeMs(getCcrPresetManifestPath(presetName, context)),
    readCcrPid(context)
  ]);
  if (presetMtimeMs === undefined || pid === undefined) {
    return false;
  }

  const processStartTimeMs = await (options.getProcessStartTimeMs ?? getProcessStartTimeMs)(pid);
  if (processStartTimeMs === undefined || presetMtimeMs <= processStartTimeMs) {
    return false;
  }

  console.log(`CCR preset '${presetName}' changed after CCR started. Restarting CCR...`);
  const restart = options.restart ?? restartCcrService;
  await restart(context);
  return true;
}

function newCcrRouterForRoute(config: CcrConfig, route: string): Record<string, unknown> {
  const router = isPlainRecord(config.Router) ? config.Router : {};
  return {
    default: route,
    background: route,
    think: route,
    longContext: route,
    longContextThreshold: Number(router.longContextThreshold ?? 60000),
    webSearch: route,
    image: typeof router.image === "string" ? router.image : ""
  };
}

export async function ensureCcrPreset(profileName: string, route: string, context: PathContext = {}): Promise<boolean> {
  if (!route.trim()) {
    return false;
  }

  const config = await readCcrConfig(context);
  if (!config) {
    throw new CcpError(`CCR config not found: ${getClaudeCodeRouterConfigPath(context)}`);
  }
  if (!config.Providers?.length) {
    throw new CcpError("CCR config has no Providers. Run 'ccp ccr model' first.");
  }

  const providerName = route.split(",", 2)[0];
  const provider = config.Providers.find((item) => item.name === providerName);
  if (!provider) {
    throw new CcpError(`CCR provider '${providerName}' was not found for route '${route}'.`);
  }

  const manifest = {
    name: profileName,
    version: "1.0.0",
    description: `Generated by ccp for profile '${profileName}'.`,
    Providers: [cloneJson(provider)],
    Router: newCcrRouterForRoute(config, route),
    noServer: false
  };

  const presetDir = getCcrPresetDir(profileName, context);
  const manifestPath = getCcrPresetManifestPath(profileName, context);
  const nextJson = JSON.stringify(manifest, null, 2);
  let currentJson = "";
  try {
    currentJson = await readFile(manifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  if (currentJson.trimEnd() === nextJson.trimEnd()) {
    return false;
  }

  await mkdir(presetDir, { recursive: true });
  await writeFile(manifestPath, nextJson + "\n", "utf8");
  return true;
}

export async function updateCcrProfileEndpoint(
  profileDir: string,
  endpoint: string,
  presetName: string
): Promise<boolean> {
  let changed = false;
  const settings = await readSettings(profileDir);
  if (settings) {
    settings.env ??= {};
    if (settings.env.ANTHROPIC_BASE_URL !== endpoint) {
      settings.env.ANTHROPIC_BASE_URL = endpoint;
      changed = true;
    }
    for (const name of CCR_MODEL_ENV_NAMES) {
      if (settings.env[name] !== undefined) {
        delete settings.env[name];
        changed = true;
      }
    }
    if (changed) {
      await writeSettings(profileDir, settings);
    }
  }

  const meta = await readMeta(profileDir);
  if (meta) {
    let metaChanged = false;
    if (meta.endpoint !== endpoint) {
      meta.endpoint = endpoint;
      metaChanged = true;
    }
    if (presetName && meta.ccrPreset !== presetName) {
      meta.ccrPreset = presetName;
      metaChanged = true;
    }
    if (metaChanged) {
      await writeMeta(profileDir, meta);
      changed = true;
    }
  }

  return changed;
}

export async function ensureCcrProfileGateway(
  profileDir: string,
  profileName: string,
  context: PathContext = {}
): Promise<void> {
  const meta = await readMeta(profileDir);
  if (!meta || meta.type !== "ccr") {
    return;
  }

  const presetName = meta.ccrPreset || profileName;
  const route = String(meta.ccrRoute ?? "");
  if (!route.trim()) {
    throw new CcpError(`CCR profile '${profileName}' has no ccrRoute. Run 'ccp ccr model' and recreate or edit this profile.`);
  }

  const endpoint = await getCcrPresetEndpoint(presetName, context);
  await updateCcrProfileEndpoint(profileDir, endpoint, presetName);

  const presetChanged = await ensureCcrPreset(presetName, route, context);
  if (presetChanged) {
    console.log(`Updated CCR preset '${presetName}': ${route}`);
  }

  const rootEndpoint = await getCcrEndpointFromConfig(context);
  let running = await testTcpEndpoint(rootEndpoint);
  if (await reloadCcrRuntimeWhenChanged(presetChanged, context)) {
    running = await testTcpEndpoint(rootEndpoint);
  }
  if (!presetChanged && running && await reloadCcrRuntimeIfPresetOutdated(presetName, context)) {
    running = await testTcpEndpoint(rootEndpoint);
  }

  if (running) {
    return;
  }

  if (meta.autoStart === false) {
    throw new CcpError(`CCR endpoint is not reachable: ${endpoint}`);
  }

  console.log("CCR is not running. Starting CCR...");
  await startCcrService(context);

  if (!(await testTcpEndpoint(rootEndpoint))) {
    throw new CcpError(`CCR endpoint is still not reachable after start: ${rootEndpoint}`);
  }
}
