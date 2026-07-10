import { randomBytes } from "node:crypto";
import { access, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { assertProfileName, CcpError } from "./errors.js";
import { getMainClaudeDir, getProfilesRoot, type PathContext } from "./paths.js";
import { ensureCcrPreset, getCcrPresetEndpoint } from "./ccr.js";
import { getSettingsPath, readMeta, readSettings, removeProfileDir, writeMeta, writeSettings } from "./settings.js";
import {
  buildGatewaySettings,
  readGatewayProfileSecret,
  writeGatewayProfileSecret
} from "./gateway-profile.js";
import {
  getGatewayEndpoint,
  mergeGatewayCompatibility,
  normalizeChatCompletionsUrl,
  readGatewayRuntimeConfig
} from "../gateway/config.js";
import type {
  ClaudeSettings,
  CreateApiProfileFromEnvInput,
  CreateApiProfileInput,
  CreateLoginProfileInput,
  CreateCcrProfileInput,
  CreateGatewayProfileInput,
  GatewayProfileSecret,
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

  assertProfileName(name);
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
  } else if (type === "gateway") {
    model = meta?.gateway?.model ?? "";
  }

  const gatewaySecret = type === "gateway" ? await readGatewayProfileSecret(dir) : undefined;

  return {
    name,
    dir,
    type,
    baseUrl,
    model,
    tokenStatus: type === "gateway"
      ? (gatewaySecret?.apiKey ? "set" : "missing")
      : (token && token !== "REPLACE_WITH_FULL_TOKEN" ? "set" : "missing"),
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

export async function createGatewayProfile(
  input: CreateGatewayProfileInput,
  context: PathContext = {}
): Promise<ProfileSummary> {
  assertProfileName(input.name);
  const profileDir = getProfileDir(input.name, context);
  const model = input.model.trim();
  const apiKey = input.apiKey.trim();
  if (!model) {
    throw new CcpError("Gateway model is required.");
  }
  if (!apiKey) {
    throw new CcpError("Gateway API key is required.");
  }

  await mkdir(getProfilesRoot(context), { recursive: true, mode: 0o700 });
  try {
    await mkdir(profileDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CcpError(`Profile '${input.name}' already exists: ${profileDir}`);
    }
    throw error;
  }

  try {
    const gateway = {
      provider: input.provider,
      protocol: "openai_chat_completions" as const,
      chatCompletionsUrl: normalizeChatCompletionsUrl(input.chatCompletionsUrl),
      model,
      compatibility: mergeGatewayCompatibility(input.provider, input.compatibility)
    };
    const secret: GatewayProfileSecret = {
      version: 1,
      localToken: randomBytes(32).toString("base64url"),
      apiKey
    };
    const runtimeConfig = await readGatewayRuntimeConfig(context);
    await writeGatewayProfileSecret(profileDir, secret);
    await writeMeta(profileDir, {
      version: 1,
      type: "gateway",
      preset: input.preset,
      gateway,
      createdAt: new Date().toISOString()
    });
    await writeSettings(
      profileDir,
      buildGatewaySettings(undefined, input.name, getGatewayEndpoint(runtimeConfig), secret)
    );
    return summarizeProfile(input.name, profileDir);
  } catch (error) {
    await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
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
