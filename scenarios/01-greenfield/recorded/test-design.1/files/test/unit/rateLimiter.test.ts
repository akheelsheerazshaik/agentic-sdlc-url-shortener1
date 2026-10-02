import { describe, expect, it } from 'vitest';
import { TokenBucketLimiter } from '../../src/http/rateLimiter.ts';

function limiterAt(start: number, overrides: { capacity?: number; refillPerSecond?: number; maxKeys?: number } = {}) {
  const time = { now: start };
  const limiter = new TokenBucketLimiter({
    capacity: 3,
    refillPerSecond: 1,
    ...overrides,
    now: () => time.now,
  });
  return { limiter, time };
}

describe('TokenBucketLimiter', () => {
  it('allows a burst up to capacity, then refuses', () => {
    const { limiter } = limiterAt(0);
    expect([1, 2, 3].map(() => limiter.take('a').allowed)).toEqual([true, true, true]);
    const refused = limiter.take('a');
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBe(1);
  });

  it('refills over time, but never above capacity', () => {
    const { limiter, time } = limiterAt(0);
    for (let i = 0; i < 3; i++) limiter.take('a');
    time.now += 2000;
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(false);

    time.now += 60_000;
    const allowed = [1, 2, 3, 4].map(() => limiter.take('a').allowed);
    expect(allowed).toEqual([true, true, true, false]);
  });

  it('tracks each client independently', () => {
    const { limiter } = limiterAt(0, { capacity: 1 });
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(false);
    expect(limiter.take('b').allowed).toBe(true);
  });

  it('reports how long to wait when the refill rate is slow', () => {
    const { limiter } = limiterAt(0, { capacity: 1, refillPerSecond: 0.1 });
    limiter.take('a');
    expect(limiter.take('a').retryAfterSeconds).toBe(10);
  });

  it('evicts the least recently used client once the key bound is reached', () => {
    const { limiter } = limiterAt(0, { capacity: 1, maxKeys: 2 });
    limiter.take('a');
    limiter.take('b');
    limiter.take('a'); // touch "a" so "b" is now the oldest
    limiter.take('c');
    expect(limiter.trackedKeys).toBe(2);
    // "b" was evicted, so it starts with a full bucket again; "a" was kept and is still empty.
    expect(limiter.take('b').allowed).toBe(true);
  });
});
