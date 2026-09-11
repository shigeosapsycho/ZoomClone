import { describe, expect, it } from "vitest";
import { SlidingWindowLimiter } from "./rate-limit";

describe("SlidingWindowLimiter", () => {
  it("allows `limit` hits per window then blocks with a retry-after", () => {
    const limiter = new SlidingWindowLimiter(3, 60_000);
    const t0 = 1_000_000;
    expect(limiter.hit("ip", t0).allowed).toBe(true);
    expect(limiter.hit("ip", t0 + 1000).allowed).toBe(true);
    expect(limiter.hit("ip", t0 + 2000).allowed).toBe(true);
    const blocked = limiter.hit("ip", t0 + 3000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(57);
  });

  it("slides: old hits expire", () => {
    const limiter = new SlidingWindowLimiter(2, 10_000);
    limiter.hit("k", 0);
    limiter.hit("k", 1000);
    expect(limiter.hit("k", 5000).allowed).toBe(false);
    expect(limiter.hit("k", 10_001).allowed).toBe(true);
  });

  it("keys are independent and sweep drops idle keys", () => {
    const limiter = new SlidingWindowLimiter(1, 10_000);
    expect(limiter.hit("a", 0).allowed).toBe(true);
    expect(limiter.hit("b", 0).allowed).toBe(true);
    expect(limiter.hit("a", 1).allowed).toBe(false);
    limiter.sweep(20_000);
    expect(limiter.hit("a", 20_001).allowed).toBe(true);
  });
});
