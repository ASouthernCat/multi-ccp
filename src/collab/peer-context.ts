import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { resolveConfigDir } from "../core/profiles.js";
import { getProjectDir, type PathContext } from "../core/paths.js";

const MAX_SCAN_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_MESSAGES = 12;
const DEFAULT_MAX_CHARS = 12_000;

export interface ReadPeerContextOptions {
  profile: string;
  projectKey: string;
  sessionId?: string;
  maxMessages?: number;
  maxChars?: number;
  includeToolActivity?: boolean;
  context?: PathContext;
}

export interface PeerContextMessage {
  role: "user" | "assistant" | "system";
  text: string;
  timestamp?: string;
  kind?: "text" | "tool_use" | "tool_result" | "summary";
}

export interface PeerContextResult {
  found: boolean;
  profile: string;
  projectKey: string;
  sessionId?: string;
  sessionFile?: string;
  title?: string;
  lastPrompt?: string;
  updatedAt?: string;
  summary?: string;
  messages: PeerContextMessage[];
  activeFiles: string[];
  truncated: boolean;
  continuationHint?: string;
  error?: string;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value as number)));
}

function assertSafeSegment(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized === "." || normalized === ".." || normalized.includes("\0") || /[\\/]/.test(normalized)) {
    throw new Error(`Invalid ${label}.`);
  }
  return normalized;
}

