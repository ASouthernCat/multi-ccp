import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CcpError } from "./errors.js";
import { repairGatewayProfileSettings } from "./gateway-profile.js";
import {
  getGatewayDir,
  getGatewayLogPath,
  getGatewayRuntimePath,
  getGatewayStartupLockPath,
  type PathContext
} from "./paths.js";
import { writeJsonFileAtomic } from "./settings.js";
import { getGatewayEndpoint, readGatewayRuntimeConfig } from "../gateway/config.js";

export const GATEWAY_SERVICE_NAME = "multi-ccp-gateway";
export const GATEWAY_PROTOCOL_VERSION = 1;

export interface GatewayRuntimeState {
  version: 1;
  service: typeof GATEWAY_SERVICE_NAME;
  protocolVersion: typeof GATEWAY_PROTOCOL_VERSION;
  instanceId: string;
  pid: number;
  processStartedAt: string;
  endpoint: string;
}

export interface GatewayStatus {
  installed: true;
  endpoint: string;
  running: boolean;
  owned: boolean;
  profileCount: number;
  pid?: number;
  instanceId?: string;
  statusText: "Offline" | "Running" | "Port In Use" | "Stale Runtime";
}

interface GatewayHealth {
  ok?: boolean;
  service?: string;
  protocolVersion?: number;
  instanceId?: string;
  profileCount?: number;
}

interface ProbeResult {
  reachable: boolean;
  health?: GatewayHealth;
}

