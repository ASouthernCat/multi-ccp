import type { GatewayRouteSnapshot } from "./registry.js";
import { invalidRequest } from "./errors.js";

/** Claude Code only lists model ids beginning with `claude` or `anthropic`. */
export const CCP_MODEL_ALIAS_PREFIX = "claude-ccp-";
export const CCP_MODEL_OPTION_ALIAS_PREFIX = "claude-ccp-option-";
export const CCP_DEFAULT_MODEL_ALIAS_PREFIX = "claude-ccp-default-";
/** Claude Code hot-reloads availableModels entries in this provider namespace. */
export const CCP_LIVE_MODEL_ALIAS_PREFIX = "anthropic.";
/** Legacy stable Default alias written by pre-release Gateway v4 builds. */
export const CCP_DEFAULT_MODEL_ALIAS = "claude-ccp-default";

export interface GatewayModelDiscoveryEntry {
  type: "model";
  id: string;
  display_name: string;
  created_at: string;
}

/** Encode the provider model id without introducing delimiter collisions. */
export function gatewayModelAlias(model: string): string {
  return `${CCP_MODEL_ALIAS_PREFIX}${Buffer.from(model, "utf8").toString("base64url")}`;
}

/** Keep explicit picker choices distinct from the stable Default route. */
export function gatewayModelOptionAlias(model: string): string {
  return `${CCP_MODEL_OPTION_ALIAS_PREFIX}${Buffer.from(model, "utf8").toString("base64url")}`;
}

/** Encode the current binding model so Claude Code refreshes Default's display name. */
export function gatewayDefaultModelAlias(model: string): string {
  return `${CCP_DEFAULT_MODEL_ALIAS_PREFIX}${Buffer.from(model, "utf8").toString("base64url")}`;
}

/**
 * Build readable aliases for models that were added after Claude Code cached
 * /v1/models. Avoid both configured model ids and aliases already assigned in
 * this catalog so routing remains unambiguous.
 */
export function buildGatewayLiveModelAliases(models: readonly string[]): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  const used = new Set(models);
  for (const model of models) {
    let alias = `${CCP_LIVE_MODEL_ALIAS_PREFIX}${model}`;
    if (used.has(alias)) {
      const encoded = Buffer.from(model, "utf8").toString("base64url");
      alias = `${CCP_LIVE_MODEL_ALIAS_PREFIX}ccp.${encoded}`;
      while (used.has(alias)) alias = `${CCP_LIVE_MODEL_ALIAS_PREFIX}${alias}`;
    }
    aliases.set(model, alias);
    used.add(alias);
  }
  return aliases;
}

export function gatewayLiveModelAlias(model: string, models: readonly string[]): string {
  return buildGatewayLiveModelAliases(models).get(model) ?? `${CCP_LIVE_MODEL_ALIAS_PREFIX}${model}`;
}

export function decodeGatewayLiveModelAlias(value: string, models: readonly string[]): string | undefined {
  for (const [model, alias] of buildGatewayLiveModelAliases(models)) {
    if (alias === value) return model;
  }
  return undefined;
}

export function decodeGatewayModelAlias(value: string): string | undefined {
  return decodeGatewayAlias(value, CCP_MODEL_ALIAS_PREFIX, gatewayModelAlias);
}

export function decodeGatewayModelOptionAlias(value: string): string | undefined {
  return decodeGatewayAlias(value, CCP_MODEL_OPTION_ALIAS_PREFIX, gatewayModelOptionAlias);
}

export function decodeGatewayDefaultModelAlias(value: string): string | undefined {
  return decodeGatewayAlias(value, CCP_DEFAULT_MODEL_ALIAS_PREFIX, gatewayDefaultModelAlias);
}

function decodeGatewayAlias(
  value: string,
  prefix: string,
  encode: (model: string) => string
): string | undefined {
  if (!value.startsWith(prefix)) return undefined;
  const encoded = value.slice(prefix.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined;
  try {
    const model = Buffer.from(encoded, "base64url").toString("utf8");
    return model && encode(model) === value ? model : undefined;
  } catch {
    return undefined;
  }
}

export function resolveGatewayModel(
  clientModel: string,
  snapshot: Pick<GatewayRouteSnapshot, "config" | "models">
): string {
  if (clientModel === CCP_DEFAULT_MODEL_ALIAS || decodeGatewayDefaultModelAlias(clientModel)) {
    return snapshot.config.model;
  }
  if (snapshot.models.includes(clientModel)) return clientModel;
  const decoded = decodeGatewayModelAlias(clientModel)
    ?? decodeGatewayModelOptionAlias(clientModel)
    ?? decodeGatewayLiveModelAlias(clientModel, snapshot.models);
  if (decoded && snapshot.models.includes(decoded)) return decoded;
  if (
    clientModel.startsWith(CCP_MODEL_ALIAS_PREFIX)
    || clientModel.startsWith(CCP_MODEL_OPTION_ALIAS_PREFIX)
    || clientModel.startsWith(CCP_LIVE_MODEL_ALIAS_PREFIX)
  ) {
    throw invalidRequest("model: The selected Gateway model is invalid or is no longer configured for this Upstream.");
  }
  throw invalidRequest("model: This model is not configured for the current Gateway Upstream.");
}

export function buildGatewayModelDiscovery(
  snapshot: Pick<GatewayRouteSnapshot, "upstreamId" | "models" | "config">
): GatewayModelDiscoveryEntry[] {
  return buildGatewayModelCatalog(snapshot.upstreamId, snapshot.models, snapshot.config.model);
}

export function buildGatewayModelCatalog(
  upstreamId: string,
  models: readonly string[],
  defaultModel: string
): GatewayModelDiscoveryEntry[] {
  const entry = (model: string, id: string): GatewayModelDiscoveryEntry => ({
    type: "model",
    id,
    display_name: `${model} (${upstreamId})`,
    created_at: "2026-01-01T00:00:00Z"
  });
  // Claude Code keeps model metadata in memory for the lifetime of a session.
  // Register every possible Default alias up front so a hot binding change can
  // update the Default display name without requiring a session restart.
  const defaultModels = [defaultModel, ...models.filter((model) => model !== defaultModel)];
  return [
    ...defaultModels.map((model) => entry(model, gatewayDefaultModelAlias(model))),
    ...models.map((model) => entry(model, gatewayModelOptionAlias(model)))
  ];
}
