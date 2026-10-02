import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/domain/errors.ts';
import { CODE_LENGTH, CODE_PATTERN, generateCode, validateAlias } from '../../src/domain/shortCode.ts';

describe('generateCode', () => {
  it('produces codes of the configured length from the base62 alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateCode();
      expect(code).toHaveLength(CODE_LENGTH);
      expect(code).toMatch(/^[0-9A-Za-z]+$/);
      expect(code).toMatch(CODE_PATTERN);
    }
  });

  it('uses the injected random source for every character', () => {
    const picks = [0, 10, 36, 61];
    let call = 0;
    const code = generateCode(4, () => picks[call++]!);
    expect(code).toBe('0Aaz');
  });

  it('does not repeat across a large sample', () => {
    const codes = new Set(Array.from({ length: 5000 }, () => generateCode()));
    expect(codes.size).toBe(5000);
  });
});

describe('validateAlias', () => {
  it.each(['abc', 'spring-sale', 'q4_2026', '9lives'])('accepts %s', (alias) => {
    expect(validateAlias(alias)).toBe(alias);
  });

  it.each([
    ['too short', 'ab'],
    ['too long', 'a'.repeat(33)],
    ['uppercase', 'Promo'],
    ['leading dash', '-promo'],
    ['path traversal', '../etc'],
    ['spaces', 'my link'],
    ['slash', 'a/b'],
  ])('rejects %s', (_label, alias) => {
    expect(() => validateAlias(alias)).toThrowError(AppError);
  });

  it.each(['api', 'healthz', 'readyz', 'admin'])('rejects reserved alias %s', (alias) => {
    expect(() => validateAlias(alias)).toThrowError(/reserved/);
  });
});
