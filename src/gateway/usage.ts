import type { CanonicalUsage } from "./canonical.js";
import { upstreamProtocolError } from "./errors.js";
import { isObject, type JsonObject } from "./utils.js";

type CachedUsage = Pick<CanonicalUsage, "cacheReadInputTokens" | "cacheCreationInputTokens">;

function parseOptionalTokenCount(value: JsonObject, field: string, path: string): number | undefined {
  const tokenCount = value[field];
  if (tokenCount === undefined || tokenCount === null) return undefined;
  if (!Number.isSafeInteger(tokenCount) || (tokenCount as number) < 0) {
    throw upstreamProtocolError(`${path}.${field}: Expected a non-negative safe integer.`);
  }
  return tokenCount as number;
}

/**
 * OpenAI-compatible providers report prompt-cache usage in protocol-specific
 * detail objects. Preserve the numeric counters without retaining prompt data.
 */
export function parseOpenAICachedUsage(usage: JsonObject, detailsField: string): CachedUsage {
  const rawDetails = usage[detailsField];
  if (rawDetails === undefined || rawDetails === null) return {};
  if (!isObject(rawDetails)) {
    throw upstreamProtocolError(`response.usage.${detailsField}: Expected an object.`);
  }
  const cacheReadInputTokens = parseOptionalTokenCount(rawDetails, "cached_tokens", `response.usage.${detailsField}`);
  const cacheCreationInputTokens = parseOptionalTokenCount(
    rawDetails,
    "cache_write_tokens",
    `response.usage.${detailsField}`
  );
  return {
    ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
    ...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens })
  };
}
