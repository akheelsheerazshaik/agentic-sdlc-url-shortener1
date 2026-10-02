import { afterEach, describe, expect, it } from 'vitest';
import { createLink, createTestApp, type TestApp } from '../helpers.ts';

describe('reliability', () => {
  let t: TestApp;
  afterEach(async () => {
    await t.app.close();
  });

  describe('rate limiting', () => {
    it('returns 429 with Retry-After once the burst is used up, then recovers', async () => {
      t = createTestApp({ env: { RATE_LIMIT_CAPACITY: '2', RATE_LIMIT_REFILL_PER_SECOND: '1' } });
      expect((await createLink(t.app, { url: 'https://example.com/1' })).status).toBe(201);
      expect((await createLink(t.app, { url: 'https://example.com/2' })).status).toBe(201);

      const limited = await t.app.inject({
        method: 'POST',
        url: '/api/v1/links',
        payload: { url: 'https://example.com/3' },
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers['retry-after']).toBe('1');
      expect(limited.json()).toMatchObject({ status: 429, code: 'rate_limited' });

      t.clock.advance(1000);
      expect((await createLink(t.app, { url: 'https://example.com/3' })).status).toBe(201);
    });

    it('does not rate limit redirects', async () => {
      t = createTestApp({ env: { RATE_LIMIT_CAPACITY: '1' } });
      await createLink(t.app, { url: 'https://example.com', alias: 'hot-link' });
      for (let i = 0; i < 20; i++) {
        expect((await t.app.inject({ method: 'GET', url: '/hot-link' })).statusCode).toBe(302);
      }
    });
  });

  describe('health', () => {
    it('reports liveness and readiness', async () => {
      t = createTestApp();
      expect((await t.app.inject({ method: 'GET', url: '/healthz' })).json()).toEqual({ status: 'ok' });
      expect((await t.app.inject({ method: 'GET', url: '/readyz' })).json()).toEqual({ status: 'ready' });
    });

    it('reports not ready when the database is unavailable', async () => {
      t = createTestApp();
      t.db.close();
      const response = await t.app.inject({ method: 'GET', url: '/readyz' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: 'unavailable' });
    });
  });

  describe('failure handling', () => {
    it('returns a generic 500 and leaks no internals when the database fails', async () => {
      t = createTestApp();
      await createLink(t.app, { url: 'https://example.com', alias: 'before' });
      t.db.close();
      const response = await t.app.inject({ method: 'GET', url: '/api/v1/links/before' });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        type: 'urn:problem:internal_error',
        title: 'Internal Server Error',
        status: 500,
        code: 'internal_error',
        detail: 'An unexpected error occurred.',
      });
    });

    it('serves redirects even when the click queue is full', async () => {
      t = createTestApp({ env: { CLICK_QUEUE_MAX: '2', CLICK_FLUSH_INTERVAL_MS: '600000' } });
      await createLink(t.app, { url: 'https://example.com', alias: 'busy' });
      for (let i = 0; i < 5; i++) {
        expect((await t.app.inject({ method: 'GET', url: '/busy' })).statusCode).toBe(302);
      }
      const stats = (await t.app.inject({ method: 'GET', url: '/api/v1/links/busy/stats' })).json();
      expect(stats.totalClicks).toBe(2);
    });
  });

  describe('configuration', () => {
    it('fails fast on invalid configuration', () => {
      expect(() => createTestApp({ env: { PORT: 'not-a-port' } })).toThrowError(/Invalid configuration/);
      t = createTestApp();
    });
  });
});
