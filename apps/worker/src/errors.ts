import type { ErrorCode, ErrorEnvelope } from "@cloudflare-mobile-sync/api-contract";

export class PublicError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(status: number, code: ErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "PublicError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export function errorEnvelope(error: PublicError): ErrorEnvelope {
  return {
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    },
  };
}
