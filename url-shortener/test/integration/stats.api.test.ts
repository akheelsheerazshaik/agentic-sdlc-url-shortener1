import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLink, createTestApp, type TestApp } from '../helpers.ts';

const DAY = 24 * 60 * 60 * 1000;

describe('GET /api/v1/links/:code/stats', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = createTestApp();
    await createLink(t.app, { url: 'https://example.com/landing', alias: 'campaign' });
  });
  afterEach(async () => {
    await t.app.close();
  });

  const click = (referer?: string, userAgent?: string) =>
    t.app.inject({
      method: 'GET',
      url: '/campaign',
      headers: { ...(referer ? { referer } : {}), ...(userAgent ? { 'user-agent': userAgent } : {}) },
    });
  const stats = async () => (await t.app.inject({ method: 'GET', url: '/api/v1/links/campaign/stats' })).json();

  it('reports zero clicks for a new link', async () => {
    expect(await stats()).toEqual({
      code: 'campaign',
      totalClicks: 0,
      botClicks: 0,
      nonBotClicks: 0,
      clicksByDevice: [
        { device: 'desktop', clicks: 0 },
        { device: 'mobile', clicks: 0 },
        { device: 'tablet', clicks: 0 },
        { device: 'bot', clicks: 0 },
        { device: 'unknown', clicks: 0 },
      ],
      clicksByDay: [],
      topReferrers: [],
    });
  });

  it('counts every redirect', async () => {
    await click();
    await click();
    await click();
    expect((await stats()).totalClicks).toBe(3);
  });

  it('groups clicks by UTC day, oldest first', async () => {
    await click();
    t.clock.advance(DAY);
    await click();
    await click();
    expect((await stats()).clicksByDay).toEqual([
      { date: '2026-03-01', clicks: 1 },
      { date: '2026-03-02', clicks: 2 },
    ]);
  });

  it('limits the daily breakdown to the reporting window but keeps the full total', async () => {
    await click();
    t.clock.advance(31 * DAY);
    await click();
    const result = await stats();
    expect(result.totalClicks).toBe(2);
    expect(result.clicksByDay).toEqual([{ date: '2026-04-01', clicks: 1 }]);
  });

  it('ranks referrers by host and labels clicks without one as direct', async () => {
    await click('https://news.example/story?id=1');
    await click('https://news.example/other');
    await click('https://social.example/post/9');
    await click();
    expect((await stats()).topReferrers).toEqual([
      { referrer: 'news.example', clicks: 2 },
      { referrer: 'direct', clicks: 1 },
      { referrer: 'social.example', clicks: 1 },
    ]);
  });

  it('stores only the referrer host, never the full URL', async () => {
    await click('https://news.example/story?email=alice@example.com');
    await stats();
    const rows = t.db.prepare('SELECT referrer_host FROM click_events').all();
    expect(rows).toEqual([{ referrer_host: 'news.example' }]);
  });

  describe('device breakdown', () => {
    const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
    const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36';
    const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

    it('counts clicks per device class', async () => {
      await click(undefined, IPHONE);
      await click(undefined, IPHONE);
      await click(undefined, WINDOWS);
      await click(undefined, GOOGLEBOT);
      await click(undefined, 'something-unrecognised');
      expect((await stats()).clicksByDevice).toEqual([
        { device: 'desktop', clicks: 1 },
        { device: 'mobile', clicks: 2 },
        { device: 'tablet', clicks: 0 },
        { device: 'bot', clicks: 1 },
        { device: 'unknown', clicks: 1 },
      ]);
    });

    it('reports bot clicks separately and keeps totalClicks as the sum of both', async () => {
      await click(undefined, WINDOWS);
      await click(undefined, GOOGLEBOT);
      await click(undefined, GOOGLEBOT);
      const result = await stats();
      expect(result.totalClicks).toBe(3);
      expect(result.botClicks).toBe(2);
      expect(result.nonBotClicks).toBe(1);
    });

    it('stores the device class but never the User-Agent header', async () => {
      await click('https://news.example/a', IPHONE);
      await stats();
      const rows = t.db.prepare('SELECT * FROM click_events').all() as Record<string, unknown>[];
      expect(Object.keys(rows[0]!).sort()).toEqual(['clicked_at', 'code', 'device_class', 'id', 'referrer_host']);
      expect(JSON.stringify(rows)).not.toContain('iPhone');
    });

    it('reports clicks recorded before the device column existed as unknown', async () => {
      t.db
        .prepare("INSERT INTO click_events (code, clicked_at, referrer_host) VALUES ('campaign', '2026-03-01T11:00:00.000Z', NULL)")
        .run();
      t.db.prepare("UPDATE links SET click_count = 1 WHERE code = 'campaign'").run();
      const result = await stats();
      expect(result.clicksByDevice.find((d: { device: string }) => d.device === 'unknown')).toEqual({
        device: 'unknown',
        clicks: 1,
      });
      expect(result.nonBotClicks).toBe(1);
    });
  });

  it('does not count failed lookups', async () => {
    await t.app.inject({ method: 'GET', url: '/missing1' });
    expect((await stats()).totalClicks).toBe(0);
  });

  it('keeps stats separate per link', async () => {
    await createLink(t.app, { url: 'https://example.com/other', alias: 'other' });
    await click();
    await t.app.inject({ method: 'GET', url: '/other' });
    await t.app.inject({ method: 'GET', url: '/other' });
    expect((await stats()).totalClicks).toBe(1);
  });

  it('returns 404 for an unknown link', async () => {
    const response = await t.app.inject({ method: 'GET', url: '/api/v1/links/nothere/stats' });
    expect(response.statusCode).toBe(404);
  });
});
