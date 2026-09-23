import { z } from "zod";

/** REST error codes (spec 5.1) plus generic ones, mapped to HTTP status. */
export const ERROR_STATUS = {
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  LOCKED: 403,
  DOMAIN_RESTRICTED: 403,
  NOT_FOUND: 404,
  MEETING_NOT_FOUND: 404,
  CONFLICT: 409,
  NOT_LIVE: 409,
  ENDED: 410,
  CAPACITY: 429,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  NO_CAPACITY: 503,
  UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class ApiError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message ?? code);
    this.name = "ApiError";
    this.status = ERROR_STATUS[code];
  }
}

export const ErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;