export interface GatewayLifecycleDeps {
  spawnProcess?: (command: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildProcess;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  randomId?: () => string;
  getProcessStartTimeMs?: (pid: number) => Promise<number | undefined>;
  killProcess?: (pid: number, signal?: NodeJS.Signals | number) => void;
  processExists?: (pid: number) => boolean;
  now?: () => number;
  processArgs?: () => { command: string; args: string[] };
}

export async function ensureBuiltinGatewayProfile(
  profileDir: string,
  profileName: string,
  context: PathContext = {},
  deps: GatewayLifecycleDeps = {}
): Promise<GatewayStatus> {
  await repairGatewayProfileSettings(profileDir, profileName, context);
  return startGateway(context, deps);
}

export async function getGatewayStatus(
  context: PathContext = {},
  deps: GatewayLifecycleDeps = {}
): Promise<GatewayStatus> {
  const config = await readGatewayRuntimeConfig(context);
  const endpoint = getGatewayEndpoint(config);
  const runtime = await readGatewayRuntime(context);
  const probe = await probeGateway(endpoint, deps.fetch ?? fetch);
  if (!runtime) {
    if (isOurGateway(probe.health)) {
      return {
        installed: true,
        endpoint,
        running: true,
        owned: false,
        profileCount: probe.health?.profileCount ?? 0,
        instanceId: probe.health?.instanceId,
        statusText: "Port In Use"
      };
    }
    return {
      installed: true,
      endpoint,
      running: false,
      owned: false,
      profileCount: 0,
      statusText: probe.reachable ? "Port In Use" : "Offline"
    };
  }

  const matches = isOurGateway(probe.health) &&
    probe.health?.instanceId === runtime.instanceId &&
    runtime.endpoint === endpoint;
  const exists = (deps.processExists ?? processExists)(runtime.pid);
  const portOwnedByAnotherProcess = probe.reachable && !matches;
  return {
    installed: true,
    endpoint,
    running: Boolean(matches && exists),
    owned: Boolean(matches && exists),
    profileCount: probe.health?.profileCount ?? 0,
    pid: runtime.pid,
    instanceId: runtime.instanceId,
    statusText: matches && exists ? "Running" : portOwnedByAnotherProcess ? "Port In Use" : "Stale Runtime"
  };
}

export async function startGateway(
  context: PathContext = {},
  deps: GatewayLifecycleDeps = {}
): Promise<GatewayStatus> {
  const release = await acquireStartupLock(context, deps);
  try {
    const config = await readGatewayRuntimeConfig(context);
    const endpoint = getGatewayEndpoint(config);
    const existingStatus = await getGatewayStatus(context, deps);
    if (existingStatus.running && existingStatus.owned) {
      return existingStatus;
    }
    if (existingStatus.statusText === "Port In Use") {
      throw new CcpError(`Gateway endpoint is already in use by an unowned process: ${endpoint}`);
    }
    const staleRuntime = await readGatewayRuntime(context);
    if (staleRuntime && (deps.processExists ?? processExists)(staleRuntime.pid)) {
      const actualStart = await (deps.getProcessStartTimeMs ?? getProcessStartTimeMs)(staleRuntime.pid);
      const expectedStart = Date.parse(staleRuntime.processStartedAt);
      if (actualStart === undefined || !Number.isFinite(expectedStart)) {
        throw new CcpError("Gateway runtime is stale and its recorded process identity cannot be verified. Inspect the PID before removing runtime.json.");
      }
      if (Math.abs(actualStart - expectedStart) <= 2_000) {
        throw new CcpError("Gateway runtime is stale but its recorded process is still alive. Run 'ccp gateway stop' to recover it safely.");
      }
      await removeRuntimeIfInstance(context, staleRuntime.instanceId);
    }
    if (staleRuntime) {
      await removeRuntimeIfInstance(context, staleRuntime.instanceId);
    }

    const instanceId = (deps.randomId ?? randomUUID)();
    const processSpec = (deps.processArgs ?? resolveGatewayProcessArgs)();
    const logPath = getGatewayLogPath(context);
    const logFd = openSync(logPath, "a");
    let child: ChildProcess;
    try {
      child = (deps.spawnProcess ?? spawn)(processSpec.command, processSpec.args, {
        detached: true,
        windowsHide: true,
        stdio: ["ignore", logFd, logFd],
        env: {
          ...process.env,
          CCP_GATEWAY_INSTANCE_ID: instanceId,
          ...(context.homeDir ? { CCP_GATEWAY_HOME: context.homeDir } : {})
        }
      });
    } finally {
      closeSync(logFd);
    }
    if (!child.pid) {
      throw new CcpError("Gateway process did not report a PID.");
    }
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.unref();

    try {
      await waitForGateway(endpoint, instanceId, deps, () => spawnError);
      const processStartedAtMs = await (deps.getProcessStartTimeMs ?? getProcessStartTimeMs)(child.pid);
      const runtime: GatewayRuntimeState = {
        version: 1,
        service: GATEWAY_SERVICE_NAME,
        protocolVersion: GATEWAY_PROTOCOL_VERSION,
        instanceId,
        pid: child.pid,
        processStartedAt: new Date(processStartedAtMs ?? (deps.now ?? Date.now)()).toISOString(),
        endpoint
      };
      await writeJsonFileAtomic(getGatewayRuntimePath(context), runtime, 0o600);
      return getGatewayStatus(context, deps);
    } catch (error) {
      safeKill(child.pid, "SIGTERM", deps);
      throw error;
    }
  } finally {
    await release();
  }
}

export async function stopGateway(
  context: PathContext = {},
  deps: GatewayLifecycleDeps = {}
): Promise<GatewayStatus> {
  const runtime = await readGatewayRuntime(context);
  if (!runtime) {
    return getGatewayStatus(context, deps);
  }
  if (!(deps.processExists ?? processExists)(runtime.pid)) {
    await removeRuntimeIfInstance(context, runtime.instanceId);
    return getGatewayStatus(context, deps);
  }
  const actualStart = await (deps.getProcessStartTimeMs ?? getProcessStartTimeMs)(runtime.pid);
  const expectedStart = Date.parse(runtime.processStartedAt);
  if (actualStart !== undefined && Number.isFinite(expectedStart) && Math.abs(actualStart - expectedStart) > 2_000) {
    await removeRuntimeIfInstance(context, runtime.instanceId);
    return getGatewayStatus(context, deps);
  }
  if (actualStart === undefined || !Number.isFinite(expectedStart)) {
    throw new CcpError("Refusing to stop gateway because its PID creation time cannot be verified.");
  }
  const probe = await probeGateway(runtime.endpoint, deps.fetch ?? fetch);
  if (isOurGateway(probe.health) && probe.health?.instanceId !== runtime.instanceId) {
    throw new CcpError("Refusing to stop gateway because another gateway instance owns the endpoint.");
  }

  safeKill(runtime.pid, "SIGTERM", deps);
  const sleep = deps.sleep ?? defaultSleep;
  for (let attempt = 0; attempt < 40 && (deps.processExists ?? processExists)(runtime.pid); attempt += 1) {
    await sleep(100);
  }
  if ((deps.processExists ?? processExists)(runtime.pid)) {
    const latestProbe = await probeGateway(runtime.endpoint, deps.fetch ?? fetch);
    if (!isOurGateway(latestProbe.health) || latestProbe.health?.instanceId !== runtime.instanceId) {
      throw new CcpError("Gateway ownership changed while stopping; refusing to force terminate the PID.");
    }
    const latestStart = await (deps.getProcessStartTimeMs ?? getProcessStartTimeMs)(runtime.pid);
    if (latestStart === undefined || Math.abs(latestStart - expectedStart) > 2_000) {
      throw new CcpError("Gateway PID identity changed while stopping; refusing to force terminate it.");
    }
    safeKill(runtime.pid, "SIGKILL", deps);
  }
  await removeRuntimeIfInstance(context, runtime.instanceId);
  return getGatewayStatus(context, deps);
}

export async function restartGateway(
  context: PathContext = {},
  deps: GatewayLifecycleDeps = {}
): Promise<GatewayStatus> {
  const runtime = await readGatewayRuntime(context);
  if (runtime) {
    await stopGateway(context, deps);
  }
  return startGateway(context, deps);
}

export function printGatewayStatus(status: GatewayStatus): void {
  console.log(`Gateway: ${status.statusText}`);
  console.log(`Endpoint: ${status.endpoint}`);
  console.log(`Owned: ${status.owned ? "yes" : "no"}`);
  console.log(`Profiles: ${status.profileCount}`);
  if (status.pid) console.log(`PID: ${status.pid}`);
  if (status.instanceId) console.log(`Instance: ${status.instanceId}`);
}

async function waitForGateway(
  endpoint: string,
  instanceId: string,
  deps: GatewayLifecycleDeps,
  getSpawnError: () => Error | undefined
): Promise<void> {
  const sleep = deps.sleep ?? defaultSleep;
  const fetchImpl = deps.fetch ?? fetch;
  let lastError = "health endpoint did not become ready";
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const spawnError = getSpawnError();
    if (spawnError) {
      throw new CcpError(`Gateway process failed to start: ${spawnError.message}`, { cause: spawnError });
    }
    const probe = await probeGateway(endpoint, fetchImpl);
    if (isOurGateway(probe.health) && probe.health?.instanceId === instanceId) {
      return;
    }
    if (probe.reachable && probe.health?.instanceId && probe.health.instanceId !== instanceId) {
      lastError = "another gateway instance is listening on the configured endpoint";
      break;
    }
    await sleep(100);
  }
  throw new CcpError(`Gateway failed to start: ${lastError}.`);
}

