export type RateDecision = { allowed: boolean; retryAfterSeconds: number };

export interface RateLimiter {
  hit(key: string, now?: number): RateDecision;
}

/** In-memory sliding window per key. Spec 8: 10/min per IP and per code on /join. */
export class SlidingWindowLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  hit(key: string, now: number = Date.now()): RateDecision {
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
      return { allowed: false, retryAfterSeconds };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Drops keys without hits inside the window; call on an interval to bound memory. */
  sweep(now: number = Date.now()): void {
    const cutoff = now - this.windowMs;
    for (const [key, times] of this.hits) {
      if (!times.some((t) => t > cutoff)) this.hits.delete(key);
    }
  }

  get size(): number {
    return this.hits.size;
  }
}

/** Sweeps every limiter on an interval that never keeps the process alive. Returns a stop function. */
export function startSweeper(limiters: SlidingWindowLimiter[], intervalMs: number): () => void {
  const timer = setInterval(() => {
    for (const limiter of limiters) limiter.sweep();
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
