import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn as spawnPty } from "node-pty";
import { CcpError } from "./errors.js";
import { getHomeDir, getHomeWorkDir, getMainClaudeDir, getProjectKey, type PathContext } from "./paths.js";
import { resolveConfigDir } from "./profiles.js";
import { ensureBuiltinGatewayProfile, startGateway } from "./gateway-lifecycle.js";
import { readMeta } from "./settings.js";
import { applyGatewayContextPolicy } from "./gateway-claude.js";
import { ensureProfileCollabConfig } from "../collab/profile-collab.js";
import { createCollabTerminalSession } from "../collab/pty-activator.js";

const PARENT_PROCESS_CHECK_INTERVAL_MS = 2_000;

const MODEL_ENV_NAMES = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES",
  "CLAUDE_CODE_SUBAGENT_MODEL"
];

export interface LaunchOptions {
  name: string;
  claudeArgs?: string[];
  context?: PathContext;
  cwd?: string;
  confirmMainConfigCwd?: (details: { currentDir: string; fallbackDir: string; profileName: string }) => Promise<boolean>;
  runtimeDeps?: {
    ensureBuiltinGatewayProfile?: typeof ensureBuiltinGatewayProfile;
    startGateway?: typeof startGateway;
    ensureProfileCollabConfig?: typeof ensureProfileCollabConfig;
    spawnPty?: typeof spawnPty;
    createCollabTerminalSession?: typeof createCollabTerminalSession;
    processHost?: LauncherProcessHost;
    isProcessAlive?: (pid: number) => boolean;
    parentProcessCheckIntervalMs?: number;
  };
}

interface LauncherProcessHost {
  pid?: number;
  ppid?: number;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  exitCode?: number;
  once(event: "exit", listener: (code: number) => void): unknown;
  once(event: NodeJS.Signals, listener: () => void): unknown;
  off(event: "exit", listener: (code: number) => void): unknown;
  off(event: NodeJS.Signals, listener: () => void): unknown;
}

function normalizePath(value: string): string {
  return path.resolve(value).replace(/[\\/]+$/, "").toLowerCase();
}

async function resolveExecutable(command: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) return command;

  const pathValue = env.PATH ?? env.Path ?? "";
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];

  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, process.platform === "win32" ? `${command}${extension.toLowerCase()}` : command);
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Try the next PATH entry.
      }
    }
  }

  return command;
}

function buildLaunchEnv(profileDir: string, profileName: string, gatewayProfile: boolean): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of MODEL_ENV_NAMES) {
    delete env[name];
  }
  env.CLAUDE_CONFIG_DIR = profileDir;
  env.CCP_PROFILE = profileName;
  env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = "1";
  if (gatewayProfile) {
    applyGatewayContextPolicy(env);
  }
  return env;
}

async function resolveLaunchCwd(options: LaunchOptions): Promise<string> {
  const context = options.context ?? {};
  const currentDir = options.cwd ?? context.cwd ?? process.cwd();
  const homeDir = getHomeDir(context);
  const mainDir = getMainClaudeDir(context);

  if (normalizePath(currentDir) !== normalizePath(homeDir) && normalizePath(currentDir) !== normalizePath(mainDir)) {
    return currentDir;
  }

  const fallbackDir = getHomeWorkDir(context);
  const ok = await options.confirmMainConfigCwd?.({ currentDir, fallbackDir, profileName: options.name });
  if (!ok) {
    throw new CcpError("Cancelled.");
  }
  await mkdir(fallbackDir, { recursive: true });
  return fallbackDir;
}

export async function prepareClaudeLaunch(options: LaunchOptions): Promise<{
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}> {
  const config = await resolveConfigDir(options.name, { allowMain: false, context: options.context });
  const meta = await readMeta(config.dir);
  if (meta?.type === "gateway") {
    await (options.runtimeDeps?.ensureBuiltinGatewayProfile ?? ensureBuiltinGatewayProfile)(
      config.dir,
      options.name,
      options.context
    );
  }

  // Automatically ensure profile has Collab MCP server, approved tools, and skill configured
  await (options.runtimeDeps?.ensureProfileCollabConfig ?? ensureProfileCollabConfig)(
    config.dir,
    options.name
  );

  return {
    command: "claude",
    args: options.claudeArgs ?? [],
    cwd: await resolveLaunchCwd(options),
    env: buildLaunchEnv(config.dir, options.name, meta?.type === "gateway")
  };
}

