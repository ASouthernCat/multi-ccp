import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchClaude, type LaunchOptions } from "../../src/core/launcher.js";
import { createApiProfile } from "../../src/core/profiles.js";

const homes: string[] = [];

afterEach(async () => {
  await Promise.allSettled(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

function createProcessHost() {
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: false,
    isRaw: false,
    resume: vi.fn(),
    pause: vi.fn(),
    setRawMode: vi.fn()
  });
  const stdout = Object.assign(new EventEmitter(), {
    columns: 120,
    rows: 30,
    write: vi.fn(() => true)
  });
  return Object.assign(new EventEmitter(), { pid: 2468, ppid: 1357, stdin, stdout });
}

function createFakePty() {
  let exitListener: ((event: { exitCode: number }) => void) | undefined;
  const exitDispose = vi.fn(() => {
    exitListener = undefined;
  });
  const terminal = {
    pid: 1234,
    cols: 120,
    rows: 30,
    process: "claude",
    handleFlowControl: false,
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn((listener: (event: { exitCode: number }) => void) => {
      exitListener = listener;
      return { dispose: exitDispose };
    }),
    resize: vi.fn(),
    clear: vi.fn(),
    write: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  };
  return {
    terminal,
    emitExit(exitCode: number) {
      exitListener?.({ exitCode });
    }
  };
}

async function createLaunchHarness() {
  const homeDir = await mkdtemp(path.join(tmpdir(), "ccp-launcher-lifecycle-"));
  const cwd = path.join(homeDir, "workspace");
  await mkdir(cwd);
  homes.push(homeDir);
  const profile = await createApiProfile({
    name: "lifecycle",
    baseUrl: "https://example.test/anthropic",
    token: "key",
    model: "model"
  }, { homeDir, cwd });
  const processHost = createProcessHost();
  const pty = createFakePty();
  const collabSession = { close: vi.fn(), injectPrompt: vi.fn(() => true), reportActivity: vi.fn() };
  const isProcessAlive = vi.fn(() => true);
  const runtimeDeps = {
    ensureProfileCollabConfig: vi.fn().mockResolvedValue(undefined),
    spawnPty: vi.fn(() => pty.terminal),
    createCollabTerminalSession: vi.fn(() => collabSession),
    processHost,
    isProcessAlive,
    parentProcessCheckIntervalMs: 10
  } as unknown as NonNullable<LaunchOptions["runtimeDeps"]>;
  const result = launchClaude({ name: profile.name, context: { homeDir, cwd }, cwd, runtimeDeps });
  await vi.waitFor(() => expect(runtimeDeps.createCollabTerminalSession).toHaveBeenCalledOnce());
  return { result, processHost, pty, collabSession, runtimeDeps, isProcessAlive };
}

describe("Claude launcher collaboration lifecycle", () => {
  it("closes the collaboration connection when the PTY exits", async () => {
    const harness = await createLaunchHarness();

    harness.pty.emitExit(0);

    await expect(harness.result).resolves.toBe(0);
    expect(harness.collabSession.close).toHaveBeenCalledOnce();
    expect(harness.pty.terminal.kill).toHaveBeenCalledOnce();
    expect(harness.processHost.stdin.listenerCount("data")).toBe(0);
    expect(harness.processHost.stdin.listenerCount("end")).toBe(0);
    expect(harness.processHost.stdin.listenerCount("close")).toBe(0);
    expect(harness.processHost.listenerCount("exit")).toBe(0);
  });

  it("assigns a launcher-instance peer ID and reports terminal activity", async () => {
    const harness = await createLaunchHarness();
    const sessionOptions = harness.runtimeDeps.createCollabTerminalSession.mock.calls[0]?.[0];
    const spawnOptions = harness.runtimeDeps.spawnPty.mock.calls[0]?.[2];

    expect(sessionOptions).toMatchObject({
      profile: "lifecycle",
      peerId: "lifecycle:2468",
      ownerPid: 2468
    });
    expect(spawnOptions.env.CCP_PEER_ID).toBe("lifecycle:2468");

    harness.processHost.stdin.emit("data", Buffer.from("hello"));
    const outputListener = harness.pty.terminal.onData.mock.calls[0]?.[0];
    outputListener("thinking");

    expect(harness.collabSession.reportActivity).toHaveBeenNthCalledWith(1, "input");
    expect(harness.collabSession.reportActivity).toHaveBeenNthCalledWith(2, "output");

    harness.pty.emitExit(0);
    await expect(harness.result).resolves.toBe(0);
  });

  it("closes the PTY and collaboration connection when the controlling terminal input ends", async () => {
    const harness = await createLaunchHarness();

    harness.processHost.stdin.emit("end");

    await expect(harness.result).resolves.toBe(1);
    expect(harness.collabSession.close).toHaveBeenCalledOnce();
    expect(harness.pty.terminal.kill).toHaveBeenCalledOnce();
    harness.processHost.stdin.emit("close");
    harness.pty.emitExit(0);
    expect(harness.collabSession.close).toHaveBeenCalledOnce();
  });

  it("performs the same idempotent cleanup when the launcher process exits", async () => {
    const harness = await createLaunchHarness();

    harness.processHost.emit("exit", 0);

    await expect(harness.result).resolves.toBe(1);
    expect(harness.collabSession.close).toHaveBeenCalledOnce();
    expect(harness.pty.terminal.kill).toHaveBeenCalledOnce();
    harness.processHost.emit("exit", 0);
    expect(harness.collabSession.close).toHaveBeenCalledOnce();
  });

  it("cleans up before an external termination signal can strand an online peer", async () => {
    const harness = await createLaunchHarness();

    harness.processHost.emit("SIGHUP");

    await expect(harness.result).resolves.toBe(1);
    expect(harness.processHost.exitCode).toBe(1);
    expect(harness.collabSession.close).toHaveBeenCalledOnce();
    expect(harness.pty.terminal.kill).toHaveBeenCalledOnce();
    expect(harness.processHost.listenerCount("SIGHUP")).toBe(0);
    expect(harness.processHost.listenerCount("SIGINT")).toBe(0);
    expect(harness.processHost.listenerCount("SIGTERM")).toBe(0);
  });

  it("cleans up an orphaned launcher when its parent process disappears", async () => {
    const harness = await createLaunchHarness();
    harness.isProcessAlive.mockReturnValue(false);

    await expect(harness.result).resolves.toBe(1);
    expect(harness.isProcessAlive).toHaveBeenCalledWith(1357);
    expect(harness.collabSession.close).toHaveBeenCalledOnce();
    expect(harness.pty.terminal.kill).toHaveBeenCalledOnce();
  });
});
