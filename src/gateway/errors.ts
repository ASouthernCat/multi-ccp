export type GatewayErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "not_found_error"
  | "rate_limit_error"
  | "api_error";

export type GatewayFailureCode =
  | "local_validation_error"
  | "upstream_connect_error"
  | "upstream_http_error"
  | "upstream_response_error"
  | "invalid_stream_data"
  | "unsupported_stream_event"
  | "unsupported_output_item"
  | "missing_terminal_event"
  | "gateway_timeout"
  | "client_disconnected"
  | "gateway_internal_error";

export interface GatewayError {
  type: GatewayErrorType;
  message: string;
  code?: GatewayFailureCode;
}

export interface AnthropicErrorEnvelope {
  type: "error";
  error: Pick<GatewayError, "type" | "message">;
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

export function upstreamProtocolError(
  message: string,
  options?: ErrorOptions,
  code?: GatewayFailureCode
): GatewayProtocolError {
  return new GatewayProtocolError({ type: "api_error", message, ...(code ? { code } : {}) }, 502, options);
}

export function toAnthropicErrorEnvelope(error: GatewayError): AnthropicErrorEnvelope {
  return { type: "error", error: { type: error.type, message: error.message } };
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
