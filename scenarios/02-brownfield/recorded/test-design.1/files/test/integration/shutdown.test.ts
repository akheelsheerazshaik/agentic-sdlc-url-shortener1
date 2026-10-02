import { describe, expect, it } from 'vitest';
import { createLink, createTestApp } from '../helpers.ts';

/** Regression tests for clicks being lost when the service stops (BUG-17). */
describe('graceful shutdown', () => {
  it('writes buffered clicks before the app closes', async () => {
    // A flush interval far longer than the test, so only the shutdown path can write the clicks.
    const t = createTestApp({ env: { CLICK_FLUSH_INTERVAL_MS: '600000' } });
    await createLink(t.app, { url: 'https://example.com', alias: 'deploy-day' });
    for (let i = 0; i < 3; i++) {
      await t.app.inject({ method: 'GET', url: '/deploy-day', headers: { referer: 'https://news.example/a' } });
    }

    const before = t.db.prepare("SELECT click_count FROM links WHERE code = 'deploy-day'").get();
    expect(before).toEqual({ click_count: 0 });

    await t.app.close();

    const after = t.db.prepare("SELECT click_count FROM links WHERE code = 'deploy-day'").get();
    expect(after).toEqual({ click_count: 3 });
    const events = t.db.prepare('SELECT COUNT(*) AS n FROM click_events').get();
    expect(events).toEqual({ n: 3 });
  });

  it('closes cleanly when there is nothing to flush', async () => {
    const t = createTestApp();
    await expect(t.app.close()).resolves.toBeUndefined();
  });

  it('still closes when the final flush fails', async () => {
    const t = createTestApp({ env: { CLICK_FLUSH_INTERVAL_MS: '600000' } });
    await createLink(t.app, { url: 'https://example.com', alias: 'doomed' });
    await t.app.inject({ method: 'GET', url: '/doomed' });
    t.db.close();
    await expect(t.app.close()).resolves.toBeUndefined();
  });
});
