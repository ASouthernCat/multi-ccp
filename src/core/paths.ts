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

export function getClaudeCodeRouterDir(context: PathContext = {}): string {
  return path.join(getHomeDir(context), ".claude-code-router");
}

export function getClaudeCodeRouterConfigPath(context: PathContext = {}): string {
  return path.join(getClaudeCodeRouterDir(context), "config.json");
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
