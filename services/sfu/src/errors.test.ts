import { errors as mediasoupErrors } from "mediasoup";
import { describe, expect, it } from "vitest";
import { guarded, SfuError, wrapMediasoupError } from "./errors";

describe("wrapMediasoupError", () => {
  it("passes an SfuError through unchanged", () => {
    const original = new SfuError("NOT_FOUND", "room missing");
    expect(wrapMediasoupError(original)).toBe(original);
  });

  it("maps TypeError to INVALID_ARGUMENT", () => {
    const wrapped = wrapMediasoupError(new TypeError("bad argument"));
    expect(wrapped.code).toBe("INVALID_ARGUMENT");
    expect(wrapped.message).toBe("bad argument");
  });

  it("maps mediasoup NotFoundError to NOT_FOUND", () => {
    const wrapped = wrapMediasoupError(new mediasoupErrors.NotFoundError("x"));
    expect(wrapped.code).toBe("NOT_FOUND");
  });

  it("maps mediasoup UnsupportedError to FAILED_PRECONDITION", () => {
    const wrapped = wrapMediasoupError(new mediasoupErrors.UnsupportedError("x"));
    expect(wrapped.code).toBe("FAILED_PRECONDITION");
  });

  it("maps mediasoup WorkerClosedError to FAILED_PRECONDITION", () => {
    const wrapped = wrapMediasoupError(new mediasoupErrors.WorkerClosedError("x"));
    expect(wrapped.code).toBe("FAILED_PRECONDITION");
  });

  it("maps a plain Error with a worker-side message to FAILED_PRECONDITION", () => {
    const wrapped = wrapMediasoupError(new Error("connect() already called"));
    expect(wrapped.code).toBe("FAILED_PRECONDITION");
  });

  it("maps an unrecognized Error to INTERNAL and preserves the message", () => {
    const wrapped = wrapMediasoupError(new Error("boom"));
    expect(wrapped.code).toBe("INTERNAL");
    expect(wrapped.message).toBe("boom");
  });
});

describe("guarded", () => {
  it("rejects with a wrapped SfuError", async () => {
    await expect(
      guarded(async () => {
        throw new TypeError("bad");
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