export async function launchClaude(options: LaunchOptions): Promise<number> {
  const launch = await prepareClaudeLaunch(options);
  const projectKey = getProjectKey(launch.cwd);
  const processHost = options.runtimeDeps?.processHost ?? process;
  const launcherPid = processHost.pid ?? process.pid;
  const parentPid = processHost.ppid ?? process.ppid;
  const peerId = `${options.name}:${launcherPid}`;
  launch.env.CCP_PEER_ID = peerId;

  let terminal;
  try {
    const command = await resolveExecutable(launch.command, launch.env);
    terminal = (options.runtimeDeps?.spawnPty ?? spawnPty)(command, launch.args, {
      name: process.env.TERM || "xterm-256color",
      cols: processHost.stdout.columns || 120,
      rows: processHost.stdout.rows || 30,
      cwd: launch.cwd,
      env: launch.env,
      useConpty: process.platform === "win32"
    });
  } catch (error) {
    throw new CcpError(`Failed to start Claude Code: ${error instanceof Error ? error.message : String(error)}`);
  }

  const collabSession = (options.runtimeDeps?.createCollabTerminalSession ?? createCollabTerminalSession)({
    profile: options.name,
    peerId,
    projectKey,
    projectDir: launch.cwd,
    gatewayEndpoint: "http://127.0.0.1:3921",
    ownerPid: launcherPid,
    childStdin: {
      write(chunk) {
        terminal.write(chunk);
        return true;
      }
    }
  });

  const previousRawMode = processHost.stdin.isTTY ? processHost.stdin.isRaw : undefined;
  if (processHost.stdin.isTTY) processHost.stdin.setRawMode(true);

  const onInput = (chunk: Buffer | string) => {
    collabSession.reportActivity("input");
    terminal.write(chunk);
  };
  const onResize = () => terminal.resize(processHost.stdout.columns || 120, processHost.stdout.rows || 30);
  processHost.stdin.on("data", onInput);
  processHost.stdout.on("resize", onResize);
  processHost.stdin.resume();

  const dataDisposable = terminal.onData((data) => {
    collabSession.reportActivity("output");
    processHost.stdout.write(data);
  });

  return new Promise((resolve) => {
    let settled = false;
    let cleaned = false;
    let exitDisposable: { dispose(): void } | undefined;
    let parentMonitor: NodeJS.Timeout | undefined;
    const terminationSignals: NodeJS.Signals[] = ["SIGHUP", "SIGINT", "SIGTERM"];

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      processHost.off("exit", onProcessExit);
      terminationSignals.forEach((signal) => processHost.off(signal, onSignal));
      processHost.stdin.off("end", onStdinClosed);
      processHost.stdin.off("close", onStdinClosed);
      processHost.stdin.off("data", onInput);
      processHost.stdout.off("resize", onResize);
      if (parentMonitor) clearInterval(parentMonitor);
      exitDisposable?.dispose();
      dataDisposable.dispose();
      collabSession.close();
      try {
        terminal.kill();
      } catch {
        // The PTY process may already be fully closed.
      }
      if (processHost.stdin.isTTY) processHost.stdin.setRawMode(previousRawMode ?? false);
      processHost.stdin.pause();
    };

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(exitCode);
    };

    const onProcessExit = () => finish(1);
    const onSignal = () => {
      processHost.exitCode = 1;
      finish(1);
    };
    const onStdinClosed = () => finish(1);
    const isProcessAlive = options.runtimeDeps?.isProcessAlive ?? ((pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
        return false;
      }
    });

    processHost.once("exit", onProcessExit);
    terminationSignals.forEach((signal) => processHost.once(signal, onSignal));
    processHost.stdin.once("end", onStdinClosed);
    processHost.stdin.once("close", onStdinClosed);
    exitDisposable = terminal.onExit(({ exitCode }) => finish(exitCode));
    if (parentPid > 0 && parentPid !== launcherPid) {
      parentMonitor = setInterval(() => {
        if (!isProcessAlive(parentPid)) finish(1);
      }, options.runtimeDeps?.parentProcessCheckIntervalMs ?? PARENT_PROCESS_CHECK_INTERVAL_MS);
      parentMonitor.unref?.();
    }
  });
}
