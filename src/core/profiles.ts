import { access, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { assertProfileName, CcpError } from "./errors.js";
import { getMainClaudeDir, getProfilesRoot, type PathContext } from "./paths.js";
import { ensureCcrPreset, getCcrPresetEndpoint } from "./ccr.js";
import { getSettingsPath, readMeta, readSettings, removeProfileDir, writeMeta, writeSettings } from "./settings.js";
import type {
  ClaudeSettings,
  CreateApiProfileFromEnvInput,
  CreateApiProfileInput,
  CreateLoginProfileInput,
  CreateCcrProfileInput,
  ProfileMeta,
  ProfileSummary,
  ProfileType
} from "./types.js";

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export function getProfileDir(name: string, context: PathContext = {}): string {
  return path.join(getProfilesRoot(context), name);
}

export async function profileExists(name: string, context: PathContext = {}): Promise<boolean> {
  assertProfileName(name);
  return exists(getProfileDir(name, context));
}

export async function resolveConfigDir(
  name: string,
  options: { allowMain?: boolean; context?: PathContext } = {}
): Promise<{ name: string; dir: string; isMain: boolean }> {
  const allowMain = options.allowMain ?? true;
  const context = options.context ?? {};

  if (!name.trim()) {
    throw new CcpError("Missing profile name. Run 'ccp list' to see available profiles.");
  }

  if (allowMain && name.toLowerCase() === "main") {
    const dir = getMainClaudeDir(context);
    if (!(await exists(dir))) {
      throw new CcpError(`Main Claude config directory does not exist: ${dir}`);
    }
    return { name: "main", dir, isMain: true };
  }

  const dir = getProfileDir(name, context);
  if (!(await exists(dir))) {
    throw new CcpError(`Profile '${name}' does not exist: ${dir}`);
  }
  return { name, dir, isMain: false };
}

export function inferProfileType(settings?: ClaudeSettings, meta?: ProfileMeta): ProfileType {
  if (meta?.type) {
    return meta.type;
  }
  if (settings?.env?.ANTHROPIC_BASE_URL || settings?.env?.ANTHROPIC_AUTH_TOKEN) {
    return "api";
  }
  return "unknown";
}

export async function summarizeProfile(name: string, dir: string): Promise<ProfileSummary> {
  const settings = await readSettings(dir);
  const meta = await readMeta(dir);
  const type = inferProfileType(settings, meta);
  const env = settings?.env ?? {};
  const token = env.ANTHROPIC_AUTH_TOKEN ?? "";
  let model = env.ANTHROPIC_MODEL ?? "";
  const baseUrl = env.ANTHROPIC_BASE_URL ?? "";

  if (type === "ccr" && meta?.ccrRoute) {
    model = `ccr:${meta.ccrRoute}`;
  } else if (type === "ccr") {
    model = "ccr";
  } else if (type === "login") {
    model = "login";
  }

  return {
    name,
    dir,
    type,
    baseUrl,
    model,
    tokenStatus: token && token !== "REPLACE_WITH_FULL_TOKEN" ? "set" : "missing",
    settingsPath: getSettingsPath(dir),
    meta
  };
}

export async function listProfiles(context: PathContext = {}): Promise<ProfileSummary[]> {
  const root = getProfilesRoot(context);
  if (!(await exists(root))) {
    return [];
  }

  const entries = await readdir(root, { withFileTypes: true });
  const profiles: ProfileSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = path.join(root, entry.name);
    if (await exists(getSettingsPath(dir))) {
      profiles.push(await summarizeProfile(entry.name, dir));
    }
  }
  return profiles.sort((a, b) => a.name.localeCompare(b.name));
}

async function assertNewProfile(name: string, context: PathContext): Promise<string> {
  assertProfileName(name);
  const profileDir = getProfileDir(name, context);
  if (await exists(profileDir)) {
    throw new CcpError(`Profile '${name}' already exists: ${profileDir}`);
  }
  return profileDir;
}

