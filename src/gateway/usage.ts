import type { CanonicalUsage } from "./canonical.js";
import { upstreamProtocolError } from "./errors.js";
import { isObject, type JsonObject } from "./utils.js";

type CachedUsage = Pick<CanonicalUsage, "cacheReadInputTokens" | "cacheCreationInputTokens" | "cacheMissInputTokens">;

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
 * detail objects or provider-specific dialects (DeepSeek hit/miss, Gemini metadata).
 * Preserve the numeric counters without retaining prompt data.
 */
export function parseOpenAICachedUsage(usage: JsonObject, detailsField: string): CachedUsage {
  let cacheReadInputTokens: number | undefined;
  let cacheCreationInputTokens: number | undefined;
  let cacheMissInputTokens: number | undefined;

  const rawDetails = usage[detailsField];
  if (rawDetails !== undefined && rawDetails !== null) {
    if (!isObject(rawDetails)) {
      throw upstreamProtocolError(`response.usage.${detailsField}: Expected an object.`);
    }
    cacheReadInputTokens = parseOptionalTokenCount(rawDetails, "cached_tokens", `response.usage.${detailsField}`);
    cacheCreationInputTokens = parseOptionalTokenCount(
      rawDetails,
      "cache_write_tokens",
      `response.usage.${detailsField}`
    );
  }

  // DeepSeek Chat dialect: top-level prompt_cache_hit_tokens & prompt_cache_miss_tokens
  if (usage.prompt_cache_hit_tokens !== undefined && usage.prompt_cache_hit_tokens !== null) {
    const dsHit = parseOptionalTokenCount(usage, "prompt_cache_hit_tokens", "response.usage");
    if (cacheReadInputTokens === undefined) {
      cacheReadInputTokens = dsHit;
    }
  }

  if (usage.prompt_cache_miss_tokens !== undefined && usage.prompt_cache_miss_tokens !== null) {
    cacheMissInputTokens = parseOptionalTokenCount(usage, "prompt_cache_miss_tokens", "response.usage");
  }

  // Gemini-compatible proxy dialect: usageMetadata or billing_usage.gemini_usage_metadata
  const checkGeminiMetadata = (container: unknown, path: string) => {
    if (container === undefined || container === null) return;
    if (!isObject(container)) {
      throw upstreamProtocolError(`${path}: Expected an object.`);
    }
    const geminiCached = parseOptionalTokenCount(container, "cachedContentTokenCount", path)
      ?? parseOptionalTokenCount(container, "cached_content_token_count", path);
    if (cacheReadInputTokens === undefined && geminiCached !== undefined) {
      cacheReadInputTokens = geminiCached;
    }
  };

  checkGeminiMetadata(usage.usageMetadata, "response.usage.usageMetadata");
  checkGeminiMetadata(usage.usage_metadata, "response.usage.usage_metadata");

  if (usage.billing_usage !== undefined && usage.billing_usage !== null) {
    if (!isObject(usage.billing_usage)) {
      throw upstreamProtocolError("response.usage.billing_usage: Expected an object.");
    }
    checkGeminiMetadata(usage.billing_usage.gemini_usage_metadata, "response.usage.billing_usage.gemini_usage_metadata");
    checkGeminiMetadata(usage.billing_usage.geminiUsageMetadata, "response.usage.billing_usage.geminiUsageMetadata");
  }

  return {
    ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
    ...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens }),
    ...(cacheMissInputTokens === undefined ? {} : { cacheMissInputTokens })
  };
}
