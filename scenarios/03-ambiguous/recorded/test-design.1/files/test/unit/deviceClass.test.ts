import { describe, expect, it } from 'vitest';
import { classifyDevice } from '../../src/analytics/deviceClass.ts';

describe('classifyDevice', () => {
  it.each([
    ['Windows Chrome', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', 'desktop'],
    ['macOS Safari', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 'desktop'],
    ['Linux Firefox', 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0', 'desktop'],
    ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', 'mobile'],
    ['Android phone', 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36', 'mobile'],
    ['iPad', 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'tablet'],
    ['Android tablet', 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', 'tablet'],
    ['Googlebot', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'bot'],
    ['Googlebot smartphone', 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1)', 'bot'],
    ['link preview fetcher', 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)', 'bot'],
    ['curl', 'curl/8.7.1', 'bot'],
    ['headless browser', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/140.0.0.0 Safari/537.36', 'bot'],
    ['HTTP library', 'python-requests/2.32.3', 'bot'],
    ['unrecognised client', 'SomethingElse/1.0', 'unknown'],
    ['empty header', '', 'unknown'],
  ])('classifies %s', (_label, userAgent, expected) => {
    expect(classifyDevice(userAgent)).toBe(expected);
  });

  it('classifies a missing header as unknown', () => {
    expect(classifyDevice(undefined)).toBe('unknown');
  });

  it('inspects only the start of an oversized header', () => {
    const padded = `${'x'.repeat(600)} Googlebot/2.1`;
    expect(classifyDevice(padded)).toBe('unknown');
  });

  it('handles a very large header quickly', () => {
    const started = performance.now();
    classifyDevice('Mozilla/5.0 '.repeat(100_000));
    expect(performance.now() - started).toBeLessThan(50);
  });
});
