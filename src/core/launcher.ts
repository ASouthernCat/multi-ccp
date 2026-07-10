import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { CcpError } from "./errors.js";
import { getHomeDir, getHomeWorkDir, getMainClaudeDir, type PathContext } from "./paths.js";
import { resolveConfigDir } from "./profiles.js";
import { ensureCcrProfileGateway } from "./ccr.js";
import { ensureBuiltinGatewayProfile } from "./gateway-lifecycle.js";
import { readMeta } from "./settings.js";

const MODEL_ENV_NAMES = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME"
];

export interface LaunchOptions {
  name: string;
  claudeArgs?: string[];
  context?: PathContext;
  cwd?: string;
  confirmMainConfigCwd?: (details: { currentDir: string; fallbackDir: string; profileName: string }) => Promise<boolean>;
  runtimeDeps?: {
    ensureCcrProfileGateway?: typeof ensureCcrProfileGateway;
    ensureBuiltinGatewayProfile?: typeof ensureBuiltinGatewayProfile;
  };
}

function normalizePath(value: string): string {
  return path.resolve(value).replace(/[\\/]+$/, "").toLowerCase();
}

function buildLaunchEnv(profileDir: string, profileName: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of MODEL_ENV_NAMES) {
    delete env[name];
  }
  env.CLAUDE_CONFIG_DIR = profileDir;
  env.CCP_PROFILE = profileName;
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
  if (meta?.type === "ccr") {
    await (options.runtimeDeps?.ensureCcrProfileGateway ?? ensureCcrProfileGateway)(
      config.dir,
      options.name,
      options.context
    );
  } else if (meta?.type === "gateway") {
    await (options.runtimeDeps?.ensureBuiltinGatewayProfile ?? ensureBuiltinGatewayProfile)(
      config.dir,
      options.name,
      options.context
    );
  }

  return {
    command: "claude",
    args: options.claudeArgs ?? [],
    cwd: await resolveLaunchCwd(options),
    env: buildLaunchEnv(config.dir, options.name)
  };
}

export async function launchClaude(options: LaunchOptions): Promise<number> {
  const launch = await prepareClaudeLaunch(options);
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: "inherit",
      shell: process.platform === "win32"
    });

    child.on("error", (error) => {
      reject(new CcpError(`Failed to start Claude Code: ${error.message}`));
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        resolve(1);
      } else {
        resolve(code ?? 0);
      }
    });
  });
}
