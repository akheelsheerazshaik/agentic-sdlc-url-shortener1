import { BlockList, isIP } from 'node:net';

/**
 * Address ranges that are never a public destination: loopback, private networks, link-local
 * (which includes cloud metadata endpoints), carrier-grade NAT, and the unspecified address.
 */
const NON_PUBLIC_RANGES = new BlockList();
NON_PUBLIC_RANGES.addSubnet('0.0.0.0', 8, 'ipv4');
NON_PUBLIC_RANGES.addSubnet('10.0.0.0', 8, 'ipv4');
NON_PUBLIC_RANGES.addSubnet('100.64.0.0', 10, 'ipv4');
NON_PUBLIC_RANGES.addSubnet('127.0.0.0', 8, 'ipv4');
NON_PUBLIC_RANGES.addSubnet('169.254.0.0', 16, 'ipv4');
NON_PUBLIC_RANGES.addSubnet('172.16.0.0', 12, 'ipv4');
NON_PUBLIC_RANGES.addSubnet('192.168.0.0', 16, 'ipv4');
NON_PUBLIC_RANGES.addAddress('::', 'ipv6');
NON_PUBLIC_RANGES.addAddress('::1', 'ipv6');
NON_PUBLIC_RANGES.addSubnet('fc00::', 7, 'ipv6');
NON_PUBLIC_RANGES.addSubnet('fe80::', 10, 'ipv6');

/** Name suffixes reserved for local or internal use. */
const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

/** Lowercases a URL hostname and strips IPv6 brackets and a trailing dot, so rules compare like with like. */
export function canonicalHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/**
 * True when the host is an internal address or name.
 *
 * `hostname` must come from a parsed `URL`, which has already turned forms such as `2130706433`,
 * `0x7f.1` and `127.1` into `127.0.0.1`. Names are judged by their text only: this does not
 * resolve DNS, so a public name that points at a private address is not detected here.
 */
export function isInternalHost(hostname: string): boolean {
  const host = canonicalHost(hostname);
  const family = isIP(host);
  if (family === 4) return NON_PUBLIC_RANGES.check(host, 'ipv4');
  // BlockList also matches IPv4-mapped IPv6 addresses (::ffff:10.0.0.1) against the IPv4 ranges.
  if (family === 6) return NON_PUBLIC_RANGES.check(host, 'ipv6');

  if (host === 'localhost') return true;
  // A name without a dot can only resolve inside someone's network.
  if (!host.includes('.')) return true;
  return INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** True when the host is a denied host or any subdomain of one. */
export function isDeniedHost(hostname: string, deniedHosts: readonly string[]): boolean {
  const host = canonicalHost(hostname);
  return deniedHosts.some((denied) => host === denied || host.endsWith(`.${denied}`));
}

/** Parses the DENIED_HOSTS setting: comma-separated host names. Throws on anything that is not a host name. */
export function parseDeniedHosts(value: string): string[] {
  const hosts = value
    .split(',')
    .map((entry) => canonicalHost(entry.trim()))
    .filter((entry) => entry !== '');
  for (const host of hosts) {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
      throw new Error(`DENIED_HOSTS contains an invalid host name: "${host}"`);
    }
  }
  return [...new Set(hosts)];
}
