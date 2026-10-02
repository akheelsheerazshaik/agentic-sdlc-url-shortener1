import { describe, expect, it } from 'vitest';
import { isExpired } from '../../src/links/linkService.ts';

describe('isExpired', () => {
  const expiresAt = '2026-03-01T13:00:00.000Z';

  it('is false for a link without an expiry', () => {
    expect(isExpired({ expiresAt: null }, new Date('2099-01-01T00:00:00Z'))).toBe(false);
  });

  it('is false one millisecond before the expiry instant', () => {
    expect(isExpired({ expiresAt }, new Date('2026-03-01T12:59:59.999Z'))).toBe(false);
  });

  it('is true at the expiry instant and afterwards', () => {
    expect(isExpired({ expiresAt }, new Date('2026-03-01T13:00:00.000Z'))).toBe(true);
    expect(isExpired({ expiresAt }, new Date('2026-03-01T13:00:00.001Z'))).toBe(true);
  });
});
