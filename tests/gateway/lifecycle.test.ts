import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getGatewayStatus,
  startGateway,
  stopGateway,
  type GatewayRuntimeState
} from "../../src/core/gateway-lifecycle.js";
import { getGatewayRuntimePath, getGatewayStartupLockPath } from "../../src/core/paths.js";

const homes: string[] = [];

afterEach(async () => {
  await Promise.allSettled(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function createContext() {
  const homeDir = await mkdtemp(path.join(tmpdir(), "ccp-gateway-lifecycle-"));
  homes.push(homeDir);
  return { homeDir };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function health(instanceId: string, profileCount = 0): Response {
  return new Response(JSON.stringify({
    ok: true,
    service: "multi-ccp-gateway",
    protocolVersion: 1,
    instanceId,
    profileCount
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function fakeChild(pid = 4242): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperty(child, "pid", { value: pid });
  child.unref = vi.fn(() => child);
  return child;
}

describe("gateway lifecycle", () => {
  it("distinguishes an unrelated listener from an offline endpoint", async () => {
    const context = await createContext();
    const occupied = await getGatewayStatus(context, {
      fetch: vi.fn().mockResolvedValue(new Response("not gateway", { status: 200 }))
    });
    const offline = await getGatewayStatus(context, {
      fetch: vi.fn().mockRejectedValue(new Error("connection refused"))
    });

    expect(occupied).toMatchObject({ running: false, owned: false, statusText: "Port In Use" });
    expect(offline).toMatchObject({ running: false, owned: false, statusText: "Offline" });
  });

  it("starts one detached process, verifies identity, writes runtime, and releases the lock", async () => {
    const context = await createContext();
    const spawnProcess = vi.fn().mockReturnValue(fakeChild());
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(async () => health("instance-1", 3));

    const status = await startGateway(context, {
      spawnProcess,
      fetch: fetchMock,
      randomId: () => "instance-1",
      processArgs: () => ({ command: process.execPath, args: ["gateway-entry.js"] }),
      processExists: () => true,
      getProcessStartTimeMs: async () => 1_700_000_000_000,
      now: () => 1_700_000_000_500,
      sleep: async () => undefined
    });

    expect(status).toMatchObject({
      running: true,
      owned: true,
      statusText: "Running",
      instanceId: "instance-1",
      pid: 4242,
      profileCount: 3
    });
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(spawnProcess.mock.calls[0][0]).toBe(process.execPath);
    expect(spawnProcess.mock.calls[0][1]).toEqual(["gateway-entry.js"]);
    expect(spawnProcess.mock.calls[0][2]).toMatchObject({
      detached: true,
      windowsHide: true,
      env: expect.objectContaining({
        CCP_GATEWAY_INSTANCE_ID: "instance-1",
        CCP_GATEWAY_HOME: context.homeDir
      })
    });
    const runtime = JSON.parse(await readFile(getGatewayRuntimePath(context), "utf8")) as GatewayRuntimeState;
    expect(runtime).toMatchObject({ instanceId: "instance-1", pid: 4242 });
    expect(runtime.processStartedAt).toBe("2023-11-14T22:13:20.000Z");
    expect(await exists(getGatewayStartupLockPath(context))).toBe(false);
  });

  it("releases the startup lock and reports a child spawn error", async () => {
    const context = await createContext();
    const child = fakeChild();
    const spawnProcess = vi.fn().mockImplementation(() => {
      queueMicrotask(() => child.emit("error", new Error("spawn failed")));
      return child;
    });

    await expect(startGateway(context, {
      spawnProcess,
      fetch: vi.fn().mockRejectedValue(new Error("offline")),
      randomId: () => "instance-error",
      processArgs: () => ({ command: process.execPath, args: ["missing.js"] }),
      processExists: () => false,
      killProcess: vi.fn(),
      sleep: async () => new Promise((resolve) => setImmediate(resolve))
    })).rejects.toThrow("spawn failed");
    expect(await exists(getGatewayStartupLockPath(context))).toBe(false);
  });

  it("coalesces simultaneous starts into one shared gateway process", async () => {
    const context = await createContext();
    let spawned = false;
    const spawnProcess = vi.fn().mockImplementation(() => {
      spawned = true;
      return fakeChild(5151);
    });
    const fetchMock = vi.fn().mockImplementation(async () => {
      if (!spawned) throw new Error("offline");
      return health("shared-instance", 2);
    });
    const deps = {
      spawnProcess,
      fetch: fetchMock,
      randomId: () => "shared-instance",
      processArgs: () => ({ command: process.execPath, args: ["gateway-entry.js"] }),
      processExists: () => true,
      getProcessStartTimeMs: async () => 1_700_000_000_000,
      sleep: async () => new Promise<void>((resolve) => setTimeout(resolve, 1))
    };

    const [first, second] = await Promise.all([
      startGateway(context, deps),
      startGateway(context, deps)
    ]);

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ running: true, instanceId: "shared-instance" });
    expect(second).toMatchObject({ running: true, instanceId: "shared-instance" });
  });

  it("removes a dead runtime without attempting to terminate a reused PID", async () => {
    const context = await createContext();
    const runtimePath = getGatewayRuntimePath(context);
    await mkdir(path.dirname(runtimePath), { recursive: true });
    await writeFile(runtimePath, JSON.stringify({
      version: 1,
      service: "multi-ccp-gateway",
      protocolVersion: 1,
      instanceId: "dead-instance",
      pid: 9999,
      processStartedAt: new Date(0).toISOString(),
      endpoint: "http://127.0.0.1:3921"
    }), "utf8");
    const killProcess = vi.fn();

    const status = await stopGateway(context, {
      processExists: () => false,
      killProcess,
      fetch: vi.fn().mockRejectedValue(new Error("offline"))
    });

    expect(killProcess).not.toHaveBeenCalled();
    expect(await exists(runtimePath)).toBe(false);
    expect(status.statusText).toBe("Offline");
  });

  it("removes stale runtime instead of killing a reused live PID", async () => {
    const context = await createContext();
    const runtimePath = getGatewayRuntimePath(context);
    await mkdir(path.dirname(runtimePath), { recursive: true });
    await writeFile(runtimePath, JSON.stringify({
      version: 1,
      service: "multi-ccp-gateway",
      protocolVersion: 1,
      instanceId: "reused-pid",
      pid: 8181,
      processStartedAt: new Date(1_000).toISOString(),
      endpoint: "http://127.0.0.1:3921"
    }), "utf8");
    const killProcess = vi.fn();

    const status = await stopGateway(context, {
      processExists: () => true,
      getProcessStartTimeMs: async () => 10_000,
      killProcess,
      fetch: vi.fn().mockRejectedValue(new Error("offline"))
    });

    expect(killProcess).not.toHaveBeenCalled();
    expect(await exists(runtimePath)).toBe(false);
    expect(status.statusText).toBe("Offline");
  });

  it("can stop a verified gateway PID when health is unavailable", async () => {
    const context = await createContext();
    const runtimePath = getGatewayRuntimePath(context);
    await mkdir(path.dirname(runtimePath), { recursive: true });
    await writeFile(runtimePath, JSON.stringify({
      version: 1,
      service: "multi-ccp-gateway",
      protocolVersion: 1,
      instanceId: "hung-instance",
      pid: 9191,
      processStartedAt: new Date(5_000).toISOString(),
      endpoint: "http://127.0.0.1:3921"
    }), "utf8");
    let alive = true;
    const killProcess = vi.fn().mockImplementation(() => {
      alive = false;
    });

    const status = await stopGateway(context, {
      processExists: () => alive,
      getProcessStartTimeMs: async () => 5_000,
      killProcess,
      fetch: vi.fn().mockRejectedValue(new Error("health unavailable")),
      sleep: async () => undefined
    });

    expect(killProcess).toHaveBeenCalledWith(9191, "SIGTERM");
    expect(await exists(runtimePath)).toBe(false);
    expect(status.statusText).toBe("Offline");
  });
});
