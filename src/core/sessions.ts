import { cp, mkdir, readdir, readFile, rm, stat, writeFile, copyFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { CcpError } from "./errors.js";
import { getProjectDir, getProjectKey, type PathContext } from "./paths.js";
import { resolveConfigDir } from "./profiles.js";

export type SyncStatus = "copied" | "updated" | "unchanged" | "overwritten" | "conflict";

export interface SessionDisplayInfo {
  filePath: string;
  name: string;
  sessionId: string;
  title: string;
  lastWriteTime: Date;
  relativeTime: string;
  sizeKb: number;
}

export interface SyncMetaRecord {
  source: string;
  file: string;
  lastSyncedHash: string;
  syncedAt: string;
}

export interface SyncMeta {
  version: number;
  projectKey: string;
  updatedAt?: string;
  records: Record<string, SyncMetaRecord>;
}

export interface SyncCounts {
  copied: number;
  updated: number;
  unchanged: number;
  overwritten: number;
  conflict: number;
}

export interface SyncSessionPlan {
  source: { name: string; dir: string; isMain: boolean };
  target: { name: string; dir: string; isMain: boolean };
  projectKey: string;
  sourceProjectDir: string;
  targetProjectDir: string;
  sessionFiles: SessionDisplayInfo[];
}

export interface SyncSessionOptions {
  first: string;
  args: string[];
  cwd?: string;
  context?: PathContext;
  selectSessions?: (sessions: SessionDisplayInfo[]) => Promise<SessionDisplayInfo[]>;
  confirmOverwrite?: (details: { sourceFile: string; targetFile: string }) => Promise<"yes" | "no" | "all" | "quit">;
}

export interface SyncSessionResult {
  projectKey: string;
  sourceName: string;
  targetName: string;
  sourceProjectDir: string;
  targetProjectDir: string;
  selected: number;
  counts: SyncCounts;
  conflicts: string[];
}

export interface SessionProjectInfo {
  projectKey: string;
  dir: string;
  exists: boolean;
  sessionCount: number;
  assetCount: number;
  lastWriteTime?: Date;
  relativeTime: string;
  matchedInTarget?: boolean;
}

export interface SessionProjectListResult {
  source: { name: string; dir: string; isMain: boolean };
  target: { name: string; dir: string; isMain: boolean };
  sourceProjects: SessionProjectInfo[];
  targetProjects: SessionProjectInfo[];
}

export interface SessionSyncDiffInfo extends SessionDisplayInfo {
  status: SyncStatus;
  hasAssets: boolean;
  targetExists: boolean;
  targetLastWriteTime?: Date;
}

export interface SessionProjectScanResult {
  source: { name: string; dir: string; isMain: boolean };
  target: { name: string; dir: string; isMain: boolean };
  projectKey: string;
  sourceProjectDir: string;
  targetProjectDir: string;
  targetProjectExists: boolean;
  sessions: SessionSyncDiffInfo[];
  counts: SyncCounts;
}

export type SyncProjectSessionAction = "sync" | "overwrite" | "skip";

export interface SyncProjectSessionSelection {
  name: string;
  action: SyncProjectSessionAction;
}

export interface ProjectSyncCounts extends SyncCounts {
  skipped: number;
}

export interface SyncSessionProjectResult {
  projectKey: string;
  sourceName: string;
  targetName: string;
  sourceProjectDir: string;
  targetProjectDir: string;
  selected: number;
  counts: ProjectSyncCounts;
  conflicts: string[];
  skipped: string[];
}

export interface DeleteSessionProjectResult {
  sourceName: string;
  projectKey: string;
  projectDir: string;
  removed: boolean;
}

export interface DeleteSessionProjectSessionResult {
  sourceName: string;
  projectKey: string;
  projectDir: string;
  sessionName: string;
  sessionFile: string;
  assetDir: string;
  removedSession: boolean;
  removedAssets: boolean;
}

function parseSyncArgs(first: string, args: string[]): { sourceName: string; targetName: string; syncAll: boolean } {
  if (!first?.trim()) {
    throw new CcpError("Missing sync target. Use 'ccp sync-session <target-profile>' or 'ccp sync-session <source> to <target>'.");
  }

  const syncArgs: string[] = [];
  let syncAll = false;
  for (const arg of args) {
    if (arg === "--all") {
      syncAll = true;
    } else {
      syncArgs.push(arg);
    }
  }

  if (syncArgs.length === 0) {
    return { sourceName: "main", targetName: first, syncAll };
  }
  if (syncArgs.length === 2 && syncArgs[0].toLowerCase() === "to") {
    return { sourceName: first, targetName: syncArgs[1], syncAll };
  }

  throw new CcpError("Invalid sync syntax. Use 'ccp sync-session <target-profile>' or 'ccp sync-session <source> to <target>'.");
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function fileSha256(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  hash.update(await readFile(filePath));
  return hash.digest("hex");
}

function syncMetaPath(targetConfigDir: string, projectKey: string): string {
  return path.join(targetConfigDir, ".ccp-sync", `${projectKey}.json`);
}

async function readSyncMeta(metaPath: string, projectKey: string): Promise<SyncMeta> {
  if (!(await exists(metaPath))) {
    return { version: 1, projectKey, records: {} };
  }
  const raw = JSON.parse((await readFile(metaPath, "utf8")).replace(/^﻿/, "")) as Partial<SyncMeta>;
  return {
    version: 1,
    projectKey,
    updatedAt: raw.updatedAt,
    records: raw.records ?? {}
  };
}

async function writeSyncMeta(metaPath: string, meta: SyncMeta): Promise<void> {
  const records = Object.fromEntries(Object.entries(meta.records).sort(([a], [b]) => a.localeCompare(b)));
  const data: SyncMeta = {
    version: 1,
    projectKey: meta.projectKey,
    updatedAt: new Date().toISOString(),
    records
  };
  await mkdir(path.dirname(metaPath), { recursive: true });
  await writeFile(metaPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function copySessionAssetsMissingOnly(sourceProjectDir: string, targetProjectDir: string, sessionName: string): Promise<void> {
  const sourceAssetDir = path.join(sourceProjectDir, sessionName);
  if (!(await exists(sourceAssetDir))) {
    return;
  }
  const targetAssetDir = path.join(targetProjectDir, sessionName);
  await cp(sourceAssetDir, targetAssetDir, {
    recursive: true,
    force: false,
    errorOnExist: false
  });
}

function assertSafeProjectKey(projectKey: string): string {
  const key = projectKey.trim();
  if (!key) throw new CcpError("Project key is required.");
  if (key === "." || key === ".." || key.includes("\0") || /[\\/]/.test(key)) {
    throw new CcpError("Invalid project key.");
  }
  return key;
}

function assertSafeSessionName(sessionName: string): string {
  const name = sessionName.trim();
  const sessionId = path.basename(name, ".jsonl");
  if (!name || !name.endsWith(".jsonl") || !sessionId || sessionId === "." || sessionId === ".." || name.includes("\0") || /[\\/]/.test(name)) {
    throw new CcpError("Invalid session name.");
  }
  return name;
}

function resolveChildPath(parent: string, child: string, label: string): string {
  const parentPath = path.resolve(parent);
  const childPath = path.resolve(child);
  const relative = path.relative(parentPath, childPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new CcpError(`${label} is outside the expected directory.`);
  }
  return childPath;
}

function projectDirInConfig(configDir: string, projectKey: string): string {
  const projectsRoot = path.join(configDir, "projects");
  return resolveChildPath(projectsRoot, path.join(projectsRoot, assertSafeProjectKey(projectKey)), "Project path");
}

function sessionFileInProject(projectDir: string, sessionName: string): string {
  return resolveChildPath(projectDir, path.join(projectDir, assertSafeSessionName(sessionName)), "Session path");
}

async function getProjectSessionFiles(projectDir: string): Promise<SessionDisplayInfo[]> {
  if (!(await exists(projectDir))) {
    return [];
  }

  const entries = await readdir(projectDir, { withFileTypes: true });
  const jsonlFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(projectDir, entry.name))
    .sort((a, b) => a.localeCompare(b));

  const sessionFiles = await Promise.all(jsonlFiles.map(getSessionDisplayInfo));
  sessionFiles.sort((a, b) => b.lastWriteTime.getTime() - a.lastWriteTime.getTime());
  return sessionFiles;
}

async function countProjectAssets(projectDir: string): Promise<number> {
  if (!(await exists(projectDir))) {
    return 0;
  }
  const entries = await readdir(projectDir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).length;
}

async function listProjectsInConfig(configDir: string): Promise<SessionProjectInfo[]> {
  const projectsDir = path.join(configDir, "projects");
  if (!(await exists(projectsDir))) {
    return [];
  }

  const entries = await readdir(projectsDir, { withFileTypes: true });
  const projects = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry): Promise<SessionProjectInfo> => {
      const dir = path.join(projectsDir, entry.name);
      const sessions = await getProjectSessionFiles(dir);
      const assetCount = await countProjectAssets(dir);
      const lastWriteTime = sessions[0]?.lastWriteTime;
      return {
        projectKey: entry.name,
        dir,
        exists: true,
        sessionCount: sessions.length,
        assetCount,
        lastWriteTime,
        relativeTime: lastWriteTime ? relativeTime(lastWriteTime) : "no sessions"
      };
    }));

  return projects.sort((a, b) => {
    const aTime = a.lastWriteTime?.getTime() ?? 0;
    const bTime = b.lastWriteTime?.getTime() ?? 0;
    return bTime - aTime || a.projectKey.localeCompare(b.projectKey);
  });
}

