import { describe, expect, it } from "vitest";
import { ApiError, ERROR_STATUS, ErrorBodySchema } from "./errors";

describe("ApiError", () => {
  it("maps spec error codes to HTTP statuses", () => {
    expect(new ApiError("MEETING_NOT_FOUND").status).toBe(404);
    expect(new ApiError("LOCKED").status).toBe(403);
    expect(new ApiError("DOMAIN_RESTRICTED").status).toBe(403);
    expect(new ApiError("ENDED").status).toBe(410);
    expect(new ApiError("CAPACITY").status).toBe(429);
    expect(new ApiError("NO_CAPACITY").status).toBe(503);
    expect(new ApiError("RATE_LIMITED").status).toBe(429);
    expect(new ApiError("NOT_LIVE").status).toBe(409);
    expect(ERROR_STATUS.UNAUTHORIZED).toBe(401);
  });

  it("defaults the message to the code and keeps retry-after", () => {
    const err = new ApiError("RATE_LIMITED", undefined, 30);
    expect(err.message).toBe("RATE_LIMITED");
    expect(err.retryAfterSeconds).toBe(30);
    expect(err).toBeInstanceOf(Error);
  });

  it("validates the error body shape", () => {
    expect(ErrorBodySchema.parse({ error: { code: "ENDED", message: "gone" } }).error.code).toBe(
      "ENDED",
    );
  });
});
