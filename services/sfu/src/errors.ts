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

/** mediasoup throws TypeError for bad parameters and InvalidStateError for closed or misused entities. */
export function wrapMediasoupError(error: unknown): SfuError {
  if (error instanceof SfuError) return error;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof TypeError) return new SfuError("INVALID_ARGUMENT", message);
  if (name === "InvalidStateError") return new SfuError("FAILED_PRECONDITION", message);
  return new SfuError("INTERNAL", message);
}

export async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw wrapMediasoupError(error);
  }
}
