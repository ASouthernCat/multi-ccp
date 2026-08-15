import { randomBytes } from "node:crypto";
import { access, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { assertProfileName, CcpError } from "./errors.js";
import { getMainClaudeDir, getProfilesRoot, type PathContext } from "./paths.js";
import { getSettingsPath, readMeta, readSettings, removeProfileDir, writeMeta, writeSettings } from "./settings.js";
import {
  buildGatewaySettings,
  readGatewayProfileSecret,
  writeGatewayModelCache,
  writeGatewayProfileSecret
} from "./gateway-profile.js";
import {
  readGatewayUpstreamConfig,
  readGatewayUpstreamSecret
} from "./gateway-upstreams.js";
import {
  getGatewayEndpoint,
  readGatewayRuntimeConfig
} from "../gateway/config.js";
import type {
  ClaudeSettings,
  CreateApiProfileFromEnvInput,
  CreateApiProfileInput,
  CreateLoginProfileInput,
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

async function hasProfileSettings(profileDir: string): Promise<boolean> {
  return exists(getSettingsPath(profileDir));
}

async function isEmptyDirectory(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch {
    return false;
  }
}

function createInvalidProfileDirError(name: string, dir: string): CcpError {
  return new CcpError(
    `Profile '${name}' is not a valid profile: ${getSettingsPath(dir)} is missing. Remove the stale directory with 'ccp remove ${name}' or create the profile again.`
  );
}

export async function profileExists(name: string, context: PathContext = {}): Promise<boolean> {
  assertProfileName(name);
  return hasProfileSettings(getProfileDir(name, context));
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
  if (!(await hasProfileSettings(dir))) {
    throw createInvalidProfileDirError(name, dir);
  }
  return { name, dir, isMain: false };
}

export async function resolveProfileDirForRemoval(
  name: string,
  options: { context?: PathContext } = {}
): Promise<{ name: string; dir: string; isMain: false }> {
  if (!name.trim()) {
    throw new CcpError("Missing profile name. Run 'ccp list' to see available profiles.");
  }

  const context = options.context ?? {};
  assertProfileName(name);
  const dir = getProfileDir(name, context);
  if (!(await exists(dir))) {
    throw new CcpError(`Profile '${name}' does not exist: ${dir}`);
  }
  return { name, dir, isMain: false };
}

export function inferProfileType(settings?: ClaudeSettings, meta?: ProfileMeta): ProfileType {
  const metaType = meta?.type as string | undefined;
  if (metaType === "api" || metaType === "login" || metaType === "gateway") {
    return metaType;
  }
  // Unsupported legacy meta types fall through to settings-based inference.
  if (settings?.env?.ANTHROPIC_BASE_URL || settings?.env?.ANTHROPIC_AUTH_TOKEN) {
    return "api";
  }
  return "unknown";
}

export async function summarizeProfile(
  name: string,
  dir: string,
  context: PathContext = {}
): Promise<ProfileSummary> {
  const settings = await readSettings(dir);
  const meta = await readMeta(dir);
  const type = inferProfileType(settings, meta);
  const env = settings?.env ?? {};
  const token = env.ANTHROPIC_AUTH_TOKEN ?? "";
  let model = env.ANTHROPIC_MODEL ?? "";
  const baseUrl = env.ANTHROPIC_BASE_URL ?? "";

  if (type === "login") {
    model = "login";
  } else if (type === "gateway") {
    model = meta?.gateway?.model ?? "";
  }

  const gatewaySecret = type === "gateway" ? await readGatewayProfileSecret(dir) : undefined;
  let gatewayApiKeySet = false;
  if (type === "gateway" && meta?.gateway?.upstreamId) {
    try {
      await readGatewayUpstreamSecret(meta.gateway.upstreamId, context);
      gatewayApiKeySet = true;
    } catch {
      gatewayApiKeySet = false;
    }
  }

  return {
    name,
    dir,
    type,
    baseUrl,
    model,
    tokenStatus: type === "gateway"
      ? (gatewaySecret?.localToken && gatewayApiKeySet ? "set" : "missing")
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
      profiles.push(await summarizeProfile(entry.name, dir, context));
    }
  }
  return profiles.sort((a, b) => a.name.localeCompare(b.name));
}

async function assertNewProfile(name: string, context: PathContext): Promise<string> {
  assertProfileName(name);
  const profileDir = getProfileDir(name, context);
  if (!(await exists(profileDir))) {
    return profileDir;
  }
  if (await hasProfileSettings(profileDir)) {
    throw new CcpError(`Profile '${name}' already exists: ${profileDir}`);
  }
  if (await isEmptyDirectory(profileDir)) {
    await removeProfileDir(profileDir);
    return profileDir;
  }
  throw createInvalidProfileDirError(name, profileDir);
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

export async function createGatewayProfile(
  input: CreateGatewayProfileInput,
  context: PathContext = {}
): Promise<ProfileSummary> {
  const profileDir = await assertNewProfile(input.name, context);
  const upstreamId = input.upstreamId.trim();
  const model = input.model.trim();
  if (!upstreamId) {
    throw new CcpError("Gateway upstream is required.");
  }
  if (!model) {
    throw new CcpError("Gateway model is required.");
  }
  const upstream = await readGatewayUpstreamConfig(upstreamId, context);
  if (!upstream.models.includes(model)) {
    throw new CcpError(`Gateway model '${model}' is not configured for upstream '${upstreamId}'.`);
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
    const gateway = { upstreamId, model };
    const secret: GatewayProfileSecret = {
      version: 1,
      localToken: randomBytes(32).toString("base64url")
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
    const endpoint = getGatewayEndpoint(runtimeConfig);
    await writeSettings(
      profileDir,
      buildGatewaySettings(undefined, input.name, endpoint, secret, {
        models: upstream.models,
        defaultModel: model
      })
    );
    await writeGatewayModelCache(profileDir, input.name, endpoint, upstreamId, upstream.models, model);
    return summarizeProfile(input.name, profileDir, context);
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
