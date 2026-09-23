/** Token bucket: `ratePerSecond` refills, `burst` capacity. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number = ratePerSecond,
    now: number = Date.now(),
  ) {
    this.tokens = burst;
    this.last = now;
  }

  take(now: number = Date.now()): boolean {
    this.tokens = Math.min(
      this.burst,
      this.tokens + ((now - this.last) / 1000) * this.ratePerSecond,
    );
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
