import { validationError } from './errors.ts';

export const MAX_URL_LENGTH = 2048;

export interface UrlPolicyOptions {
  /** Host of this service. Links pointing back at it are rejected to prevent redirect loops. */
  selfHost: string;
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

  return url.toString();
}
