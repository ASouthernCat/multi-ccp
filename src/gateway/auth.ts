import type { IncomingHttpHeaders } from "node:http";
import { tokensEqual } from "../core/gateway-profile.js";

export function readLocalGatewayToken(headers: IncomingHttpHeaders): string | undefined {
  const apiKey = readHeader(headers["x-api-key"]);
  const authorization = readHeader(headers.authorization);
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (apiKey && bearer && apiKey !== bearer) {
    return undefined;
  }
  return apiKey || bearer;
}

export function authorizeLocalGatewayRequest(
  headers: IncomingHttpHeaders,
  expectedToken: string
): boolean {
  const actual = readLocalGatewayToken(headers);
  return actual !== undefined && tokensEqual(expectedToken, actual);
}

function readHeader(value: string | string[] | undefined): string | undefined {
  const normalized = Array.isArray(value) ? value[0] : value;
  return normalized?.trim() || undefined;
}
