import { createHash } from "node:crypto";
import { invalidRequest, upstreamProtocolError } from "./errors.js";
import type { CanonicalResponse, ToolNameMapping } from "./canonical.js";

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireObject(value: unknown, path: string): JsonObject {
  if (!isObject(value)) {
    throw upstreamProtocolError(`${path}: Expected an object in the upstream response.`);
  }
  return value;
}

export function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw upstreamProtocolError(`${path}: Expected a non-empty string in the upstream response.`);
  }
  return value;
}

export function parseArguments(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "string") {
    throw upstreamProtocolError(`${path}: Expected a JSON string.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw upstreamProtocolError(`${path}: Invalid JSON object.`, { cause: error });
  }
  if (!isObject(parsed)) {
    throw upstreamProtocolError(`${path}: Expected a JSON object.`);
  }
  return parsed;
}

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sanitizeEndpointUrlForLog(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return value;
  }
}

export function normalizeStrictJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeStrictJsonSchema);
  }
  if (!isObject(value)) {
    return value;
  }

  const result: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = normalizeStrictJsonSchema(entry);
  }
  if (result.type === "object" && isObject(result.properties)) {
    result.additionalProperties = false;
    result.required = Object.keys(result.properties);
  }
  return result;
}

export function normalizeToolCallId(sourceId: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(sourceId)) {
    return sourceId;
  }
  const replaced = sourceId.replace(/[^A-Za-z0-9_-]/g, "_") || "call";
  return `${replaced}_${digest(sourceId).slice(0, 8)}`;
}

export function toAnthropicMessageId(sourceId: string): string {
  const base = sourceId.startsWith("msg_") ? sourceId : `msg_${sourceId}`;
  return normalizeToolCallId(base);
}

function targetToolNameCandidate(sourceName: string): string {
  const hash = digest(sourceName);
  const replaced = sourceName.replace(/[^A-Za-z0-9_-]/g, "_") || "tool";
  if (replaced.length <= 64) {
    return replaced;
  }
  return `${replaced.slice(0, 55)}_${hash.slice(0, 8)}`;
}

function withCollisionSuffix(base: string, sourceName: string, used: ReadonlySet<string>): string {
  const hash = digest(sourceName);
  for (let hashLength = 8; hashLength <= 62; hashLength += 2) {
    const suffix = `_${hash.slice(0, hashLength)}`;
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
  throw invalidRequest(`tools: Unable to create a unique target name for '${sourceName}'.`);
}

export function createToolNameMapping(sourceNames: Iterable<string>): ToolNameMapping {
  const sourceToTarget = new Map<string, string>();
  const targetToSource = new Map<string, string>();

  for (const sourceName of sourceNames) {
    if (sourceToTarget.has(sourceName)) {
      continue;
    }
    let targetName = targetToolNameCandidate(sourceName);
    const existingSource = targetToSource.get(targetName);
    if (existingSource !== undefined && existingSource !== sourceName) {
      targetName = withCollisionSuffix(targetName, sourceName, new Set(targetToSource.keys()));
    }
    sourceToTarget.set(sourceName, targetName);
    targetToSource.set(targetName, sourceName);
  }

  return { sourceToTarget, targetToSource };
}

export function canonicalResponseToAnthropic(response: CanonicalResponse): Record<string, unknown> {
  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model: response.model,
    content: response.content.map((block) => block.type === "text"
      ? { type: "text", text: block.text }
      : { type: "tool_use", id: block.id, name: block.name, input: block.input }),
    stop_reason: response.finishReason,
    stop_sequence: null,
    usage: {
      input_tokens: response.usage.inputTokens,
      output_tokens: response.usage.outputTokens
    }
  };
}