export async function createApiProfile(input: CreateApiProfileInput, context: PathContext = {}): Promise<ProfileSummary> {
  const profileDir = await assertNewProfile(input.name, context);
  if (!input.baseUrl.trim()) {
    throw new CcpError("ANTHROPIC_BASE_URL is required.");
  }
  const model = input.model.trim();

  await mkdir(profileDir, { recursive: true });
  const env: ClaudeSettings["env"] = {
    ANTHROPIC_AUTH_TOKEN: input.token.trim() || "REPLACE_WITH_FULL_TOKEN",
    ANTHROPIC_BASE_URL: input.baseUrl.trim()
  };
  if (model) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
    env.ANTHROPIC_MODEL = model;
  }

  await writeSettings(profileDir, {
    theme: "dark",
    env
  });
  await writeMeta(profileDir, { version: 1, type: "api", createdAt: new Date().toISOString() });
  return summarizeProfile(input.name, profileDir);
}

export async function createApiProfileFromEnv(input: CreateApiProfileFromEnvInput, context: PathContext = {}): Promise<ProfileSummary> {
  const profileDir = await assertNewProfile(input.name, context);
  const baseUrl = input.env.ANTHROPIC_BASE_URL?.trim();
  if (!baseUrl) {
    throw new CcpError("ANTHROPIC_BASE_URL is required.");
  }

  await mkdir(profileDir, { recursive: true });
  await writeSettings(profileDir, {
    theme: "dark",
    env: { ...input.env, ANTHROPIC_BASE_URL: baseUrl }
  });
  await writeMeta(profileDir, { version: 1, type: "api", preset: input.preset, createdAt: new Date().toISOString() });
  return summarizeProfile(input.name, profileDir);
}

export async function createLoginProfile(input: CreateLoginProfileInput, context: PathContext = {}): Promise<ProfileSummary> {
  const profileDir = await assertNewProfile(input.name, context);
  await mkdir(profileDir, { recursive: true });
  await writeSettings(profileDir, { theme: "dark" });
  await writeMeta(profileDir, { version: 1, type: "login", createdAt: new Date().toISOString() });
  return summarizeProfile(input.name, profileDir);
}

export async function createCcrProfile(input: CreateCcrProfileInput, context: PathContext = {}): Promise<ProfileSummary> {
  const profileDir = await assertNewProfile(input.name, context);
  if (!input.route.trim()) {
    throw new CcpError("CCR route is required for a preset-bound CCR profile.");
  }

  const presetName = input.presetName?.trim() || input.name;
  const endpoint = await getCcrPresetEndpoint(presetName, context);
  await mkdir(profileDir, { recursive: true });
  await writeSettings(profileDir, {
    theme: "dark",
    env: {
      ANTHROPIC_BASE_URL: endpoint,
      ANTHROPIC_AUTH_TOKEN: input.token.trim() || "ccr-local-secret",
      NO_PROXY: "127.0.0.1,localhost",
      DISABLE_TELEMETRY: "1",
      DISABLE_COST_WARNINGS: "1",
      API_TIMEOUT_MS: "600000"
    }
  });
  await writeMeta(profileDir, {
    version: 1,
    type: "ccr",
    endpoint,
    autoStart: true,
    ccrPreset: presetName,
    ccrRoute: input.route.trim(),
    preset: input.presetId,
    createdAt: new Date().toISOString()
  });
  await ensureCcrPreset(presetName, input.route.trim(), context);
  return summarizeProfile(input.name, profileDir);
}

export async function removeProfile(name: string, context: PathContext = {}): Promise<string> {
  assertProfileName(name);
  const profileDir = getProfileDir(name, context);
  if (!(await exists(profileDir))) {
    throw new CcpError(`Profile '${name}' does not exist: ${profileDir}`);
  }
  await removeProfileDir(profileDir);
  return profileDir;
}