async function getSessionDiffStatus(
  sourceFile: string,
  targetFile: string,
  meta: SyncMeta,
  metaKey: string
): Promise<{ status: SyncStatus; targetExists: boolean; targetLastWriteTime?: Date }> {
  const sourceHash = await fileSha256(sourceFile);
  if (!(await exists(targetFile))) {
    return { status: "copied", targetExists: false };
  }

  const targetFileStat = await stat(targetFile);
  const targetHash = await fileSha256(targetFile);
  if (sourceHash === targetHash) {
    return { status: "unchanged", targetExists: true, targetLastWriteTime: targetFileStat.mtime };
  }

  const existingRecord = meta.records[metaKey];
  if (existingRecord?.lastSyncedHash && targetHash === existingRecord.lastSyncedHash) {
    return { status: "updated", targetExists: true, targetLastWriteTime: targetFileStat.mtime };
  }

  return { status: "conflict", targetExists: true, targetLastWriteTime: targetFileStat.mtime };
}

async function syncSessionFile(
  sourceFile: string,
  targetFile: string,
  meta: SyncMeta,
  metaKey: string,
  sourceName: string,
  forceOverwrite = false
): Promise<SyncStatus> {
  const sourceHash = await fileSha256(sourceFile);
  const sourceNameOnly = path.basename(sourceFile);

  const record = () => {
    meta.records[metaKey] = {
      source: sourceName,
      file: sourceNameOnly,
      lastSyncedHash: sourceHash,
      syncedAt: new Date().toISOString()
    };
  };

  if (!(await exists(targetFile))) {
    await copyFile(sourceFile, targetFile);
    record();
    return "copied";
  }

  const targetHash = await fileSha256(targetFile);
  const existingRecord = meta.records[metaKey];

  if (sourceHash === targetHash) {
    record();
    return "unchanged";
  }

  if (forceOverwrite) {
    await copyFile(sourceFile, targetFile);
    record();
    return "overwritten";
  }

  if (!existingRecord?.lastSyncedHash) {
    return "conflict";
  }

  if (targetHash === existingRecord.lastSyncedHash) {
    await copyFile(sourceFile, targetFile);
    record();
    return "updated";
  }

  return "conflict";
}

