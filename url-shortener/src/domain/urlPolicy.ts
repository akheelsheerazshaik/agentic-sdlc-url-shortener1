import { validationError } from './errors.ts';
import { isDeniedHost, isInternalHost } from './hostRules.ts';

export const MAX_URL_LENGTH = 2048;

export interface UrlPolicyOptions {
  /** Host of this service. Links pointing back at it are rejected to prevent redirect loops. */
  selfHost: string;
  /** Hosts, and their subdomains, that links may not point to. */
  deniedHosts: readonly string[];
}

/**
 * Validates a destination URL and returns its normalized form.
 * A shortener is an open redirector by design, so the rules here decide what it may redirect to.
 */
export function normalizeTargetUrl(input: string, options: UrlPolicyOptions): string {
  if (input.length > MAX_URL_LENGTH) {
    throw validationError(`url must be at most ${MAX_URL_LENGTH} characters.`);
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw validationError('url must be an absolute URL.');
  }

  // Only web links. This rejects javascript:, data:, file: and similar schemes that run or expose content.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw validationError('url must use http or https.');
  }
  // user:pass@host is a classic way to disguise the real destination.
  if (url.username !== '' || url.password !== '') {
    throw validationError('url must not contain credentials.');
  }
  if (url.host.toLowerCase() === options.selfHost.toLowerCase()) {
    throw validationError('url must not point at this service.');
  }
  if (!isAllowedDestination(url, options.deniedHosts)) {
    throw validationError('url points to a destination that is not allowed.');
  }

  return url.toString();
}

/**
 * The safety rules that can change after a link was created: the denylist is configuration, so a
 * stored link is checked again with this at redirect time.
 */
export function isAllowedDestination(target: URL | string, deniedHosts: readonly string[]): boolean {
  let url: URL;
  try {
    url = typeof target === 'string' ? new URL(target) : target;
  } catch {
    return false;
  }
  return !isInternalHost(url.hostname) && !isDeniedHost(url.hostname, deniedHosts);
}
