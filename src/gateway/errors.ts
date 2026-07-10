export type GatewayErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "not_found_error"
  | "rate_limit_error"
  | "api_error";

export interface GatewayError {
  type: GatewayErrorType;
  message: string;
}

export interface AnthropicErrorEnvelope {
  type: "error";
  error: GatewayError;
}

export class GatewayProtocolError extends Error {
  readonly status: number;
  readonly error: GatewayError;

  constructor(error: GatewayError, status = 400, options?: ErrorOptions) {
    super(error.message, options);
    this.name = "GatewayProtocolError";
    this.status = status;
    this.error = error;
  }
}

export function invalidRequest(message: string): GatewayProtocolError {
  return new GatewayProtocolError({ type: "invalid_request_error", message }, 400);
}

export function upstreamProtocolError(message: string, options?: ErrorOptions): GatewayProtocolError {
  return new GatewayProtocolError({ type: "api_error", message }, 502, options);
}

export function toAnthropicErrorEnvelope(error: GatewayError): AnthropicErrorEnvelope {
  return { type: "error", error };
}

export function asGatewayError(error: unknown, fallback = "Gateway protocol conversion failed."): GatewayError {
  if (error instanceof GatewayProtocolError) {
    return error.error;
  }

  return {
    type: "api_error",
    message: error instanceof Error && error.message ? error.message : fallback
  };
}