function getPlainSessionText(text: string): string {
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function getSessionUserTitleCandidate(content: unknown): string {
  if (typeof content !== "string") {
    return "";
  }
  if (content.includes("<local-command-caveat>") || content.includes("<local-command-stdout>")) {
    return "";
  }
  const commandName = content.match(/<command-name>\s*([\s\S]*?)\s*<\/command-name>/);
  if (commandName) {
    return getPlainSessionText(commandName[1]);
  }
  return getPlainSessionText(content);
}

function limitSessionTitle(title: string): string {
  const plain = getPlainSessionText(title);
  if (!plain) return "";
  return plain.length <= 120 ? plain : `${plain.slice(0, 120)}...`;
}

function relativeTime(time: Date): string {
  const seconds = Math.max(0, Math.floor((Date.now() - time.getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return days === 1 ? "1 day ago" : `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "1 month ago" : `${months} months ago`;
}

async function getSessionDisplayInfo(filePath: string): Promise<SessionDisplayInfo> {
  const fileStat = await stat(filePath);
  let aiTitle = "";
  let lastPrompt = "";
  let firstUserTitle = "";

  try {
    const lines = (await readFile(filePath, "utf8")).split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as { type?: string; aiTitle?: string; lastPrompt?: string; message?: { content?: unknown } };
        if (obj.type === "ai-title" && obj.aiTitle) {
          aiTitle = limitSessionTitle(obj.aiTitle);
        } else if (obj.type === "last-prompt" && obj.lastPrompt) {
          lastPrompt = limitSessionTitle(obj.lastPrompt);
        } else if (obj.type === "user" && obj.message?.content && !firstUserTitle) {
          firstUserTitle = limitSessionTitle(getSessionUserTitleCandidate(obj.message.content));
        }
      } catch {
        // Ignore malformed lines in session logs.
      }
    }
  } catch {
    // Fall back to generic title if the log cannot be read.
  }

  const title = aiTitle || lastPrompt || firstUserTitle || "(session)";
  const name = path.basename(filePath);
  const sessionId = path.basename(filePath, path.extname(filePath));
  return {
    filePath,
    name,
    sessionId,
    title,
    lastWriteTime: fileStat.mtime,
    relativeTime: relativeTime(fileStat.mtime),
    sizeKb: Math.round((fileStat.size / 1024) * 10) / 10
  };
}

export function parseSelectionText(text: string, max: number): number[] {
  const indexes: number[] = [];
  const tokens = text.split(/[,\s]+/).filter(Boolean);
  for (const token of tokens) {
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start > end) throw new CcpError(`Invalid range '${token}'.`);
      for (let i = start; i <= end; i++) {
        if (i < 1 || i > max) throw new CcpError(`Selection '${i}' is out of range.`);
        if (!indexes.includes(i - 1)) indexes.push(i - 1);
      }
      continue;
    }

    if (!/^\d+$/.test(token)) {
      throw new CcpError(`Invalid selection token '${token}'.`);
    }
    const index = Number(token);
    if (index < 1 || index > max) throw new CcpError(`Selection '${index}' is out of range.`);
    if (!indexes.includes(index - 1)) indexes.push(index - 1);
  }
  return indexes;
}

export async function planSyncSession(options: SyncSessionOptions): Promise<SyncSessionPlan & { syncAll: boolean }> {
  const parsed = parseSyncArgs(options.first, options.args);
  const source = await resolveConfigDir(parsed.sourceName, { allowMain: true, context: options.context });
  const target = await resolveConfigDir(parsed.targetName, { allowMain: true, context: options.context });

  if (source.dir.toLowerCase() === target.dir.toLowerCase()) {
    return {
      source,
      target,
      projectKey: getProjectKey(options.cwd ?? options.context?.cwd ?? process.cwd()),
      sourceProjectDir: "",
      targetProjectDir: "",
      sessionFiles: [],
      syncAll: parsed.syncAll
    };
  }

  const projectKey = getProjectKey(options.cwd ?? options.context?.cwd ?? process.cwd());
  const sourceProjectDir = getProjectDir(source.dir, projectKey);
  const targetProjectDir = getProjectDir(target.dir, projectKey);

  if (!(await exists(sourceProjectDir))) {
    return { source, target, projectKey, sourceProjectDir, targetProjectDir, sessionFiles: [], syncAll: parsed.syncAll };
  }

  const sessionFiles = await getProjectSessionFiles(sourceProjectDir);

  return { source, target, projectKey, sourceProjectDir, targetProjectDir, sessionFiles, syncAll: parsed.syncAll };
}

export async function listSessionProjects(options: { sourceName: string; targetName: string; context?: PathContext }): Promise<SessionProjectListResult> {
  const source = await resolveConfigDir(options.sourceName, { allowMain: true, context: options.context });
  const target = await resolveConfigDir(options.targetName, { allowMain: true, context: options.context });
  if (source.dir.toLowerCase() === target.dir.toLowerCase()) {
    throw new CcpError("Source and target must be different profiles.");
  }

  const [sourceProjects, targetProjects] = await Promise.all([
    listProjectsInConfig(source.dir),
    listProjectsInConfig(target.dir)
  ]);
  const targetKeys = new Set(targetProjects.map((project) => project.projectKey));

  return {
    source,
    target,
    sourceProjects: sourceProjects.map((project) => ({ ...project, matchedInTarget: targetKeys.has(project.projectKey) })),
    targetProjects
  };
}

export async function scanSessionProject(options: {
  sourceName: string;
  targetName: string;
  projectKey: string;
  context?: PathContext;
}): Promise<SessionProjectScanResult> {
  const source = await resolveConfigDir(options.sourceName, { allowMain: true, context: options.context });
  const target = await resolveConfigDir(options.targetName, { allowMain: true, context: options.context });
  if (source.dir.toLowerCase() === target.dir.toLowerCase()) {
    throw new CcpError("Source and target must be different profiles.");
  }

  const projectKey = assertSafeProjectKey(options.projectKey);

  const sourceProjectDir = projectDirInConfig(source.dir, projectKey);
  const targetProjectDir = projectDirInConfig(target.dir, projectKey);
  const sessionFiles = await getProjectSessionFiles(sourceProjectDir);
  const meta = await readSyncMeta(syncMetaPath(target.dir, projectKey), projectKey);
  const sessions = await Promise.all(sessionFiles.map(async (session): Promise<SessionSyncDiffInfo> => {
    const targetFile = path.join(targetProjectDir, session.name);
    const metaKey = `${source.name}|${session.name}`;
    const diff = await getSessionDiffStatus(session.filePath, targetFile, meta, metaKey);
    return {
      ...session,
      status: diff.status,
      hasAssets: await exists(path.join(sourceProjectDir, session.sessionId)),
      targetExists: diff.targetExists,
      targetLastWriteTime: diff.targetLastWriteTime
    };
  }));

  const counts: SyncCounts = { copied: 0, updated: 0, unchanged: 0, overwritten: 0, conflict: 0 };
  for (const session of sessions) {
    counts[session.status]++;
  }

  return {
    source,
    target,
    projectKey,
    sourceProjectDir,
    targetProjectDir,
    targetProjectExists: await exists(targetProjectDir),
    sessions,
    counts
  };
}

export async function deleteSessionProject(options: {
  sourceName: string;
  projectKey: string;
  context?: PathContext;
}): Promise<DeleteSessionProjectResult> {
  const source = await resolveConfigDir(options.sourceName, { allowMain: true, context: options.context });
  const projectKey = assertSafeProjectKey(options.projectKey);
  const projectDir = projectDirInConfig(source.dir, projectKey);
  const removed = await exists(projectDir);
  await rm(projectDir, { recursive: true, force: true });
  return {
    sourceName: source.name,
    projectKey,
    projectDir,
    removed
  };
}

export async function deleteSessionProjectSession(options: {
  sourceName: string;
  projectKey: string;
  sessionName: string;
  context?: PathContext;
}): Promise<DeleteSessionProjectSessionResult> {
  const source = await resolveConfigDir(options.sourceName, { allowMain: true, context: options.context });
  const projectKey = assertSafeProjectKey(options.projectKey);
  const sessionName = assertSafeSessionName(options.sessionName);
  const projectDir = projectDirInConfig(source.dir, projectKey);
  const sessionFile = sessionFileInProject(projectDir, sessionName);
  const assetDir = resolveChildPath(projectDir, path.join(projectDir, path.basename(sessionName, ".jsonl")), "Session asset path");
  const removedSession = await exists(sessionFile);
  const removedAssets = await exists(assetDir);

  await rm(sessionFile, { force: true });
  await rm(assetDir, { recursive: true, force: true });

  return {
    sourceName: source.name,
    projectKey,
    projectDir,
    sessionName,
    sessionFile,
    assetDir,
    removedSession,
    removedAssets
  };
}

export async function syncSessionProject(options: {
  sourceName: string;
  targetName: string;
  projectKey: string;
  selections: SyncProjectSessionSelection[];
  context?: PathContext;
}): Promise<SyncSessionProjectResult> {
  const scan = await scanSessionProject(options);
  const selectionsByName = new Map(options.selections.map((selection) => [selection.name, selection.action]));
  const selectedSessions = scan.sessions.filter((session) => selectionsByName.has(session.name));
  const counts: ProjectSyncCounts = { copied: 0, updated: 0, unchanged: 0, overwritten: 0, conflict: 0, skipped: 0 };
  const conflicts: string[] = [];
  const skipped: string[] = [];

  await mkdir(scan.targetProjectDir, { recursive: true });
  const metaPath = syncMetaPath(scan.target.dir, scan.projectKey);
  const meta = await readSyncMeta(metaPath, scan.projectKey);

  for (const session of [...selectedSessions].sort((a, b) => a.name.localeCompare(b.name))) {
    const action = selectionsByName.get(session.name) ?? "skip";
    if (action === "skip") {
      counts.skipped++;
      skipped.push(session.name);
      continue;
    }

    const targetFile = path.join(scan.targetProjectDir, session.name);
    const metaKey = `${scan.source.name}|${session.name}`;
    let status = await syncSessionFile(session.filePath, targetFile, meta, metaKey, scan.source.name, action === "overwrite");

    if (status === "conflict" && action === "overwrite") {
      status = await syncSessionFile(session.filePath, targetFile, meta, metaKey, scan.source.name, true);
    }

    counts[status]++;
    if (status !== "conflict") {
      await copySessionAssetsMissingOnly(scan.sourceProjectDir, scan.targetProjectDir, session.sessionId);
    } else {
      conflicts.push(session.name);
    }
  }

  await writeSyncMeta(metaPath, meta);

  return {
    projectKey: scan.projectKey,
    sourceName: scan.source.name,
    targetName: scan.target.name,
    sourceProjectDir: scan.sourceProjectDir,
    targetProjectDir: scan.targetProjectDir,
    selected: selectedSessions.length,
    counts,
    conflicts,
    skipped
  };
}

export async function syncSessions(options: SyncSessionOptions): Promise<SyncSessionResult | undefined> {
  const plan = await planSyncSession(options);

  if (plan.source.dir.toLowerCase() === plan.target.dir.toLowerCase()) {
    console.log(`Source and target are the same config: ${plan.source.name}. Nothing to sync.`);
    return undefined;
  }

  if (!plan.sourceProjectDir || plan.sessionFiles.length === 0) {
    console.log("No source session logs for current project.");
    console.log(`Project: ${plan.projectKey}`);
    console.log(`Source:  ${plan.sourceProjectDir}`);
    return undefined;
  }

  const selectedFiles = plan.syncAll
    ? plan.sessionFiles
    : await options.selectSessions?.(plan.sessionFiles) ?? [];

  if (selectedFiles.length === 0) {
    console.log("Sync cancelled.");
    return undefined;
  }

  await mkdir(plan.targetProjectDir, { recursive: true });
  const metaPath = syncMetaPath(plan.target.dir, plan.projectKey);
  const meta = await readSyncMeta(metaPath, plan.projectKey);
  const counts: SyncCounts = { copied: 0, updated: 0, unchanged: 0, overwritten: 0, conflict: 0 };
  const conflicts: string[] = [];
  let overwriteAll = false;

  for (const session of [...selectedFiles].sort((a, b) => a.name.localeCompare(b.name))) {
    const targetFile = path.join(plan.targetProjectDir, session.name);
    const metaKey = `${plan.source.name}|${session.name}`;
    let status = await syncSessionFile(session.filePath, targetFile, meta, metaKey, plan.source.name);

    if (status === "conflict") {
      if (!overwriteAll) {
        const answer = await options.confirmOverwrite?.({ sourceFile: session.filePath, targetFile }) ?? "no";
        if (answer === "quit") {
          throw new CcpError("Sync cancelled by user.");
        }
        if (answer === "all") {
          overwriteAll = true;
        }
        if (answer === "yes" || answer === "all") {
          status = await syncSessionFile(session.filePath, targetFile, meta, metaKey, plan.source.name, true);
        }
      } else {
        status = await syncSessionFile(session.filePath, targetFile, meta, metaKey, plan.source.name, true);
      }
    }

    counts[status]++;
    if (status !== "conflict") {
      await copySessionAssetsMissingOnly(plan.sourceProjectDir, plan.targetProjectDir, session.sessionId);
    } else {
      conflicts.push(session.name);
    }
  }

  await writeSyncMeta(metaPath, meta);

  return {
    projectKey: plan.projectKey,
    sourceName: plan.source.name,
    targetName: plan.target.name,
    sourceProjectDir: plan.sourceProjectDir,
    targetProjectDir: plan.targetProjectDir,
    selected: selectedFiles.length,
    counts,
    conflicts
  };
}
