import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { CcpError } from "./errors.js";
import type { ClaudeSettings, ProfileMeta } from "./types.js";

export const SETTINGS_FILE = "settings.json";
export const META_FILE = ".ccp.json";

export async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw.replace(/^﻿/, "")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    const reason = error instanceof Error ? ` ${error.message}` : "";
    throw new CcpError(`Failed to read JSON file: ${filePath}.${reason}`);
  }
}

export async function writeJsonFileAtomic(filePath: string, value: unknown, mode?: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      ...(mode === undefined ? {} : { mode })
    });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export function getSettingsPath(profileDir: string): string {
  return path.join(profileDir, SETTINGS_FILE);
}

export function getMetaPath(profileDir: string): string {
  return path.join(profileDir, META_FILE);
}

export async function readSettings(profileDir: string): Promise<ClaudeSettings | undefined> {
  return readJsonFile<ClaudeSettings>(getSettingsPath(profileDir));
}

export async function writeSettings(profileDir: string, settings: ClaudeSettings): Promise<void> {
  await writeJsonFileAtomic(getSettingsPath(profileDir), settings);
}

export async function readMeta(profileDir: string): Promise<ProfileMeta | undefined> {
  return readJsonFile<ProfileMeta>(getMetaPath(profileDir));
}

export async function writeMeta(profileDir: string, meta: ProfileMeta): Promise<void> {
  await writeJsonFileAtomic(getMetaPath(profileDir), meta);
}

function isTransientRemoveError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EBUSY" || code === "EACCES" || code === "ENOTEMPTY" || code === "EPERM";
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function createIncompleteRemoveError(profileDir: string): NodeJS.ErrnoException {
  const error = new Error(`Profile directory still exists after deletion: ${profileDir}`) as NodeJS.ErrnoException;
  error.code = "ENOTEMPTY";
  error.path = profileDir;
  return error;
}

interface RemoveProfileDirOptions {
  remove?: typeof rm;
  pathExists?: (target: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

export async function removeProfileDir(profileDir: string, options: RemoveProfileDirOptions = {}): Promise<void> {
  const remove = options.remove ?? rm;
  const exists = options.pathExists ?? pathExists;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = options.maxAttempts ?? (process.platform === "win32" ? 8 : 3);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await remove(profileDir, { recursive: true, force: true });
      if (!(await exists(profileDir))) {
        return;
      }
      lastError = createIncompleteRemoveError(profileDir);
    } catch (error) {
      lastError = error;
    }

    if (!isTransientRemoveError(lastError) || attempt === maxAttempts) {
      break;
    }
    await sleep(attempt * 250);
  }

  const error = lastError as NodeJS.ErrnoException;
  if (isTransientRemoveError(error)) {
    throw new CcpError(
      `Failed to delete profile completely: ${error.path ?? profileDir}. Close any Claude Code, git, or plugin processes using this profile and try again.`,
      { cause: error }
    );
  }
  throw lastError;
}