async function probeGateway(endpoint: string, fetchImpl: typeof fetch): Promise<ProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 800);
  try {
    const response = await fetchImpl(`${endpoint}/health`, { signal: controller.signal, redirect: "manual" });
    let health: GatewayHealth | undefined;
    try {
      health = await response.json() as GatewayHealth;
    } catch {
      health = undefined;
    }
    return { reachable: true, health };
  } catch {
    return { reachable: false };
  } finally {
    clearTimeout(timeout);
  }
}

function isOurGateway(health: GatewayHealth | undefined): boolean {
  return health?.service === GATEWAY_SERVICE_NAME && health.protocolVersion === GATEWAY_PROTOCOL_VERSION;
}

async function readGatewayRuntime(context: PathContext): Promise<GatewayRuntimeState | undefined> {
  try {
    const raw = await readFile(getGatewayRuntimePath(context), "utf8");
    const value = JSON.parse(raw) as GatewayRuntimeState;
    return value?.service === GATEWAY_SERVICE_NAME && value.protocolVersion === GATEWAY_PROTOCOL_VERSION
      ? value
      : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new CcpError(`Failed to read gateway runtime: ${(error as Error).message}`);
  }
}

async function removeRuntimeIfInstance(context: PathContext, instanceId: string): Promise<void> {
  const current = await readGatewayRuntime(context);
  if (current?.instanceId === instanceId) {
    await unlink(getGatewayRuntimePath(context)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

async function acquireStartupLock(
  context: PathContext,
  deps: GatewayLifecycleDeps
): Promise<() => Promise<void>> {
  const lockPath = getGatewayStartupLockPath(context);
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  await mkdir(getGatewayDir(context), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      const owner = randomUUID();
      try {
        await handle.writeFile(JSON.stringify({ owner, pid: process.pid, createdAt: new Date(now()).toISOString() }));
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
      await handle.close();
      return async () => {
        try {
          const current = JSON.parse(await readFile(lockPath, "utf8")) as { owner?: string };
          if (current.owner === owner) {
            await unlink(lockPath).catch(() => undefined);
          }
        } catch {
          // A missing or replaced lock is no longer owned by this starter.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await startupLockIsStale(lockPath, now(), deps.processExists ?? processExists)) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      await sleep(100);
    }
  }
  throw new CcpError("Timed out waiting for the gateway startup lock.");
}

async function startupLockIsStale(
  lockPath: string,
  now: number,
  exists: (pid: number) => boolean
): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number; createdAt?: string };
    const age = now - Date.parse(value.createdAt ?? "");
    return !value.pid || !exists(value.pid) || !Number.isFinite(age) || age > 30_000;
  } catch {
    return true;
  }
}

function resolveGatewayProcessArgs(): { command: string; args: string[] } {
  const currentFile = fileURLToPath(import.meta.url);
  const sourceMode = path.extname(currentFile).toLowerCase() === ".ts";
  const entry = fileURLToPath(new URL(sourceMode ? "../gateway/main.ts" : "../gateway/main.js", import.meta.url));
  if (sourceMode) {
    return { command: process.execPath, args: [...process.execArgv, entry] };
  }
  if (!existsSync(entry)) {
    throw new CcpError(`Gateway entry does not exist: ${entry}`);
  }
  return { command: process.execPath, args: [entry] };
}

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function getProcessStartTimeMs(pid: number): Promise<number | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "win32") {
    const command = [
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue`,
      "if ($p) { [DateTimeOffset]$p.CreationDate | ForEach-Object { $_.ToUnixTimeMilliseconds() } }"
    ].join("; ");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], { encoding: "utf8" });
    return result.status === 0 ? parsePositiveNumber(result.stdout) : undefined;
  }
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  const parsed = Date.parse(result.stdout.trim());
  return result.status === 0 && Number.isFinite(parsed) ? parsed : undefined;
}

function parsePositiveNumber(value: string): number | undefined {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function safeKill(pid: number, signal: NodeJS.Signals, deps: GatewayLifecycleDeps): void {
  try {
    (deps.killProcess ?? process.kill)(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
