import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLink, createTestApp, type TestApp } from '../helpers.ts';

const HOUR = 60 * 60 * 1000;

describe('link expiry', () => {
  let t: TestApp;
  beforeEach(() => {
    t = createTestApp();
  });
  afterEach(async () => {
    await t.app.close();
  });

  const redirect = (code: string) => t.app.inject({ method: 'GET', url: `/${code}` });

  describe('creating a link', () => {
    it('never expires by default', async () => {
      const { body } = await createLink(t.app, { url: 'https://example.com', alias: 'forever' });
      expect(body.expiresAt).toBeNull();
      t.clock.advance(10 * 365 * 24 * HOUR);
      expect((await redirect('forever')).statusCode).toBe(302);
    });

    it('accepts an absolute expiry and stores it in UTC', async () => {
      const { status, body } = await createLink(t.app, {
        url: 'https://example.com',
        expiresAt: '2026-03-01T15:00:00+02:00',
      });
      expect(status).toBe(201);
      expect(body.expiresAt).toBe('2026-03-01T13:00:00.000Z');
    });

    it('accepts a time-to-live relative to now', async () => {
      const { status, body } = await createLink(t.app, { url: 'https://example.com', ttlSeconds: 3600 });
      expect(status).toBe(201);
      expect(body.expiresAt).toBe('2026-03-01T13:00:00.000Z');
    });

    it.each([
      ['an expiry in the past', { expiresAt: '2026-03-01T11:59:59Z' }],
      ['an expiry equal to now', { expiresAt: '2026-03-01T12:00:00Z' }],
      ['both expiresAt and ttlSeconds', { expiresAt: '2026-04-01T00:00:00Z', ttlSeconds: 60 }],
      ['an expiry that is not a timestamp', { expiresAt: 'next tuesday' }],
      ['an expiry without a time zone', { expiresAt: '2026-04-01T00:00:00' }],
      ['a zero ttl', { ttlSeconds: 0 }],
      ['a negative ttl', { ttlSeconds: -5 }],
      ['a fractional ttl', { ttlSeconds: 1.5 }],
      ['a ttl beyond the maximum', { ttlSeconds: 6 * 365 * 24 * 60 * 60 }],
    ])('rejects %s with 400', async (_label, fields) => {
      const { status, body } = await createLink(t.app, { url: 'https://example.com', ...fields });
      expect(status).toBe(400);
      expect(body.code).toBe('validation_error');
    });
  });

  describe('redirecting', () => {
    beforeEach(async () => {
      await createLink(t.app, { url: 'https://example.com/offer', alias: 'flash-sale', ttlSeconds: 3600 });
    });

    it('redirects until the expiry instant', async () => {
      t.clock.advance(HOUR - 1);
      const response = await redirect('flash-sale');
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('https://example.com/offer');
    });

    it('returns 410 Gone from the expiry instant onwards, with no Location header', async () => {
      t.clock.advance(HOUR);
      const response = await redirect('flash-sale');
      expect(response.statusCode).toBe(410);
      expect(response.headers.location).toBeUndefined();
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.json()).toMatchObject({ status: 410, code: 'link_expired' });
    });

    it('does not count requests to an expired link as clicks', async () => {
      await redirect('flash-sale');
      t.clock.advance(2 * HOUR);
      await redirect('flash-sale');
      await redirect('flash-sale');
      const stats = (await t.app.inject({ method: 'GET', url: '/api/v1/links/flash-sale/stats' })).json();
      expect(stats.totalClicks).toBe(1);
    });
  });

  describe('after expiry', () => {
    beforeEach(async () => {
      await createLink(t.app, { url: 'https://example.com/offer', alias: 'flash-sale', ttlSeconds: 3600 });
      await redirect('flash-sale');
      t.clock.advance(2 * HOUR);
    });

    it('still returns the link metadata and its stats', async () => {
      const link = await t.app.inject({ method: 'GET', url: '/api/v1/links/flash-sale' });
      expect(link.statusCode).toBe(200);
      expect(link.json().expiresAt).toBe('2026-03-01T13:00:00.000Z');

      const stats = await t.app.inject({ method: 'GET', url: '/api/v1/links/flash-sale/stats' });
      expect(stats.statusCode).toBe(200);
      expect(stats.json().totalClicks).toBe(1);
    });

    it('keeps the alias reserved, so an expired link cannot be taken over', async () => {
      const { status, body } = await createLink(t.app, { url: 'https://attacker.example', alias: 'flash-sale' });
      expect(status).toBe(409);
      expect(body.code).toBe('alias_taken');
    });
  });

  it('leaves links created before the expiry migration working', async () => {
    t.db
      .prepare("INSERT INTO links (code, target_url, created_at) VALUES ('legacy1', 'https://example.com/old', '2025-01-01T00:00:00.000Z')")
      .run();
    const response = await redirect('legacy1');
    expect(response.statusCode).toBe(302);
    const link = (await t.app.inject({ method: 'GET', url: '/api/v1/links/legacy1' })).json();
    expect(link.expiresAt).toBeNull();
  });
});
