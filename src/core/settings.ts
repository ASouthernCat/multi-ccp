import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CcpError } from "./errors.js";
import type { ClaudeSettings, ProfileMeta } from "./types.js";

export const SETTINGS_FILE = "settings.json";
export const META_FILE = ".ccp.json";

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
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

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
  await writeJsonFile(getSettingsPath(profileDir), settings);
}

export async function readMeta(profileDir: string): Promise<ProfileMeta | undefined> {
  return readJsonFile<ProfileMeta>(getMetaPath(profileDir));
}

export async function writeMeta(profileDir: string, meta: ProfileMeta): Promise<void> {
  await writeJsonFile(getMetaPath(profileDir), meta);
}

export async function removeProfileDir(profileDir: string): Promise<void> {
  await rm(profileDir, { recursive: true, force: true });
}
