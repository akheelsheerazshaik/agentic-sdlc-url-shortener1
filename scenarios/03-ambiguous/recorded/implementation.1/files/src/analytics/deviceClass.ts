export const DEVICE_CLASSES = ['desktop', 'mobile', 'tablet', 'bot', 'unknown'] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];

/** Only the start of the header is inspected, which bounds the work an oversized header can cause. */
const MAX_INSPECTED_LENGTH = 512;

const BOT = /bot\b|crawl|spider|slurp|preview|monitor|fetch|scrape|headless|curl\/|wget\/|python-|java\/|go-http-client|okhttp|axios|node-fetch|facebookexternalhit/i;
const TABLET = /ipad|tablet|kindle|silk\/|playbook/i;
const MOBILE = /mobi|iphone|ipod|windows phone/i;
const ANDROID = /android/i;
const DESKTOP = /windows nt|macintosh|x11|linux|cros/i;

/**
 * Reduces a User-Agent header to a coarse device class.
 *
 * The class is the only thing derived from the header that is kept. The header itself is never
 * stored or logged, because combined with other request data it can identify a person.
 *
 * This is a heuristic: a client that sends a browser's User-Agent is classified as that browser,
 * so `bot` means "identified itself as automated", not "every automated client".
 */
export function classifyDevice(userAgent: string | undefined): DeviceClass {
  if (!userAgent) return 'unknown';
  const ua = userAgent.slice(0, MAX_INSPECTED_LENGTH);

  if (BOT.test(ua)) return 'bot';
  if (TABLET.test(ua)) return 'tablet';
  if (MOBILE.test(ua)) return 'mobile';
  // Android without "Mobile" is how Android tablets identify themselves.
  if (ANDROID.test(ua)) return 'tablet';
  if (DESKTOP.test(ua)) return 'desktop';
  return 'unknown';
}