function redactSecrets(value: string): string {
  return value
    .replace(/(bearer\s+)[a-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/(sk-[a-z0-9_-]{8,})/gi, "[REDACTED_API_KEY]")
    .replace(/([\"']?(?:x-)?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|local[_-]?token|password|secret|authorization|credential)[\"']?\s*[:=]\s*[\"']?)[^\s,}\"']+/gi, "$1[REDACTED]");
}

function limitText(value: string, maxChars: number): string {
  const text = redactSecrets(value).replace(/[\u0000\u001b]/g, " ").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}... [truncated]` : text;
}

function redactStructured(value: unknown, depth = 0): unknown {
  if (depth > 12 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactStructured(item, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = /api.?key|token|secret|password|authorization|credential/i.test(key)
      ? "[REDACTED]"
      : redactStructured(item, depth + 1);
  }
  return result;
}

function jsonPreview(value: unknown, maxChars = 1_800): string {
  try {
    return limitText(JSON.stringify(redactStructured(value)), maxChars);
  } catch {
    return "[unserializable]";
  }
}

function contentToText(content: unknown, includeToolActivity: boolean): { text: string; kind: PeerContextMessage["kind"] }[] {
  if (typeof content === "string") return [{ text: limitText(content, 3_000), kind: "text" }];
  if (!Array.isArray(content)) return [];

  const result: { text: string; kind: PeerContextMessage["kind"] }[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const item = block as Record<string, unknown>;
    if (item.type === "thinking" || item.type === "redacted_thinking") continue;
    if (item.type === "text" && typeof item.text === "string") {
      result.push({ text: limitText(item.text, 3_000), kind: "text" });
    } else if (includeToolActivity && item.type === "tool_use") {
      result.push({ text: `[tool_use ${String(item.name ?? "unknown")}] ${jsonPreview(item.input)}`, kind: "tool_use" });
    } else if (includeToolActivity && item.type === "tool_result") {
      result.push({ text: `[tool_result] ${typeof item.content === "string" ? limitText(item.content, 1_800) : jsonPreview(item.content)}`, kind: "tool_result" });
    }
  }
  return result;
}

function extractPaths(value: unknown, output: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) extractPaths(item, output);
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (["file_path", "filepath", "active_files"].includes(key)) {
      if (typeof item === "string") output.add(item);
      else if (Array.isArray(item)) for (const entry of item) if (typeof entry === "string") output.add(entry);
    } else if (key === "path" && typeof item === "string" && !/^https?:\/\//i.test(item)) {
      output.add(item);
    } else if (typeof item === "object") {
      extractPaths(item, output);
    }
  }
}

async function readTailLines(filePath: string): Promise<unknown[]> {
  const file = await open(filePath, "r");
  try {
    const fileStat = await file.stat();
    const length = Math.min(fileStat.size, MAX_SCAN_BYTES);
    const offset = fileStat.size - length;
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, offset);
    let text = buffer.toString("utf8");
    if (offset > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    return text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
  } finally {
    await file.close();
  }
}

async function selectSession(projectDir: string, sessionId?: string): Promise<{ filePath: string; sessionId: string } | undefined> {
  const entries = await readdir(projectDir, { withFileTypes: true }).catch(() => []);
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
  if (sessionId) {
    const safeId = assertSafeSegment(sessionId, "session id");
    const entry = files.find((candidate) => path.basename(candidate.name, ".jsonl") === safeId);
    return entry ? { filePath: path.join(projectDir, entry.name), sessionId: safeId } : undefined;
  }
  const candidates = await Promise.all(files.map(async (entry) => ({
    filePath: path.join(projectDir, entry.name),
    sessionId: path.basename(entry.name, ".jsonl"),
    modified: (await stat(path.join(projectDir, entry.name))).mtimeMs
  })));
  candidates.sort((a, b) => b.modified - a.modified);
  return candidates[0];
}

export async function readPeerContext(options: ReadPeerContextOptions): Promise<PeerContextResult> {
  const maxMessages = clamp(options.maxMessages, DEFAULT_MAX_MESSAGES, 1, 40);
  const maxChars = clamp(options.maxChars, DEFAULT_MAX_CHARS, 1_000, 30_000);
  const profile = options.profile.trim();
  const projectKey = options.projectKey.trim();
  const empty = { found: false, profile, projectKey, messages: [], activeFiles: [], truncated: false } satisfies PeerContextResult;

  try {
    assertSafeSegment(profile, "profile");
    assertSafeSegment(projectKey, "project key");
    const config = await resolveConfigDir(profile, { allowMain: false, context: options.context });
    const projectDir = getProjectDir(config.dir, projectKey);
    const selected = await selectSession(projectDir, options.sessionId);
    if (!selected) return { ...empty, error: options.sessionId ? "Requested session was not found." : "No session exists for this project." };

    const records = await readTailLines(selected.filePath);
    const messages: PeerContextMessage[] = [];
    const activeFiles = new Set<string>();
    let summary: string | undefined;
    let title: string | undefined;
    let lastPrompt: string | undefined;
    for (const record of records) {
      if (!record || typeof record !== "object") continue;
      const item = record as Record<string, unknown>;
      if ((item.type === "away_summary" || (item.type === "system" && item.subtype === "away_summary")) && typeof item.content === "string") {
        summary = limitText(item.content, 4_000);
      }
      if (item.type === "ai-title" && typeof item.aiTitle === "string") title = limitText(item.aiTitle, 200);
      if (item.type === "last-prompt" && typeof item.lastPrompt === "string") lastPrompt = limitText(item.lastPrompt, 500);
      if ((item.type !== "user" && item.type !== "assistant") || !item.message || typeof item.message !== "object") continue;
      const message = item.message as Record<string, unknown>;
      const role = message.role === "user" || message.role === "assistant" ? message.role : undefined;
      if (!role) continue;
      const parts = contentToText(message.content, options.includeToolActivity !== false);
      extractPaths(message.content, activeFiles);
      for (const part of parts) {
        if (part.text) messages.push({ role, text: part.text, kind: part.kind, ...(typeof item.timestamp === "string" ? { timestamp: item.timestamp } : {}) });
      }
    }

    const selectedMessages = messages.slice(-maxMessages);
    let usedChars = 0;
    const boundedMessages: PeerContextMessage[] = [];
    let truncated = selectedMessages.length < messages.length;
    for (const message of selectedMessages) {
      const remaining = maxChars - usedChars;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const text = limitText(message.text, remaining);
      boundedMessages.push({ ...message, text });
      usedChars += text.length;
      if (text.endsWith("[truncated]")) {
        truncated = true;
        break;
      }
    }
    return {
      found: true,
      profile,
      projectKey,
      sessionId: selected.sessionId,
      sessionFile: selected.filePath,
      title,
      updatedAt: (await stat(selected.filePath)).mtime.toISOString(),
      ...(summary ? { summary } : {}),
      ...(lastPrompt ? { lastPrompt } : {}),
      messages: boundedMessages,
      activeFiles: [...activeFiles].slice(0, 40),
      truncated,
      continuationHint: "Use this context as a handoff summary, verify the current files, then continue from the last unfinished request."
    };
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : String(error) };
  }
}
