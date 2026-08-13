import type { GatewayRouteSnapshot } from "./registry.js";
import { invalidRequest } from "./errors.js";

/** Claude Code only lists model ids beginning with `claude` or `anthropic`. */
export const CCP_MODEL_ALIAS_PREFIX = "claude-ccp-";

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

export function decodeGatewayModelAlias(value: string): string | undefined {
  if (!value.startsWith(CCP_MODEL_ALIAS_PREFIX)) return undefined;
  const encoded = value.slice(CCP_MODEL_ALIAS_PREFIX.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined;
  try {
    const model = Buffer.from(encoded, "base64url").toString("utf8");
    return model && gatewayModelAlias(model) === value ? model : undefined;
  } catch {
    return undefined;
  }
}

export function resolveGatewayModel(
  clientModel: string,
  snapshot: Pick<GatewayRouteSnapshot, "config" | "models">
): string {
  if (snapshot.models.includes(clientModel)) return clientModel;
  const decoded = decodeGatewayModelAlias(clientModel);
  if (decoded && snapshot.models.includes(decoded)) return decoded;
  if (clientModel.startsWith(CCP_MODEL_ALIAS_PREFIX)) {
    throw invalidRequest("model: The selected Gateway model is invalid or is no longer configured for this Upstream.");
  }
  // Preserve compatibility with Claude Code clients that send a native or
  // legacy model id instead of a discovered ccp alias.
  return snapshot.config.model;
}

export function buildGatewayModelDiscovery(
  snapshot: Pick<GatewayRouteSnapshot, "upstreamId" | "models">
): GatewayModelDiscoveryEntry[] {
  return snapshot.models.map((model) => ({
    type: "model",
    id: gatewayModelAlias(model),
    display_name: `${model} (${snapshot.upstreamId})`,
    created_at: "2026-01-01T00:00:00Z"
  }));
}
