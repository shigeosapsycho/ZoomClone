import { errors as mediasoupErrors } from "mediasoup";

export type SfuErrorCode =
  | "NOT_FOUND"
  | "PERMISSION_DENIED"
  | "FAILED_PRECONDITION"
  | "INVALID_ARGUMENT"
  | "UNIMPLEMENTED"
  | "INTERNAL";

export class SfuError extends Error {
  constructor(
    readonly code: SfuErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SfuError";
  }
}

/**
 * mediasoup error classes: TypeError for bad arguments, NotFoundError for unknown ids,
 * UnsupportedError for incompatible codecs or capabilities, WorkerClosedError when the worker is
 * gone. Worker-side failures ("connect() already called", closed entities) arrive as plain Error.
 */
export function wrapMediasoupError(error: unknown): SfuError {
  if (error instanceof SfuError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof TypeError) return new SfuError("INVALID_ARGUMENT", message);
  if (error instanceof mediasoupErrors.NotFoundError) return new SfuError("NOT_FOUND", message);
  if (error instanceof mediasoupErrors.UnsupportedError) {
    return new SfuError("FAILED_PRECONDITION", message);
  }
  if (error instanceof mediasoupErrors.WorkerClosedError) {
    return new SfuError("FAILED_PRECONDITION", message);
  }
  if (/already called|closed|not connected|not supported|unsupported/i.test(message)) {
    return new SfuError("FAILED_PRECONDITION", message);
  }
  return new SfuError("INTERNAL", message);
}

export async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw wrapMediasoupError(error);
  }
}
