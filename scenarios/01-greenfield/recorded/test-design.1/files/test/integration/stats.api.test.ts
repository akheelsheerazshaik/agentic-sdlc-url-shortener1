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

  const click = (referer?: string) =>
    t.app.inject({ method: 'GET', url: '/campaign', headers: referer ? { referer } : {} });
  const stats = async () => (await t.app.inject({ method: 'GET', url: '/api/v1/links/campaign/stats' })).json();

  it('reports zero clicks for a new link', async () => {
    expect(await stats()).toEqual({ code: 'campaign', totalClicks: 0, clicksByDay: [], topReferrers: [] });
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
