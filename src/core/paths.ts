import { homedir, platform } from "node:os";
import path from "node:path";

export interface PathContext {
  homeDir?: string;
  cwd?: string;
}

export function getHomeDir(context: PathContext = {}): string {
  return context.homeDir ?? homedir();
}

export function getProfilesRoot(context: PathContext = {}): string {
  return path.join(getHomeDir(context), ".claude-profiles");
}

export function getMainClaudeDir(context: PathContext = {}): string {
  return path.join(getHomeDir(context), ".claude");
}

export function getHomeWorkDir(context: PathContext = {}): string {
  return path.join(getProfilesRoot(context), ".workdirs", "home");
}

export function getGatewayDir(context: PathContext = {}): string {
  return path.join(getProfilesRoot(context), ".gateway");
}

export function getGatewayConfigPath(context: PathContext = {}): string {
  return path.join(getGatewayDir(context), "config.json");
}

export function getGatewayRuntimePath(context: PathContext = {}): string {
  return path.join(getGatewayDir(context), "runtime.json");
}

export function getGatewayLogPath(context: PathContext = {}): string {
  return path.join(getGatewayDir(context), "gateway.log");
}

export function getGatewayGeneratedDir(context: PathContext = {}): string {
  return path.join(getGatewayDir(context), "generated");
}

export function getGatewayStartupLockPath(context: PathContext = {}): string {
  return path.join(getGatewayDir(context), "startup.lock");
}

export function getGatewayUpstreamsDir(context: PathContext = {}): string {
  return path.join(getGatewayDir(context), "upstreams");
}

export function getGatewayUpstreamSecretsDir(context: PathContext = {}): string {
  return path.join(getGatewayDir(context), "secrets");
}

export function getProjectKey(projectPath = process.cwd()): string {
  const resolved = path.resolve(projectPath).replace(/[\\/]+$/, "");
  return resolved.replace(/:/g, "-").replace(/[\\/]/g, "-");
}

export function getProjectDir(configDir: string, projectKey: string): string {
  return path.join(configDir, "projects", projectKey);
}

export function isWindows(): boolean {
  return platform() === "win32";
}
