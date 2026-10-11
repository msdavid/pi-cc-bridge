/**
 * Token-bucket rate limiter per direction pair (P1-12): excess traffic is
 * refused (callers hold/spool), never silently dropped or delivered.
 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly perMin: number,
    private readonly burst: number,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    if (this.perMin <= 0) return true;
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: now };
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 60_000) * this.perMin);
    b.at = now;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    return true;
  }
}
