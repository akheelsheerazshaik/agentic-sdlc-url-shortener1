import { describe, expect, it } from 'vitest';
import { MAX_URL_LENGTH, normalizeTargetUrl } from '../../src/domain/urlPolicy.ts';

const options = { selfHost: 'sho.rt' };

describe('normalizeTargetUrl', () => {
  it('accepts http and https URLs and normalizes them', () => {
    expect(normalizeTargetUrl('https://Example.com/a?b=1#c', options)).toBe('https://example.com/a?b=1#c');
    expect(normalizeTargetUrl('http://example.com', options)).toBe('http://example.com/');
  });

  it.each([
    ['javascript scheme', 'javascript:alert(1)'],
    ['data scheme', 'data:text/html,<script>alert(1)</script>'],
    ['file scheme', 'file:///etc/passwd'],
    ['ftp scheme', 'ftp://example.com/file'],
    ['relative path', '/just/a/path'],
    ['not a url', 'not a url'],
    ['embedded credentials', 'https://user:pass@example.com/'],
    ['username only', 'https://admin@example.com/'],
  ])('rejects %s', (_label, input) => {
    expect(() => normalizeTargetUrl(input, options)).toThrowError();
  });

  it('rejects URLs longer than the limit', () => {
    const long = `https://example.com/${'a'.repeat(MAX_URL_LENGTH)}`;
    expect(() => normalizeTargetUrl(long, options)).toThrowError(/at most/);
  });

  it('rejects links that point back at the service, in any letter case', () => {
    expect(() => normalizeTargetUrl('https://sho.rt/abc1234', options)).toThrowError(/this service/);
    expect(() => normalizeTargetUrl('https://SHO.RT/abc1234', options)).toThrowError(/this service/);
  });

  it('cannot be used to smuggle a header line into the Location header', () => {
    const normalized = normalizeTargetUrl('https://example.com/a\r\nSet-Cookie: x=1', options);
    expect(normalized).not.toMatch(/[\r\n]/);
  });
});
