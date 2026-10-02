export interface RateLimiterOptions {
  /** Maximum burst: how many requests a client can make at once. */
  capacity: number;
  /** Sustained rate at which the allowance refills. */
  refillPerSecond: number;
  /** Bound on tracked clients, so a flood of distinct keys cannot exhaust memory. */
  maxKeys?: number;
  now?: () => number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until one request is available again; 0 when allowed. */
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * In-memory token bucket per client key.
 * State is local to one process: with several instances each one enforces its own limit.
 */
export class TokenBucketLimiter {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(options: RateLimiterOptions) {
    this.capacity = options.capacity;
    this.refillPerMs = options.refillPerSecond / 1000;
    this.maxKeys = options.maxKeys ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  take(key: string): RateLimitDecision {
    const now = this.now();
    const existing = this.buckets.get(key);
    const bucket: Bucket = existing ?? { tokens: this.capacity, updatedAt: now };

    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
    bucket.updatedAt = now;

    // Re-insert so the Map's insertion order doubles as least-recently-used order.
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    this.evictIfNeeded();

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }
    const msUntilToken = (1 - bucket.tokens) / this.refillPerMs;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(msUntilToken / 1000)) };
  }

  get trackedKeys(): number {
    return this.buckets.size;
  }

  private evictIfNeeded(): void {
    while (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) return;
      this.buckets.delete(oldest);
    }
  }
}
