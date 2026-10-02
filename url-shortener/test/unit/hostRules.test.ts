import { describe, expect, it } from 'vitest';
import { isDeniedHost, isInternalHost, parseDeniedHosts } from '../../src/domain/hostRules.ts';

/** Host as the service sees it: taken from a parsed URL, which canonicalizes unusual address forms. */
const hostOf = (url: string) => new URL(url).hostname;

describe('isInternalHost', () => {
  it.each([
    ['loopback', 'http://127.0.0.1/'],
    ['loopback range', 'http://127.8.8.8/'],
    ['private 10/8', 'http://10.1.2.3/'],
    ['private 172.16/12', 'http://172.31.255.255/'],
    ['private 192.168/16', 'http://192.168.0.10/'],
    ['link-local / cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['carrier-grade NAT', 'http://100.64.0.1/'],
    ['unspecified address', 'http://0.0.0.0/'],
    ['decimal integer form', 'http://2130706433/'],
    ['hex form', 'http://0x7f.0.0.1/'],
    ['short form', 'http://127.1/'],
    ['IPv6 loopback', 'http://[::1]/'],
    ['IPv6 unique local', 'http://[fd12:3456:789a::1]/'],
    ['IPv6 link-local', 'http://[fe80::1]/'],
    ['IPv4-mapped IPv6', 'http://[::ffff:10.0.0.1]/'],
    ['localhost', 'http://localhost:3000/'],
    ['localhost with trailing dot', 'http://localhost./'],
    ['localhost subdomain', 'http://app.localhost/'],
    ['mDNS name', 'http://printer.local/'],
    ['internal suffix', 'http://vault.corp.internal/'],
    ['single-label name', 'http://intranet/'],
  ])('treats %s as internal', (_label, url) => {
    expect(isInternalHost(hostOf(url))).toBe(true);
  });

  it.each([
    ['a public name', 'https://example.com/'],
    ['a public name with trailing dot', 'https://example.com./'],
    ['a public IPv4 address', 'http://93.184.216.34/'],
    ['just outside 172.16/12', 'http://172.32.0.1/'],
    ['a public IPv6 address', 'http://[2606:2800:220:1:248:1893:25c8:1946]/'],
    ['a name that merely contains "local"', 'https://localnews.example/'],
  ])('treats %s as public', (_label, url) => {
    expect(isInternalHost(hostOf(url))).toBe(false);
  });
});

describe('isDeniedHost', () => {
  const denied = ['malware.example', 'phish.test'];

  it('matches a denied host and its subdomains, in any case', () => {
    expect(isDeniedHost('malware.example', denied)).toBe(true);
    expect(isDeniedHost('cdn.malware.example', denied)).toBe(true);
    expect(isDeniedHost('MALWARE.EXAMPLE', denied)).toBe(true);
    expect(isDeniedHost('malware.example.', denied)).toBe(true);
  });

  it('does not match hosts that only share a suffix of characters', () => {
    expect(isDeniedHost('notmalware.example', denied)).toBe(false);
    expect(isDeniedHost('malware.example.org', denied)).toBe(false);
    expect(isDeniedHost('example', denied)).toBe(false);
  });

  it('denies nothing when the list is empty', () => {
    expect(isDeniedHost('malware.example', [])).toBe(false);
  });
});

describe('parseDeniedHosts', () => {
  it('parses, trims, lowercases and de-duplicates', () => {
    expect(parseDeniedHosts(' Malware.Example , phish.test,malware.example ')).toEqual(['malware.example', 'phish.test']);
  });

  it('returns an empty list for an empty setting', () => {
    expect(parseDeniedHosts('')).toEqual([]);
    expect(parseDeniedHosts(' , ')).toEqual([]);
  });

  it.each(['https://malware.example', 'malware.example/path', '*.example', 'com', 'bad host.example'])(
    'rejects "%s" because it is not a host name',
    (value) => {
      expect(() => parseDeniedHosts(value)).toThrowError(/invalid host name/);
    },
  );
});
